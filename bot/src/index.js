// Moonbag bot: Telegraf handlers, boot sequence and the /health endpoint.
const http = require("http");
const { Telegraf, Markup } = require("telegraf");
const { message } = require("telegraf/filters");
const { formatEther } = require("viem");
const config = require("./config");
const db = require("./services/db");
const wallet = require("./wallet");
const watcher = require("./watcher");
const alchemy = require("./services/alchemy");

const bot = new Telegraf(config.telegramToken);

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const html = (extra = {}) => ({ parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra });
const withMenu = (extra = {}) => html({ ...mainKeyboard(), ...extra });

function mainKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🪙 Create Wallet", "CREATE_WALLET")],
    [Markup.button.callback("🏦 Show My Address", "SHOW_ADDRESS")],
    [Markup.button.callback("💰 Wallet Balance", "CHECK_BALANCE")],
    [Markup.button.callback("➕ Add Trading Wallet", "ADD_WATCH_ADDR")],
    [Markup.button.callback("➖ Remove Trading Wallet", "REMOVE_WATCH_ADDR")],
    [Markup.button.callback("💸 Set Buy Amount (ETH)", "SET_BUY_AMOUNT")],
    [Markup.button.callback("📊 Positions", "SHOW_POSITIONS")],
    [Markup.button.callback("👀 Trading Wallets", "SHOW_WATCH")],
    [
      Markup.button.callback("▶️ Enable Moonbags", "START_WATCH"),
      Markup.button.callback("⏹ Disable Moonbags", "STOP_WATCH"),
    ],
    [Markup.button.callback("❓ Help", "HELP")],
    [Markup.button.callback("🔑 Export Key", "EXPORT_KEY")],
  ]);
}

// Answering a callback query can fail when the tap is old; that must not abort the handler.
async function ack(ctx) {
  try { await ctx.answerCbQuery(); } catch { /* ignore */ }
}

const uid = (ctx) => String(ctx.from.id);

const START_TEXT =
  "🌑 <b>MoonBag Bot</b>\n\n🚀 <b>Welcome to the Moonbag Bot!</b>\n\n📊 <b>How it works:</b>\n• I monitor your trading wallets\n• When I detect a sell all\n• I automatically buy your moonbag\n\n💡 <b>Get started:</b>\n1. Create your bot wallet\n2. Add trading wallets to monitor\n3. Set your buy amount in ETH\n4. Set and forget your moonbag\n\n🌕 <i>Never forget to leave a moonbag again!</i>";

const HELP_TEXT =
  "🌑 <b>MoonBag Bot - Help</b>\n\n📚 <b>Commands &amp; Features:</b>\n\n🪙 <b>Create Wallet</b> - Generate a new bot wallet for auto-buying moonbags\n🏦 <b>Show Address</b> - Display your bot wallet address\n💰 <b>Wallet Balance</b> - Check ETH and moonbag balances\n➕ <b>Add Trading Wallet</b> - Monitor your trading wallets for sells\n➖ <b>Remove Trading Wallet</b> - Stop monitoring specific addresses\n💸 <b>Set Buy Amount</b> - Configure ETH amount per moonbag\n📊 <b>Positions</b> - View moonbags\n👀 <b>Trading Wallets</b> - List all trading wallet addresses\n▶️ <b>Enable Moonbags</b> - Begin monitoring and auto-buying\n⏹ <b>Disable Moonbags</b> - Pause monitoring\n🔑 <b>Export Key</b> - Back up your bot wallet's private key\n\n💡 <b>How Moonbag Bot Works:</b>\n• Establish a baseline for each token in monitored wallets\n• When you sell all, I auto-buy your moonbag\n• Uses your configured ETH amount per buy\n• Sends notifications for all actions\n\n⚠️ <b>Important Notes:</b>\n• Keep your bot wallet funded with ETH for gas\n• Each sell detection triggers one moonbag\n• Monitor your bot wallet balance regularly\n\n🚀 <b>Ready to start? Use the buttons below!</b>";

const NO_WALLET_TEXT = "❌ <b>No Wallet Found</b>\n\nPlease create a wallet first using <b>🪙 Create Wallet</b>.";

const FUND_TEXT =
  "💡 <b>Fund it:</b> bridge ETH from Ethereum/Arbitrum/Base (portal.arbitrum.io, Relay) or send from Robinhood Wallet. Use <b>🔑 Export Key</b> to back up your key.";

bot.start(async (ctx) => {
  await wallet.setAwaiting(uid(ctx), null);
  await ctx.reply(START_TEXT, withMenu());
});

bot.help(async (ctx) => ctx.reply(HELP_TEXT, withMenu()));

bot.action("HELP", async (ctx) => {
  await ack(ctx);
  await ctx.reply(HELP_TEXT, withMenu());
});

bot.action("BACK_TO_MAIN", async (ctx) => {
  await ack(ctx);
  await wallet.setAwaiting(uid(ctx), null);
  await ctx.reply("🏠 <b>Main Menu</b>\n\nWhat would you like to do?", withMenu());
});

bot.action("CREATE_WALLET", async (ctx) => {
  await ack(ctx);
  try {
    const { user, created } = await wallet.createUserWalletIfMissing(uid(ctx));
    if (!created) {
      await ctx.reply(
        `ℹ️ <b>You already have a wallet</b>\n\n🏦 <b>Address:</b>\n<code>${user.address}</code>\n\n${FUND_TEXT}`,
        withMenu()
      );
      return;
    }
    await ctx.reply(
      `✅ <b>Wallet Created Successfully!</b>\n\n🏦 <b>Address:</b>\n<code>${user.address}</code>\n\n${FUND_TEXT}\n\n🚀 You're ready to start monitoring!`,
      withMenu()
    );
  } catch (err) {
    console.error("[bot] CREATE_WALLET", err);
    await ctx.reply("❌ <b>Failed to Create Wallet</b>\n\nPlease try again later or contact support.", withMenu());
  }
});

bot.action("SHOW_ADDRESS", async (ctx) => {
  await ack(ctx);
  try {
    const user = await wallet.getUser(uid(ctx));
    if (!user) return ctx.reply(NO_WALLET_TEXT, withMenu());
    await ctx.reply(
      `🏦 <b>Your Moonbag Wallet Address</b>\n\n📍 <b>Address:</b>\n<code>${user.address}</code>\n\n💡 <i>Send ETH to this address to cover gas and auto-buys.</i>`,
      withMenu()
    );
  } catch (err) {
    console.error("[bot] SHOW_ADDRESS", err);
    await ctx.reply("❌ <b>Error</b>\n\nFailed to retrieve your wallet address. Please try again.", withMenu());
  }
});

bot.action("EXPORT_KEY", async (ctx) => {
  await ack(ctx);
  const user = await wallet.getUser(uid(ctx));
  if (!user) return ctx.reply(NO_WALLET_TEXT, withMenu());
  await ctx.reply(
    "🔑 <b>Export Private Key</b>\n\n⚠️ Anyone with this key controls your bot wallet and everything in it. Only export it on a device you trust, and never share it.\n\nShow the key now?",
    html(
      Markup.inlineKeyboard([
        [Markup.button.callback("🔓 Yes, show my private key", "CONFIRM_EXPORT")],
        [Markup.button.callback("🔙 Back to Main Menu", "BACK_TO_MAIN")],
      ])
    )
  );
});

bot.action("CONFIRM_EXPORT", async (ctx) => {
  await ack(ctx);
  try {
    const key = await wallet.exportPrivateKey(uid(ctx));
    await ctx.reply(
      `🔐 <b>Private Key</b>\n\n<code>${key}</code>\n\n⚠️ Save it somewhere safe, then <b>delete this message</b>.`,
      withMenu()
    );
  } catch (err) {
    console.error("[bot] CONFIRM_EXPORT", err);
    await ctx.reply(NO_WALLET_TEXT, withMenu());
  }
});

bot.action("SET_BUY_AMOUNT", async (ctx) => {
  await ack(ctx);
  const user = await wallet.getUser(uid(ctx));
  if (!user) return ctx.reply(NO_WALLET_TEXT, withMenu());
  await wallet.setAwaiting(uid(ctx), "buy_amount");
  await ctx.reply(
    `💰 <b>Set Buy Amount</b>\n\nSend me the ETH amount to spend per moonbag (e.g., 0.005, 0.01, 0.05).\n\nCurrent: <b>${formatEther(user.buyAmountWei)} ETH</b>\n\n<i>This is how much ETH I'll spend on each moonbag!</i>`,
    html()
  );
});

bot.action("ADD_WATCH_ADDR", async (ctx) => {
  await ack(ctx);
  const user = await wallet.getUser(uid(ctx));
  if (!user) return ctx.reply(NO_WALLET_TEXT, withMenu());
  await wallet.setAwaiting(uid(ctx), "add_address");
  await ctx.reply(
    "📥 <b>Add Trading Wallet</b>\n\nSend me the wallet address (0x…) you want me to monitor.\n\n<i>When it sells, I'll buy your moonbag!</i>",
    html()
  );
});

// Free text is only meaningful while the user is being asked for something.
bot.on(message("text"), async (ctx) => {
  const telegramId = uid(ctx);
  const raw = (ctx.message.text || "").trim();
  if (raw.startsWith("/")) return;
  const awaiting = await wallet.getAwaiting(telegramId);
  if (!awaiting) return;

  if (awaiting === "buy_amount") {
    if (!/^(\d+\.?\d*|\.\d+)$/.test(raw) || Number(raw) <= 0) {
      await ctx.reply("❌ <b>Invalid Amount</b>\n\nPlease provide a valid positive number (e.g., 0.005, 0.01, 0.05).", html());
      return;
    }
    let wei;
    try {
      wei = await wallet.setBuyAmount(telegramId, raw);
    } catch (err) {
      await ctx.reply("❌ <b>Invalid Amount</b>\n\nUse at most 18 decimal places.", html());
      return;
    }
    await wallet.setAwaiting(telegramId, null);
    const value = formatEther(wei);
    if (Number(value) > config.HIGH_BUY_WARN_ETH) {
      await ctx.reply(
        `⚠️ <b>High Amount Warning</b>\n\nYou've set a high buy amount (${value} ETH). Please ensure this is correct before proceeding.`,
        html()
      );
    }
    await ctx.reply(
      `✅ <b>Buy Amount Updated!</b>\n\nI'll now spend <b>${value} ETH</b> per moonbag when I detect a sell. 🚀`,
      withMenu()
    );
    return;
  }

  if (awaiting === "add_address") {
    const address = wallet.normalizeAddress(raw);
    if (!address) {
      await ctx.reply("❌ <b>Invalid Address</b>\n\nPlease provide a valid wallet address (0x followed by 40 hex characters).", html());
      return;
    }
    try {
      const { wallet: watched, added } = await wallet.addWatchAddress(telegramId, address);
      if (added) {
        try {
          await watcher.seedPositions(watched);
        } catch (err) {
          await wallet.removeWatchAddress(telegramId, address);
          throw err;
        }
        await watcher.refreshSubscriptions(telegramId);
      }
      await wallet.setAwaiting(telegramId, null);
      await ctx.reply(
        added
          ? `✅ <b>Trading Wallet Added!</b>\n\n<code>${address}</code>\n\nI'm now monitoring this wallet for sells and will buy your moonbag! 🚀`
          : `ℹ️ <b>Already on your list</b>\n\n<code>${address}</code>`,
        withMenu()
      );
    } catch (err) {
      console.error("[bot] add watch address", err);
      await ctx.reply("❌ <b>Failed to add wallet</b>\n\nPlease try again or contact support.", html());
    }
  }
});

bot.action("REMOVE_WATCH_ADDR", async (ctx) => {
  await ack(ctx);
  const list = await wallet.listWatchAddresses(uid(ctx));
  if (!list.length) {
    return ctx.reply("❌ <b>No Trading Wallets</b>\n\nYou don't have any wallets to remove.", withMenu());
  }
  const rows = list.map((w) => [
    Markup.button.callback(`🗑️ ${w.address.slice(0, 8)}...${w.address.slice(-8)}`, `REMOVE_${w.address}`),
  ]);
  rows.push([Markup.button.callback("🔙 Back to Main Menu", "BACK_TO_MAIN")]);
  await ctx.reply(
    "🗑️ <b>Remove Trading Wallet</b>\n\nSelect the wallet you want to remove from monitoring:",
    html(Markup.inlineKeyboard(rows))
  );
});

bot.action(/^REMOVE_(0x[0-9a-fA-F]{40})$/, async (ctx) => {
  await ack(ctx);
  const telegramId = uid(ctx);
  const address = ctx.match[1].toLowerCase();
  try {
    const removed = await wallet.removeWatchAddress(telegramId, address);
    if (removed) await watcher.refreshSubscriptions(telegramId);
    await ctx.reply(
      removed
        ? `✅ <b>Trading Wallet Removed!</b>\n\n<code>${address}</code>\n\nI'm no longer monitoring this wallet for sells.`
        : `ℹ️ <b>Not on your list</b>\n\n<code>${address}</code>`,
      withMenu()
    );
  } catch (err) {
    console.error("[bot] remove watch address", err);
    await ctx.reply("❌ <b>Failed to Remove Wallet</b>\n\nPlease try again or contact support.", withMenu());
  }
});

async function tokenLines(balances, limit, indent) {
  const withMeta = [];
  for (const b of balances) {
    const meta = await alchemy.getTokenMeta(b.token);
    withMeta.push({ ...b, meta, human: meta.decimals == null ? null : Number(b.amount) / 10 ** meta.decimals });
  }
  withMeta.sort((a, b) => (b.human ?? 0) - (a.human ?? 0));
  const shown = withMeta.slice(0, limit);
  const lines = shown.map((t) => {
    const name = t.meta.symbol ? esc(t.meta.symbol) : alchemy.shortAddress(t.token);
    return `${indent}• <b>${name}</b> — <b>${alchemy.formatAmount(t.amount, t.meta.decimals)}</b>\n${indent}  └─ <code>${t.token}</code>`;
  });
  if (withMeta.length > limit) lines.push(`${indent}... and ${withMeta.length - limit} more`);
  return lines.join("\n");
}

bot.action("CHECK_BALANCE", async (ctx) => {
  await ack(ctx);
  try {
    const user = await wallet.getUser(uid(ctx));
    if (!user) return ctx.reply(NO_WALLET_TEXT, withMenu());
    const [eth, tokens] = await Promise.all([alchemy.getEthBalance(user.address), alchemy.getTokenBalances(user.address)]);
    let text = `💰 <b>Wallet Balance</b>\n📍 <b>Address:</b> <code>${user.address}</code>\n\n`;
    text += `🪙 <b>ETH Balance:</b> <b>${Number(formatEther(eth)).toFixed(4)} ETH</b>\n\n`;
    if (tokens.length) {
      text += `🪙 <b>Token Balances:</b>\n━━━━━━━━━━━━━━━━━━━━\n${await tokenLines(tokens, 10, "")}`;
    } else {
      text += "🪙 <b>Token Balances:</b> No moonbags found";
    }
    await ctx.reply(text, withMenu());
  } catch (err) {
    console.error("[bot] CHECK_BALANCE", err);
    await ctx.reply("❌ Failed to retrieve your wallet balance. Please try again.", withMenu());
  }
});

bot.action("SHOW_POSITIONS", async (ctx) => {
  await ack(ctx);
  const telegramId = uid(ctx);
  const user = await wallet.getUser(telegramId);
  if (!user) return ctx.reply(NO_WALLET_TEXT, withMenu());
  const list = await wallet.listWatchAddresses(telegramId);
  if (!list.length) {
    return ctx.reply("👀 <b>No trading wallets configured</b>\n\nAdd your trading wallets to monitor their positions.", withMenu());
  }
  let text = "📊 <b>Moonbag Positions</b>\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n";
  for (let i = 0; i < list.length; i++) {
    const w = list[i];
    text += `📍 <b>Wallet ${i + 1}:</b>\n<code>${w.address}</code>\n`;
    try {
      const tokens = await alchemy.getTokenBalances(w.address);
      text += tokens.length ? `🪙 <b>Tokens:</b>\n${await tokenLines(tokens, 6, "  ")}\n` : "🪙 <b>Tokens:</b> No tokens found\n";
    } catch (err) {
      console.error("[bot] SHOW_POSITIONS", err.message);
      text += "⚠️ Error fetching data\n";
    }
    if (i < list.length - 1) text += "\n";
  }
  await ctx.reply(text, withMenu());
});

bot.action("SHOW_WATCH", async (ctx) => {
  await ack(ctx);
  const telegramId = uid(ctx);
  const list = await wallet.listWatchAddresses(telegramId);
  if (!list.length) {
    return ctx.reply(
      "👀 <b>No Trading Wallets</b>\n\nYou haven't added any trading wallets to monitor yet.\n\nUse <b>➕ Add Trading Wallet</b> to start monitoring.",
      withMenu()
    );
  }
  const active = await wallet.isWatcherEnabled(telegramId);
  let text = "👀 <b>Trading Wallets</b>\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n";
  text += `📡 <b>Moonbags:</b> ${active ? "🟢 <b>Enabled</b>" : "🔴 <b>Disabled</b>"}\n\n`;
  list.forEach((w, i) => { text += `${i + 1}. <code>${w.address}</code>\n`; });
  text += `\n📊 <b>Total:</b> ${list.length} wallet${list.length === 1 ? "" : "s"}`;
  if (!active) text += "\n\n💡 <i>Use <b>▶️ Enable Moonbags</b> to begin monitoring these wallets!</i>";
  await ctx.reply(text, withMenu());
});

bot.action("START_WATCH", async (ctx) => {
  await ack(ctx);
  const telegramId = uid(ctx);
  try {
    await watcher.startWatcher(bot, telegramId);
    await ctx.reply(
      "✅ <b>Moonbags Enabled!</b>\n\n🚀 I'm now monitoring your trading wallets for sells.\n\n📊 When I detect a sell, I'll automatically buy your moonbag.\n\n💡 <i>Make sure your bot wallet has enough ETH for gas!</i>",
      withMenu()
    );
  } catch (err) {
    if (err.message === "WALLET_BALANCE_ZERO") return; // warning already sent by the watcher
    if (err.message === "NO_WALLET") return ctx.reply(NO_WALLET_TEXT, withMenu());
    console.error("[bot] START_WATCH", err);
    await ctx.reply(
      "❌ <b>Failed to Enable Moonbags</b>\n\nPlease ensure you have:\n• A funded wallet with ETH for gas\n• At least one trading wallet configured\n• Valid wallet configuration",
      withMenu()
    );
  }
});

bot.action("STOP_WATCH", async (ctx) => {
  await ack(ctx);
  try {
    await watcher.stopWatcher(uid(ctx));
  } catch (err) {
    console.error("[bot] STOP_WATCH", err);
  }
  await ctx.reply(
    "⏹ <b>Moonbags Disabled</b>\n\nI'm no longer monitoring your trading wallets.\n\nUse <b>▶️ Enable Moonbags</b> to resume.",
    withMenu()
  );
});

bot.catch((err, ctx) => {
  console.error(`[bot] error handling ${ctx.updateType}:`, err);
});

// ---- boot ---------------------------------------------------------------------
function startHttp() {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      const s = watcher.status();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, chain: config.chainName, chainId: config.chainId, dryRun: config.dryRun, ...s }));
      return;
    }
    res.end("Moonbag bot is alive 👍");
  });
  server.listen(config.port, () => console.log(`[http] listening on ${config.port}`));
  return server;
}

async function main() {
  await db.ensureSchema();
  console.log(`[boot] schema ok; chain=${config.chainName} (${config.chainId}) dryRun=${config.dryRun}`);
  const server = startHttp();

  // launch() only resolves when polling stops, so the rest happens in the callback.
  bot
    .launch({ dropPendingUpdates: false }, () => {
      console.log(`[boot] @${bot.botInfo.username} is polling`);
      watcher.resumeWatchers(bot).catch((err) => console.error("[boot] resumeWatchers", err));
    })
    .catch((err) => {
      console.error("[boot] launch failed", err);
      process.exit(1);
    });

  const stop = (signal) => {
    console.log(`[boot] ${signal}, shutting down`);
    try { bot.stop(signal); } catch { /* not launched */ }
    watcher.shutdown();
    server.close();
    db.pool.end().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[boot] fatal", err);
    process.exit(1);
  });
}

module.exports = { bot, mainKeyboard };
