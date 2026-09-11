// Trigger one real buy for one real user, by hand.
//
//   node scripts/buy-now.js <telegram_id> <token> [--yes]
//
// Without --yes it prints exactly what it would do and stops. With --yes it
// spends that user's configured buy amount of their ETH, for real, and the
// messages land in their actual Telegram chat.
//
// It is the whole production path: the trades row, the Uniswap quote, the fee
// check, executor.gasFor, the send, the receipt, and the one status message
// edited in place as the buy progresses. The only thing it skips is the watcher
// deciding a sell happened — the sell key is supplied here instead.
//
// It never calls bot.launch(), so it starts no long-polling and cannot conflict
// with the bot running elsewhere.
const { formatEther } = require("viem");
const config = require("../src/config");
const db = require("../src/services/db");
const wallet = require("../src/wallet");
const alchemy = require("../src/services/alchemy");
const executor = require("../src/executor");
const { bot } = require("../src/index"); // constructed, never launched

const [, , USER, TOKEN, ...flags] = process.argv;
const GO = flags.includes("--yes");

function die(msg) {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}

(async () => {
  if (!USER || !TOKEN) die("usage: node scripts/buy-now.js <telegram_id> <token> [--yes]");
  if (!/^0x[0-9a-fA-F]{40}$/.test(TOKEN)) die(`"${TOKEN}" is not a token address`);

  await db.ensureSchema();
  const user = await wallet.getUser(USER);
  if (!user) die(`no user ${USER} in ${new URL(config.databaseUrl).host}`);

  const route = await wallet.routeFor(USER);
  const pc = alchemy.publicClient();
  const [meta, eth, gasPrice, block] = await Promise.all([
    alchemy.getTokenMeta(TOKEN),
    pc.getBalance({ address: user.address }),
    pc.getGasPrice(),
    pc.getBlockNumber(),
  ]);
  const needed = user.buyAmountWei + 1_500_000n * gasPrice;

  console.log("=".repeat(68));
  console.log(`user       ${USER}  →  chat ${route.chatId}${route.blocked ? "   ⚠️  MUTED" : ""}`);
  console.log(`bot wallet ${user.address}`);
  console.log(`balance    ${formatEther(eth)} ETH`);
  console.log(`buying     ${formatEther(user.buyAmountWei)} ETH of ${meta.symbol || TOKEN}`);
  console.log(`needs      ~${formatEther(needed)} ETH including gas at ${gasPrice} wei`);
  console.log(`chain      ${config.chainName} (${config.chainId})   dryRun=${config.dryRun}`);
  console.log(`fee        ${config.FEE_BIPS} bips → ${config.treasury}`);
  console.log(`database   ${new URL(config.databaseUrl).host}`);
  console.log("=".repeat(68));

  if (config.dryRun) die("DRY_RUN=true in .env — no swap would be sent. Set DRY_RUN=false to do this for real.");
  if (!config.isMainnet) die(`CHAIN=${config.chainName} — Uniswap only exists on mainnet 4663.`);
  if (route.blocked) die("this user is muted: Telegram refuses to deliver to them. They must message the bot first.");
  if (eth < needed) die(`not enough ETH: holds ${formatEther(eth)}, needs about ${formatEther(needed)}.`);
  if (!GO) {
    console.log("\nThis would spend real ETH. Re-run with --yes to do it.");
    await db.pool.end();
    process.exit(0);
  }

  const before = (await alchemy.getTokenBalances(user.address)).find((t) => t.token === TOKEN);
  const sellKey = `${USER}:manual:${TOKEN}:${block}:buy-now-${Date.now()}`;
  console.log(`\nsell key   ${sellKey}\n--- logs ---`);

  const result = await executor.buy(bot, USER, TOKEN, sellKey);

  const row = await executor.getTrade(sellKey);
  const after = (await alchemy.getTokenBalances(user.address)).find((t) => t.token === TOKEN);
  const menu = await wallet.getMenuMessage(USER);
  const gained = (after ? after.amount : 0n) - (before ? before.amount : 0n);

  console.log("\n--- result ---");
  console.log(`status     ${result.status}${result.code ? ` [${result.code}]` : ""}, attempt ${row.attempts}/${config.MAX_BUY_ATTEMPTS}`);
  if (row.error) console.log(`error      ${row.error}`);
  console.log(`tx         ${row.buy_tx_hash ? config.explorerTx + row.buy_tx_hash : "—"}`);
  console.log(`tokens     +${alchemy.formatAmount(gained, meta.decimals)} ${meta.symbol || ""}`);
  console.log(`fee        ${row.fee_amount ? alchemy.formatAmount(BigInt(row.fee_amount), meta.decimals) : "—"} to the treasury`);
  console.log(`status msg ${row.status_msg_id} in chat ${row.chat_id}  ← newest, should be at the bottom`);
  console.log(`panel      msg ${menu && menu.msgId}  ← stays put; it moves down when the user next taps it`);
  console.log(`\nto undo the bookkeeping:  delete from trades where sell_key = '${sellKey}';`);

  await db.pool.end();
  process.exit(0);
})().catch(async (err) => {
  console.error("\n✖ failed:", err.message);
  try { await db.pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
