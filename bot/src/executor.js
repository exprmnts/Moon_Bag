// buy(): the one action the bot takes on-chain. Every sell becomes exactly one
// row in `trades`, keyed by the sell that caused it, and that row owns the whole
// life of the buy — including its retries. The 1% fee rides inside the swap (see
// fee.js): the router pays 99% of the tokens to the bot wallet and 1% to the
// treasury in the same transaction. Nothing here throws.
//
// The row moves through these statuses:
//
//   queued    inserted, no attempt started yet
//   pending   an attempt is running right now (claimed; nobody else may touch it)
//   retrying  the last attempt failed for a transient reason; next_retry_at is set
//   confirmed the swap is on chain
//   failed    out of attempts, or a reason retrying cannot fix
//   dry_run   DRY_RUN was on
//
// Claiming is a single conditional UPDATE, so the watcher and the retry worker
// can never run two attempts for one sell at the same time.
//
// Two things the user never sees: the retries, and the reason in raw form. They
// get one message that changes as the buy progresses (see `screen`).
const { formatEther } = require("viem");
const config = require("./config");
const db = require("./services/db");
const wallet = require("./wallet");
const alchemy = require("./services/alchemy");
const uniswap = require("./services/uniswap");
const alerts = require("./services/alerts");
const errors = require("./errors");
const ui = require("./ui");
const fee = require("./fee");

const esc = ui.esc;
const ACTIVE = ["queued", "retrying"];

// ---- the row ------------------------------------------------------------------
async function getTrade(sellKey) {
  return db.one("select * from trades where sell_key = $1", [sellKey]);
}

// Inserts the row for a sell. Returns { queued, trade }: queued is false when
// this exact sell is already recorded, which is how the two triggers (WSS event
// and poll) seeing the same balance drop collapse into one buy.
async function queue(telegramId, token, sellKey, ethIn, { chatId = null, statusMsgId = null } = {}) {
  const row = await db.one(
    `insert into trades (sell_key, telegram_id, token, eth_in_wei, status, chat_id, status_msg_id)
     values ($1, $2, $3, $4, 'queued', $5, $6) on conflict (sell_key) do nothing returning *`,
    [sellKey, telegramId, token, ethIn.toString(), chatId == null ? null : String(chatId), statusMsgId]
  );
  if (row) return { queued: true, trade: row };
  return { queued: false, trade: await getTrade(sellKey) };
}

// Takes ownership of a trade for one attempt. Returns the updated row, or null
// if another worker got there first.
async function claim(sellKey, from = ACTIVE) {
  return db.one(
    `update trades set status = 'pending', attempts = attempts + 1, next_retry_at = null, updated_at = now()
     where sell_key = $1 and status = any($2) returning *`,
    [sellKey, from]
  );
}

async function finish(sellKey, status, { hash = null, error = null, code = null } = {}) {
  await db.query(
    `update trades set status = $2, buy_tx_hash = coalesce($3, buy_tx_hash),
       error = $4, error_code = $5, next_retry_at = null, updated_at = now() where sell_key = $1`,
    [sellKey, status, hash, error ? String(error).slice(0, 500) : null, code]
  );
}

async function scheduleRetry(sellKey, delayMs, { hash = null, error = null, code = null } = {}) {
  await db.query(
    `update trades set status = 'retrying', next_retry_at = now() + ($2 || ' milliseconds')::interval,
       buy_tx_hash = $3, error = $4, error_code = $5, updated_at = now() where sell_key = $1`,
    [sellKey, String(Math.max(0, Math.round(delayMs))), hash, error ? String(error).slice(0, 500) : null, code]
  );
}

// Fee columns. Nulls leave the existing value alone.
async function setFee(sellKey, { bips = null, recipient = null, feeAmount = null, tokensOut = null } = {}) {
  await db.query(
    `update trades set fee_bips = coalesce($2, fee_bips), fee_recipient = coalesce($3, fee_recipient),
       fee_amount = coalesce($4, fee_amount), tokens_out = coalesce($5, tokens_out) where sell_key = $1`,
    [sellKey, bips, recipient, feeAmount == null ? null : feeAmount.toString(), tokensOut == null ? null : tokensOut.toString()]
  );
}

// ---- the one message the user watches -------------------------------------------
// Edited in place for the whole life of the buy. Falls back to a new message if
// the old one is gone, and remembers the new id.
async function screen(bot, trade, text) {
  const chatId = trade.chat_id || trade.telegram_id;
  if (!bot || !chatId) return;
  if (trade.status_msg_id && (await ui.edit(bot, chatId, trade.status_msg_id, text))) return;
  const m = await ui.send(bot, chatId, text);
  if (!m) return;
  trade.status_msg_id = m.message_id;
  trade.chat_id = String(chatId);
  await db.query("update trades set chat_id = $2, status_msg_id = $3 where sell_key = $1", [
    trade.sell_key,
    String(chatId),
    m.message_id,
  ]);
}

const head = (label, token) => `<b>${label}</b>\n<code>${token}</code>`;

// The watched wallet that sold, recovered from the sell key
// (`<watched>:<token>:<block>:<before>-<after>`), so a retry an hour later can
// still name the wallet without carrying the watcher's context around.
function sourceOf(sellKey) {
  const first = String(sellKey || "").split(":")[0];
  return /^0x[0-9a-fA-F]{40}$/.test(first) ? alchemy.shortAddress(first) : null;
}

// ---- gas ------------------------------------------------------------------------
// The Trading API's gasLimit has been observed roughly 4× too low on Robinhood
// Chain: tx 0x62f3d87e… burned its entire 259 000 limit and reverted, while the
// same call estimates at ~1.13M. So estimate locally, take the larger of the two
// and add a buffer. A failing estimate means the swap would revert, which is
// worth catching here: it costs nothing, where sending it costs the whole limit.
async function gasFor(publicClient, account, tx) {
  const call = { account: account.address, to: tx.to, data: tx.data, value: BigInt(tx.value || 0) };
  let estimated;
  try {
    estimated = await publicClient.estimateGas(call);
  } catch (err) {
    const cls = errors.classify(err);
    throw errors.tagged(cls.code === "UNKNOWN" ? "WOULD_REVERT" : cls.code, errors.messageOf(err));
  }
  const buffered = (estimated * BigInt(100 + config.GAS_BUFFER_PCT)) / 100n;
  const fromApi = tx.gasLimit ? BigInt(tx.gasLimit) : 0n;
  let gas = buffered > fromApi ? buffered : fromApi;
  if (gas > config.GAS_LIMIT_CAP) gas = config.GAS_LIMIT_CAP;
  return { gas, estimated, fromApi };
}

// Refuses to send a transaction the wallet cannot pay for, with a message that
// says what to do instead of a viem stack trace.
async function assertFunded(publicClient, address, value, gas) {
  const [balance, gasPrice] = await Promise.all([
    publicClient.getBalance({ address }),
    publicClient.getGasPrice().catch(() => 0n),
  ]);
  const needed = value + gas * gasPrice;
  if (balance < needed) {
    throw errors.tagged(
      "INSUFFICIENT_ETH",
      `insufficient funds: wallet holds ${formatEther(balance)} ETH, this buy needs about ${formatEther(needed)} ETH`
    );
  }
}

// ---- one attempt -------------------------------------------------------------------
// Runs a single buy attempt for an already-claimed row. Throws on failure; the
// caller decides between a retry and a final failure.
async function attemptOnce(bot, trade, label, fmt) {
  const telegramId = trade.telegram_id;
  const token = trade.token;
  const ethIn = BigInt(trade.eth_in_wei);
  const ethText = formatEther(ethIn);
  const feeOn = config.feeEnabled;
  const feePct = fee.pct(config.FEE_BIPS);
  const publicClient = alchemy.publicClient();

  const user = await wallet.getUser(telegramId);
  if (!user) throw errors.tagged("NO_WALLET", "no user");
  if (!config.isMainnet) throw errors.tagged("NOT_MAINNET", "Swaps only exist on Robinhood Chain mainnet; set DRY_RUN=true on testnet");

  const account = await wallet.getAccount(telegramId);

  // A hash from a previous attempt means a transaction is already out there.
  // It must be resolved before another one is signed, or a lost receipt would
  // turn into a double buy.
  if (trade.buy_tx_hash) {
    const prior = await publicClient
      .waitForTransactionReceipt({ hash: trade.buy_tx_hash, timeout: 60_000 })
      .catch(() => null);
    if (!prior) throw errors.tagged("RECEIPT_TIMEOUT", `still waiting on ${trade.buy_tx_hash}`);
    if (prior.status === "success") return settle(bot, trade, prior, trade.buy_tx_hash, label, fmt, ethText);
    console.log(`[executor] ${trade.sell_key}: previous tx ${trade.buy_tx_hash} reverted, quoting again`);
    await db.query("update trades set buy_tx_hash = null where sell_key = $1", [trade.sell_key]);
    trade.buy_tx_hash = null;
  }

  const q = await uniswap.quote({ tokenOut: token, amountWei: ethIn, swapper: account.address });
  // Refuses to continue unless the quote pays exactly our fee to our treasury.
  const quoted = fee.splitOutputs(q, { swapper: account.address, tokenOut: token });
  if (feeOn) await setFee(trade.sell_key, { bips: config.FEE_BIPS, recipient: config.treasury });
  await setFee(trade.sell_key, { feeAmount: quoted.feeAmount, tokensOut: quoted.userAmount });

  const tx = await uniswap.swap(q);
  const { gas, estimated, fromApi } = await gasFor(publicClient, account, tx);
  if (fromApi && estimated > fromApi) {
    console.warn(`[executor] ${trade.sell_key}: Uniswap gasLimit ${fromApi} below estimate ${estimated}; sending ${gas}`);
  }
  await assertFunded(publicClient, account.address, BigInt(tx.value || 0), gas);

  const client = alchemy.walletClient(account);
  const hash = await client.sendTransaction({ to: tx.to, value: BigInt(tx.value || 0), data: tx.data, gas });
  console.log(`[executor] ${trade.sell_key} sent ${hash} (gas ${gas})`);
  await db.query("update trades set buy_tx_hash = $2, updated_at = now() where sell_key = $1", [trade.sell_key, hash]);
  trade.buy_tx_hash = hash;
  await screen(bot, trade, `⏳ <b>Buying ${label}</b>\n${head(label, token)}\n\nSpending ${ethText} ETH · waiting for the swap to confirm…`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw errors.tagged("REVERTED", `Transaction reverted (${hash})`);
  return settle(bot, trade, receipt, hash, label, fmt, ethText);
}

// A confirmed receipt: record what actually moved and tell the user.
async function settle(bot, trade, receipt, hash, label, fmt, ethText) {
  const feeOn = config.feeEnabled;
  // What actually moved beats what was quoted; the quoted values already on the
  // row are the fallback when no Transfer log matched.
  const user = await wallet.getUser(trade.telegram_id);
  const moved = fee.amountsFromReceipt(receipt.logs, trade.token, user && user.address, config.treasury);
  const row = await getTrade(trade.sell_key);
  const tokensOut = moved.userAmount ?? (row && row.tokens_out != null ? BigInt(row.tokens_out) : null);
  const feeAmount = moved.feeAmount ?? (row && row.fee_amount != null ? BigInt(row.fee_amount) : null);

  await setFee(trade.sell_key, { feeAmount, tokensOut });
  await finish(trade.sell_key, "confirmed", { hash });
  if (feeOn && feeAmount != null) console.log(`[executor] ${trade.sell_key} fee ${feeAmount} of ${trade.token} → ${config.treasury}`);

  const received = tokensOut != null ? `<b>+${fmt(tokensOut)} ${label}</b>` : `<b>${label}</b>`;
  let text = `🌕 <b>Moonbag secured</b>\n${head(label, trade.token)}\n\n${received}\nSpent ${ethText} ETH`;
  if (feeOn && feeAmount != null) text += `\nFee ${fmt(feeAmount)} ${label} (${fee.pct(config.FEE_BIPS)})`;
  text += `\n\n<a href="${config.explorerTx}${hash}">View on Blockscout ↗</a>`;
  await screen(bot, trade, text);
  return { status: "confirmed", hash };
}

// ---- the attempt, wrapped ------------------------------------------------------------
// Claims the row, runs one attempt, and on failure either schedules the next one
// or gives up and alerts. Returns { status, hash?, code? }; never throws.
async function attempt(bot, sellKey, { from = ACTIVE } = {}) {
  alerts.use(bot);
  const trade = await claim(sellKey, from);
  if (!trade) return { status: "skipped" };

  const meta = await alchemy.getTokenMeta(trade.token).catch(() => ({ symbol: null, decimals: null }));
  const label = meta.symbol ? esc(meta.symbol) : alchemy.shortAddress(trade.token);
  const fmt = (amount) => alchemy.formatAmount(amount, meta.decimals);
  const ethText = formatEther(BigInt(trade.eth_in_wei));
  const soldFrom = sourceOf(trade.sell_key);

  // The first frame of the one message the user watches. Everything after this
  // — retries included — edits this same message.
  if (trade.attempts === 1) {
    await screen(
      bot,
      trade,
      `🚨 <b>Sell detected</b>\n${head(label, trade.token)}\n\n` +
        (soldFrom ? `Sold from <code>${soldFrom}</code>\n` : "") +
        `➡️ Buying your moonbag for ${ethText} ETH…`
    );
  }

  if (config.dryRun) {
    await finish(sellKey, "dry_run");
    const feeNote = config.feeEnabled ? `\nFee would be ${fee.pct(config.FEE_BIPS)} of the tokens.` : "";
    await screen(bot, trade, `🧪 <b>Would buy ${label}</b>\n${head(label, trade.token)}\n\n${ethText} ETH (dry run).${feeNote}`);
    return { status: "dry_run" };
  }

  try {
    return await attemptOnce(bot, trade, label, fmt);
  } catch (err) {
    const cls = errors.classify(err);
    const attempts = trade.attempts; // already incremented by claim()
    const willRetry = cls.retryable && errors.canRetry(attempts);
    console.error(`[executor] ${sellKey} attempt ${attempts}/${config.MAX_BUY_ATTEMPTS} failed [${cls.code}]: ${cls.detail}`);

    // A hash is only kept when the transaction may still be out there; keeping
    // it otherwise would make the next attempt wait on a receipt forever.
    const keepHash = errors.KEEPS_HASH.has(cls.code) ? trade.buy_tx_hash || null : null;

    if (willRetry) {
      const delay = errors.backoffMs(attempts);
      await scheduleRetry(sellKey, delay, { hash: keepHash, error: cls.detail, code: cls.code });
      await screen(
        bot,
        trade,
        `🌘 <b>Buying ${label}…</b>\n${head(label, trade.token)}\n\n${cls.user}\nTrying again (${attempts + 1}/${config.MAX_BUY_ATTEMPTS}) in ${Math.round(delay / 1000)}s.`
      );
      return { status: "retrying", code: cls.code };
    }

    await finish(sellKey, "failed", { hash: keepHash, error: cls.detail, code: cls.code });
    const exhausted = cls.retryable;
    await screen(
      bot,
      trade,
      `🌑 <b>Moonbag missed — ${label}</b>\n${head(label, trade.token)}\n\n${cls.user}` +
        (exhausted ? `\n\nWe tried ${attempts} times and have told the team. Nothing was spent.` : "\n\nNothing was spent.")
    );
    if (cls.alert || exhausted) {
      await alerts.notifyDev(exhausted ? "Buy gave up after all retries" : `Buy failed: ${cls.code}`, {
        sellKey,
        telegramId: trade.telegram_id,
        token: trade.token,
        attempts,
        code: cls.code,
        error: cls.detail,
        tx: trade.buy_tx_hash,
      }, { key: `buy:${cls.code}:${trade.token}` });
    }
    return { status: "failed", code: cls.code, error: cls.detail };
  }
}

// ---- what the watcher calls ------------------------------------------------------------
// Records the sell and runs the first attempt. Returns
// { status, queued, hash?, code? }; `queued` is false when this sell was already
// recorded, which is the signal the watcher uses to stay quiet.
async function buy(bot, telegramId, token, sellKey, { chatId = null, statusMsgId = null } = {}) {
  try {
    const user = await wallet.getUser(telegramId);
    if (!user) return { status: "failed", queued: false, code: "NO_WALLET", error: "no user" };
    const { queued, trade } = await queue(telegramId, token, sellKey, user.buyAmountWei, { chatId, statusMsgId });
    if (!queued) {
      console.log(`[executor] ${sellKey} already recorded (${trade ? trade.status : "gone"}), skipping`);
      return { status: "skipped", queued: false };
    }
    const result = await attempt(bot, sellKey, { from: ["queued"] });
    return { ...result, queued: true };
  } catch (err) {
    // queue()/getUser() failing is a database problem, not a trade outcome.
    alerts.swallow("executor.buy", err, { telegramId, token, sellKey });
    return { status: "failed", queued: false, code: "UNKNOWN", error: errors.messageOf(err) };
  }
}

// ---- the retry queue -------------------------------------------------------------------
// Trades whose next attempt is due, oldest first.
async function due(limit = 10) {
  return db.many(
    `select sell_key from trades where status = 'retrying' and next_retry_at is not null
     and next_retry_at <= now() order by next_retry_at limit $1`,
    [limit]
  );
}

// A trade left 'pending' by a crash or a redeploy. The row is put back in the
// queue; if its transaction did land, the next attempt finds the receipt and
// confirms instead of buying twice.
async function reclaimStranded(olderThanMs = config.STRANDED_AFTER_MS) {
  const { rowCount } = await db.query(
    `update trades set status = 'retrying', next_retry_at = now()
     where status = 'pending' and updated_at < now() - ($1 || ' milliseconds')::interval`,
    [String(olderThanMs)]
  );
  if (rowCount) console.log(`[executor] re-queued ${rowCount} stranded buy(s)`);
  return rowCount;
}

// Which failed buys `/retry` would pick up. `since` is a Postgres interval; the
// default deliberately excludes old history, because every row here is real ETH
// waiting to be spent again.
function failedWhere({ telegramId = null, codes = null, since = "48 hours" } = {}) {
  const conditions = ["status = 'failed'", `created_at > now() - interval '${since.replace(/[^a-z0-9 ]/gi, "")}'`];
  const params = [];
  if (telegramId) { params.push(telegramId); conditions.push(`telegram_id = $${params.length}`); }
  if (codes && codes.length) { params.push(codes); conditions.push(`error_code = any($${params.length})`); }
  return { where: conditions.join(" and "), params };
}

// What a retry would cost, so the user can be asked before any of it is spent.
// Returns { count, ethWei, tokens }.
async function countFailed(opts = {}) {
  const { where, params } = failedWhere(opts);
  const row = await db.one(
    `select count(*)::int n, coalesce(sum(eth_in_wei), 0)::text total, count(distinct token)::int tokens from trades where ${where}`,
    params
  );
  return { count: row.n, ethWei: BigInt(row.total), tokens: row.tokens };
}

// Puts permanently failed buys back in the queue with a fresh attempt budget.
// This is the "we fixed it, try them all again" lever behind `/retry`.
async function requeueFailed(opts = {}) {
  const { where, params } = failedWhere(opts);
  const { rowCount } = await db.query(
    `update trades set status = 'retrying', attempts = 0, next_retry_at = now(), updated_at = now() where ${where}`,
    params
  );
  return rowCount;
}

module.exports = { buy, attempt, due, reclaimStranded, requeueFailed, countFailed, queue, claim, getTrade, gasFor };
