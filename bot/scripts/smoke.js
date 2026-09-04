// Phase 3 smoke: run one checkAddress pass for a Telegram user and print the
// decisions. Messages the bot would send are printed, not sent.
//   node scripts/smoke.js <telegram_id>
const wallet = require("../src/wallet");
const watcher = require("../src/watcher");
const db = require("../src/services/db");
const config = require("../src/config");

const telegramId = process.argv[2];
if (!telegramId) { console.error("usage: node scripts/smoke.js <telegram_id>"); process.exit(2); }

const fakeBot = {
  telegram: {
    sendMessage: async (id, text) => console.log(`[message → ${id}]\n${text.replace(/<[^>]+>/g, "")}\n`),
  },
};

(async () => {
  console.log(`[smoke] ${config.chainName} (chain ${config.chainId}), DRY_RUN=${config.dryRun}`);
  const user = await wallet.getUser(telegramId);
  if (!user) throw new Error(`no user ${telegramId}`);
  const wallets = await wallet.listWatchAddresses(telegramId);
  if (!wallets.length) console.log("[smoke] no watched wallets");
  for (const w of wallets) {
    const decisions = await watcher.checkAddress(fakeBot, telegramId, w);
    console.log(`[smoke] ${w.address}: ${decisions.length} token(s)`);
    for (const d of decisions) {
      console.log(`  ${d.kind.padEnd(4)} ${d.token} baseline=${d.baseline ?? "-"} current=${d.current}` +
        (d.kind === "sell" ? ` drop=${(d.dropPct * 100).toFixed(2)}% buy=${d.buy}` : ""));
    }
  }
  await db.pool.end();
})().catch((e) => { console.error("[smoke] FAIL", e.message); process.exit(1); });
