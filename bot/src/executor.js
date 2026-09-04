// buy(): the one action the bot takes on-chain. Every attempt is a row in
// `trades`, keyed by the sell that caused it, so the same sell is never bought
// twice. Never throws: the outcome is returned and the user is messaged.
const { formatEther } = require("viem");
const config = require("./config");
const db = require("./services/db");
const wallet = require("./wallet");
const alchemy = require("./services/alchemy");
const uniswap = require("./services/uniswap");

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

async function tokenLabel(token) {
  const meta = await alchemy.getTokenMeta(token);
  return meta.symbol ? esc(meta.symbol) : alchemy.shortAddress(token);
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

  const label = await tokenLabel(token);

  if (config.dryRun) {
    await setStatus(sellKey, "dry_run");
    await send(bot, telegramId, `🧪 Would buy <b>${label}</b> for ${ethText} ETH (dry run)`);
    return { status: "dry_run" };
  }

  try {
    if (!config.isMainnet) {
      throw new Error("Swaps only exist on Robinhood Chain mainnet; set DRY_RUN=true on testnet");
    }
    const account = await wallet.getAccount(telegramId);
    const q = await uniswap.quote({ tokenOut: token, amountWei: ethIn, swapper: account.address });
    const tx = await uniswap.swap(q);

    const client = alchemy.walletClient(account);
    const hash = await client.sendTransaction({
      to: tx.to,
      value: BigInt(tx.value),
      data: tx.data,
      gas: tx.gasLimit ? BigInt(tx.gasLimit) : undefined,
    });
    console.log(`[executor] ${sellKey} sent ${hash}`);
    await setStatus(sellKey, "pending", { hash });

    const receipt = await alchemy.publicClient().waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`Transaction reverted (${hash})`);

    await setStatus(sellKey, "confirmed", { hash });
    await send(
      bot,
      telegramId,
      `✅ Auto-buy complete! Purchased <b>${label}</b> for ${ethText} ETH.\n<a href="${config.explorerTx}${hash}">View on Blockscout</a>`
    );
    return { status: "confirmed", hash };
  } catch (err) {
    const message = err.shortMessage || err.message || String(err);
    console.error(`[executor] ${sellKey} failed: ${message}`);
    await setStatus(sellKey, "failed", { error: message });
    await send(bot, telegramId, `⚠️ Buy failed: ${esc(message)}`);
    return { status: "failed", error: message };
  }
}

module.exports = { buy };
