// buy(): the one action the bot takes on-chain. Every attempt is a row in
// `trades`, keyed by the sell that caused it, so the same sell is never bought
// twice. The 1% fee rides inside the swap (see fee.js): the router pays 99% of
// the tokens to the bot wallet and 1% to the treasury in the same transaction.
// Never throws: the outcome is returned and the user is messaged.
const { formatEther } = require("viem");
const config = require("./config");
const db = require("./services/db");
const wallet = require("./wallet");
const alchemy = require("./services/alchemy");
const uniswap = require("./services/uniswap");
const fee = require("./fee");

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function send(bot, telegramId, text) {
  try {
    await bot.telegram.sendMessage(telegramId, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  } catch (err) {
    console.error(`[executor] sendMessage to ${telegramId} failed: ${err.message}`);
  }
}

async function setStatus(sellKey, status, { hash = null, error = null } = {}) {
  await db.query(
    "update trades set status = $2, buy_tx_hash = coalesce($3, buy_tx_hash), error = $4 where sell_key = $1",
    [sellKey, status, hash, error ? String(error).slice(0, 500) : null]
  );
}

// Fee columns on the trade row. Nulls leave the existing value alone.
async function setFee(sellKey, { bips = null, recipient = null, feeAmount = null, tokensOut = null } = {}) {
  await db.query(
    `update trades set fee_bips = coalesce($2, fee_bips), fee_recipient = coalesce($3, fee_recipient),
       fee_amount = coalesce($4, fee_amount), tokens_out = coalesce($5, tokens_out) where sell_key = $1`,
    [sellKey, bips, recipient, feeAmount == null ? null : feeAmount.toString(), tokensOut == null ? null : tokensOut.toString()]
  );
}

// ---- gas ------------------------------------------------------------------------
// The Trading API's gasLimit has been observed roughly 4x too low on Robinhood
// Chain: tx 0x62f3d87e… burned its entire 259 000 limit and reverted, while the
// same call estimates at ~1.13M. So estimate locally, take the larger of the two
// and add a buffer. A failing estimate means the swap would revert, which is
// worth catching here: it costs nothing, where sending it costs the whole limit.
async function gasFor(publicClient, account, tx) {
  const call = { account: account.address, to: tx.to, data: tx.data, value: BigInt(tx.value || 0) };
  const estimated = await publicClient.estimateGas(call);
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
    throw new Error(
      `insufficient funds: wallet holds ${formatEther(balance)} ETH, this buy needs about ${formatEther(needed)} ETH`
    );
  }
}
// Returns { status: 'skipped' | 'dry_run' | 'confirmed' | 'failed', hash?, error? }
async function buy(bot, telegramId, token, sellKey) {
  const user = await wallet.getUser(telegramId);
  if (!user) return { status: "failed", error: "no user" };
  const ethIn = user.buyAmountWei;
  const ethText = formatEther(ethIn);

  // A buy for this token that is still in flight (sent, receipt not yet seen,
  // or the process died mid-way) counts as handling this sell too.
  const inFlight = await db.one(
    `select sell_key from trades where telegram_id = $1 and token = $2 and status = 'pending'
     and created_at > now() - interval '3 minutes' limit 1`,
    [telegramId, token]
  );
  if (inFlight) {
    console.log(`[executor] ${sellKey}: buy ${inFlight.sell_key} still in flight, skipping`);
    return { status: "skipped" };
  }

  const inserted = await db.one(
    `insert into trades (sell_key, telegram_id, token, eth_in_wei, status)
     values ($1, $2, $3, $4, 'pending') on conflict (sell_key) do nothing returning sell_key`,
    [sellKey, telegramId, token, ethIn.toString()]
  );
  if (!inserted) {
    console.log(`[executor] ${sellKey} already handled, skipping`);
    return { status: "skipped" };
  }

  const meta = await alchemy.getTokenMeta(token);
  const label = meta.symbol ? esc(meta.symbol) : alchemy.shortAddress(token);
  const fmt = (amount) => alchemy.formatAmount(amount, meta.decimals);
  const feeOn = config.feeEnabled;
  const feePct = fee.pct(config.FEE_BIPS);
  if (feeOn) await setFee(sellKey, { bips: config.FEE_BIPS, recipient: config.treasury });

  if (config.dryRun) {
    await setStatus(sellKey, "dry_run");
    const feeNote = feeOn ? ` ${feePct} of the tokens would go to the Moonbag treasury.` : "";
    await send(bot, telegramId, `🧪 Would buy <b>${label}</b> for ${ethText} ETH (dry run).${feeNote}`);
    return { status: "dry_run" };
  }

  try {
    if (!config.isMainnet) {
      throw new Error("Swaps only exist on Robinhood Chain mainnet; set DRY_RUN=true on testnet");
    }
    const account = await wallet.getAccount(telegramId);
    const q = await uniswap.quote({ tokenOut: token, amountWei: ethIn, swapper: account.address });
    // Refuses to continue unless the quote pays exactly our fee to our treasury.
    const quoted = fee.splitOutputs(q, { swapper: account.address, tokenOut: token });
    await setFee(sellKey, { feeAmount: quoted.feeAmount, tokensOut: quoted.userAmount });
    const tx = await uniswap.swap(q);

    const publicClient = alchemy.publicClient();
    const { gas, estimated, fromApi } = await gasFor(publicClient, account, tx);
    if (fromApi && estimated > fromApi) {
      console.warn(`[executor] ${sellKey}: Uniswap gasLimit ${fromApi} below estimate ${estimated}; sending ${gas}`);
    }
    await assertFunded(publicClient, account.address, BigInt(tx.value || 0), gas);

    const client = alchemy.walletClient(account);
    const hash = await client.sendTransaction({ to: tx.to, value: BigInt(tx.value || 0), data: tx.data, gas });
    console.log(`[executor] ${sellKey} sent ${hash}`);
    await setStatus(sellKey, "pending", { hash });

    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`Transaction reverted (${hash})`);

    // What actually moved beats what was quoted.
    const actual = fee.amountsFromReceipt(receipt.logs, token, account.address, config.treasury);
    const tokensOut = actual.userAmount ?? quoted.userAmount;
    const feeAmount = actual.feeAmount ?? quoted.feeAmount;
    await setFee(sellKey, { feeAmount, tokensOut });
    await setStatus(sellKey, "confirmed", { hash });
    if (feeOn) console.log(`[executor] ${sellKey} fee ${feeAmount} of ${token} → ${config.treasury}`);

    const received = tokensOut != null ? `You received <b>${fmt(tokensOut)} ${label}</b>` : `Purchased <b>${label}</b>`;
    let text = `✅ Auto-buy complete! ${received} for ${ethText} ETH.`;
    if (feeOn && feeAmount != null) text += `\nMoonbag fee: ${fmt(feeAmount)} ${label} (${feePct})`;
    text += `\n<a href="${config.explorerTx}${hash}">View on Blockscout</a>`;
    await send(bot, telegramId, text);
    return { status: "confirmed", hash };
  } catch (err) {
    const message = err.shortMessage || err.message || String(err);
    console.error(`[executor] ${sellKey} failed: ${message}`);
    await setStatus(sellKey, "failed", { error: message });
    await send(bot, telegramId, `⚠️ Buy failed: ${esc(message)}`);
    return { status: "failed", error: message };
  }
}

module.exports = { buy, gasFor };
