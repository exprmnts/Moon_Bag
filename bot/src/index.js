// Moonbag bot: Telegraf handlers, boot sequence and the /health endpoint.
//
// Two rules keep this file readable. Every handler is wrapped in `guard`, so a
// thrown error becomes a short message to the user and an alert to the
// developers rather than a silent dead button. And every screen is built from
// `ui.js`: the menu depends on whether the user has a wallet and whether their
// moonbags are running, so there is never a button that cannot work.
const http = require("http");
const { Telegraf } = require("telegraf");
const { message } = require("telegraf/filters");
const { formatEther } = require("viem");
const config = require("./config");
const db = require("./services/db");
const wallet = require("./wallet");
const watcher = require("./watcher");
const retry = require("./retry");
const alchemy = require("./services/alchemy");
const alerts = require("./services/alerts");
const ui = require("./ui");
const executor = require("./executor");

const fee = require("./fee");

const bot = new Telegraf(config.telegramToken);
const FEE_PCT = fee.pct(config.FEE_BIPS); // "1%"

const esc = ui.esc;
const uid = (ctx) => String(ctx.from.id);
const isAdmin = (ctx) => Boolean(config.adminChatId) && String(ctx.from.id) === String(config.adminChatId);

// ---- copy ---------------------------------------------------------------------
const WELCOME =
  `🌑 <b>MoonBag</b>\n\n` +
  `I watch the wallets you trade from. The moment one of them sells a token, ` +
  `I buy a slice of that token straight back into a wallet only you control — and I never sell it.\n\n` +
  `<b>Three steps</b>\n` +
  `1. Create your bot wallet and send it some ETH\n` +
  `2. Add the wallets you trade from\n` +
  `3. Turn moonbags on\n\n` +
  `<i>${FEE_PCT} of each buy is kept in the token bought. That is the only fee, and nothing is taken when you leave.</i>`;

const HELP =
  `🌑 <b>How MoonBag works</b>\n\n` +
  `<b>The rule</b>\nEvery token in a wallet you watch has a baseline. When the balance drops 5% or more, ` +
  `that is a sell, and I buy your set amount of that token into your bot wallet.\n\n` +
  `<b>The buttons</b>\n` +
  `🟢/⚪️ <b>Toggle</b> — start or pause watching\n` +
  `➕ <b>Add wallet</b> — a wallet you trade from\n` +
  `👀 <b>Watching</b> — the list, and whether it is live\n` +
  `📊 <b>Positions</b> — what those wallets hold now\n` +
  `💰 <b>Balance</b> — your bot wallet's ETH and moonbags\n` +
  `💸 <b>Buy amount</b> — ETH spent per moonbag\n` +
  `🏦 <b>Deposit</b> — where to send ETH\n` +
  `🔑 <b>Export key</b> — the private key, shown once\n\n` +
  `<b>Worth knowing</b>\n` +
  `• Keep ETH in the bot wallet: each buy costs your amount plus gas\n` +
  `• A sell that fails to buy is retried automatically, up to ${config.MAX_BUY_ATTEMPTS} times\n` +
  `• ${FEE_PCT} of the tokens on every buy goes to the treasury. You spend your full ETH amount, the rest of the tokens are yours. Nothing is taken on the way out — the bot never sells\n` +
  `• Only you can move what is in the bot wallet, with Export key`;

const NEED_WALLET = "🪙 <b>You need a wallet first</b>\n\nTap <b>Create my wallet</b> and I will make one only you control.";

const FUND_HINT =
  "Send ETH on Robinhood Chain to this address — bridge from Ethereum, Arbitrum or Base (portal.arbitrum.io, Relay), or send from Robinhood Wallet.";

// ---- state and screens ------------------------------------------------------------
// One read of everything a screen needs to draw itself.
async function stateOf(telegramId) {
  const [user, watching, watched] = await Promise.all([
    wallet.getUser(telegramId),
    wallet.isWatcherEnabled(telegramId),
    wallet.listWatchAddresses(telegramId),
  ]);
  return { user, hasWallet: Boolean(user), watching, watched: watched.length, wallets: watched };
}

// The dashboard: state banner, the numbers, and whatever just happened on top.
async function dashboard(state, note) {
  let text = "🌑 <b>MoonBag</b>\n";
  if (note) text += `\n${note}\n`;
  text += `\n${ui.banner(state)}\n`;
  if (state.hasWallet) {
    const eth = await alchemy.getEthBalance(state.user.address).catch(() => null);
    text += `\n<code>${state.user.address}</code>\n`;
    text += `Balance  <b>${eth == null ? "—" : `${Number(formatEther(eth)).toFixed(4)} ETH`}</b>\n`;
    text += `Per buy  <b>${formatEther(state.user.buyAmountWei)} ETH</b>\n`;
    if (!state.watched) text += `\n<i>Add a wallet you trade from to get started.</i>`;
    else if (!state.watching) text += `\n<i>Tap the toggle to start watching.</i>`;
  } else {
    text += `\n<i>Create a wallet to begin. It takes one tap.</i>`;
  }
  return text;
}

// Draws the dashboard on whichever message the user is looking at.
async function showMain(ctx, note) {
  const state = await stateOf(uid(ctx));
  await ui.screen(ctx, await dashboard(state, note), state);
}

// A fresh dashboard below whatever else is in the chat (after a typed answer).
async function sendMain(ctx, note) {
  const state = await stateOf(uid(ctx));
  await ui.send(ctx, ctx.chat.id, await dashboard(state, note), ui.menu(state));
}

// ---- questions ------------------------------------------------------------------
// Asking replaces any question already on screen, so exactly one is ever open.
// force_reply puts the user straight into the reply box.
async function ask(ctx, key, text, placeholder) {
  const telegramId = uid(ctx);
  const prev = await wallet.getConversation(telegramId);
  if (prev && prev.promptMsgId) await ui.del(ctx, prev.promptChatId || ctx.chat.id, prev.promptMsgId);
  const m = await ui.send(ctx, ctx.chat.id, text, {
    reply_markup: { force_reply: true, input_field_placeholder: placeholder },
  });
  await wallet.setAwaiting(telegramId, key, { chatId: ctx.chat.id, msgId: m && m.message_id });
}

// Answering clears the question and the answer, so only the result is left.
async function closeQuestion(ctx, conv) {
  if (conv && conv.promptMsgId) await ui.del(ctx, conv.promptChatId || ctx.chat.id, conv.promptMsgId);
  await ui.del(ctx, ctx.chat.id, ctx.message && ctx.message.message_id);
  await wallet.setAwaiting(uid(ctx), null);
}

// A rejected answer disappears too, and the question comes back with the reason.
async function reject(ctx, key, reason, question, placeholder) {
  await ui.del(ctx, ctx.chat.id, ctx.message && ctx.message.message_id);
  await ask(ctx, key, `❌ <b>${reason}</b>\n\n${question}`, placeholder);
}

const BUY_AMOUNT_Q = "How much ETH should I spend on each moonbag?\n\n<i>Reply with a number, e.g. 0.005</i>";
const ADDRESS_Q = "Which wallet should I watch?\n\n<i>Reply with its address, starting 0x</i>";

// ---- the guard ------------------------------------------------------------------
// Nothing thrown by a handler reaches Telegraf. The user gets one short message,
// the developers get the stack.
function guard(name, fn) {
  return async (ctx) => {
    try {
      await fn(ctx);
    } catch (err) {
      alerts.swallow(`handler ${name}`, err, { telegramId: ctx.from && ctx.from.id });
      try {
        await ui.temp(ctx, "⚠️ That did not go through. Try again in a moment — the team has been told.");
      } catch { /* the chat itself is unreachable */ }
    }
  };
}

const action = (name, fn) => bot.action(name, guard(String(name), fn));

// ---- commands ---------------------------------------------------------------------
bot.start(
  guard("/start", async (ctx) => {
    await wallet.setAwaiting(uid(ctx), null);
    const state = await stateOf(uid(ctx));
    await ui.send(ctx, ctx.chat.id, state.hasWallet ? await dashboard(state) : WELCOME, ui.menu(state));
  })
);

bot.help(
  guard("/help", async (ctx) => {
    const state = await stateOf(uid(ctx));
    await ui.send(ctx, ctx.chat.id, HELP, ui.menu(state));
  })
);

// "Try my failed buys again." Every row this touches is real ETH about to be
// spent a second time, so it always says what it will cost and waits for a yes.
// `/retry all` is the admin's version, across every user.
const retryScope = (ctx, all) => (all ? {} : { telegramId: uid(ctx) });

bot.command(
  "retry",
  guard("/retry", async (ctx) => {
    const all = isAdmin(ctx) && /\ball\b/i.test(ctx.message.text || "");
    const { count, ethWei, tokens } = await executor.countFailed(retryScope(ctx, all));
    if (!count) return sendMain(ctx, "✅ Nothing is waiting to be retried.");
    await ui.send(
      ctx,
      ctx.chat.id,
      `🔄 <b>Retry failed buys</b>\n\n` +
        `${count} buy${count === 1 ? "" : "s"} across ${tokens} token${tokens === 1 ? "" : "s"}` +
        `${all ? ", for every user" : ""}, from the last 48 hours.\n` +
        `This will spend up to <b>${formatEther(ethWei)} ETH</b>${all ? " from their wallets" : " from your wallet"}.\n\n` +
        `Retry them?`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: `✅  Yes, retry ${count}`, callback_data: all ? "RETRY_GO_ALL" : "RETRY_GO" }],
            [{ text: "✖️  No", callback_data: "BACK_TO_MAIN" }],
          ],
        },
      }
    );
  })
);

for (const [data, all] of [["RETRY_GO", false], ["RETRY_GO_ALL", true]]) {
  action(data, async (ctx) => {
    await ui.ack(ctx, "Re-queueing…");
    if (all && !isAdmin(ctx)) return showMain(ctx, "⛔️ That one is for the team only.");
    const n = await executor.requeueFailed(retryScope(ctx, all));
    await showMain(
      ctx,
      n
        ? `🔄 Re-queued <b>${n}</b> buy${n === 1 ? "" : "s"}. Each one will report back as it lands.`
        : "✅ Nothing left to retry."
    );
    // Not awaited: each attempt is a real swap and the reply must not wait on it.
    if (n) retry.tick(bot).catch((err) => alerts.swallow("/retry tick", err));
  });
}

action("HELP", async (ctx) => {
  await ui.ack(ctx);
  const state = await stateOf(uid(ctx));
  await ui.screen(ctx, HELP, state);
});

action("BACK_TO_MAIN", async (ctx) => {
  await ui.ack(ctx);
  await wallet.setAwaiting(uid(ctx), null);
  await showMain(ctx);
});

// ---- wallet ------------------------------------------------------------------------
action("CREATE_WALLET", async (ctx) => {
  await ui.ack(ctx);
  const { user, created } = await wallet.createUserWalletIfMissing(uid(ctx));
  await showMain(
    ctx,
    created
      ? `✅ <b>Wallet created.</b> Send it some ETH, then add a wallet to watch.\n\n<i>${FUND_HINT}</i>`
      : `ℹ️ You already have a wallet: <code>${user.address}</code>`
  );
});

action("SHOW_ADDRESS", async (ctx) => {
  await ui.ack(ctx);
  const state = await stateOf(uid(ctx));
  if (!state.hasWallet) return ui.screen(ctx, NEED_WALLET, state);
  await ui.screen(ctx, `🏦 <b>Deposit address</b>\n\n<code>${state.user.address}</code>\n\n<i>${FUND_HINT}</i>`, state);
});

action("EXPORT_KEY", async (ctx) => {
  await ui.ack(ctx);
  const state = await stateOf(uid(ctx));
  if (!state.hasWallet) return ui.screen(ctx, NEED_WALLET, state);
  await ui.screen(
    ctx,
    `🔑 <b>Export private key</b>\n\nAnyone holding this key owns everything in your bot wallet. Only do this on a device you trust, and never paste it anywhere.\n\n<i>The key will delete itself from this chat after ${config.KEY_TTL_MS / 1000} seconds.</i>`,
    state,
    { reply_markup: { inline_keyboard: [[{ text: "🔓  Show it once", callback_data: "CONFIRM_EXPORT" }], [{ text: "🔙  Back", callback_data: "BACK_TO_MAIN" }]] } }
  );
});

action("CONFIRM_EXPORT", async (ctx) => {
  await ui.ack(ctx);
  const state = await stateOf(uid(ctx));
  if (!state.hasWallet) return ui.screen(ctx, NEED_WALLET, state);
  const key = await wallet.exportPrivateKey(uid(ctx));
  const seconds = Math.round(config.KEY_TTL_MS / 1000);
  const m = await ui.send(
    ctx,
    ctx.chat.id,
    `🔐 <b>Private key</b>\n\n<code>${key}</code>\n\n⚠️ Save it now. This message deletes itself in ${seconds} seconds.`
  );
  if (m) ui.delLater(ctx, ctx.chat.id, m.message_id, config.KEY_TTL_MS);
  await showMain(ctx, `🔑 Key sent above. It disappears in ${seconds} seconds.`);
});

action("CHECK_BALANCE", async (ctx) => {
  await ui.ack(ctx);
  const state = await stateOf(uid(ctx));
  if (!state.hasWallet) return ui.screen(ctx, NEED_WALLET, state);
  const [eth, tokens] = await Promise.all([
    alchemy.getEthBalance(state.user.address),
    alchemy.getTokenBalances(state.user.address),
  ]);
  let text = `💰 <b>Your bot wallet</b>\n<code>${state.user.address}</code>\n\n`;
  text += `<b>${Number(formatEther(eth)).toFixed(4)} ETH</b>\n\n`;
  text += tokens.length
    ? `<b>Moonbags</b>\n${await tokenLines(tokens, 10)}`
    : "<i>No moonbags yet — they land here after your first sell.</i>";
  await ui.screen(ctx, text, state);
});

// ---- buy amount -----------------------------------------------------------------------
action("SET_BUY_AMOUNT", async (ctx) => {
  await ui.ack(ctx);
  const state = await stateOf(uid(ctx));
  if (!state.hasWallet) return ui.screen(ctx, NEED_WALLET, state);
  await ask(
    ctx,
    "buy_amount",
    `💸 <b>Buy amount</b>\n\nNow: <b>${formatEther(state.user.buyAmountWei)} ETH</b> per moonbag.\n\n${BUY_AMOUNT_Q}`,
    "0.005"
  );
});

// ---- watched wallets --------------------------------------------------------------------
action("ADD_WATCH_ADDR", async (ctx) => {
  await ui.ack(ctx);
  const state = await stateOf(uid(ctx));
  if (!state.hasWallet) return ui.screen(ctx, NEED_WALLET, state);
  await ask(ctx, "add_address", `➕ <b>Add a wallet to watch</b>\n\n${ADDRESS_Q}`, "0x…");
});

action("REMOVE_WATCH_ADDR", async (ctx) => {
  await ui.ack(ctx);
  const state = await stateOf(uid(ctx));
  if (!state.wallets.length) return ui.screen(ctx, "👀 <b>Nothing to remove</b>\n\nYou are not watching any wallets yet.", state);
  const rows = state.wallets.map((w) => [
    { text: `🗑  ${w.address.slice(0, 10)}…${w.address.slice(-8)}`, callback_data: `REMOVE_${w.address}` },
  ]);
  rows.push([{ text: "🔙  Back", callback_data: "BACK_TO_MAIN" }]);
  await ui.screen(ctx, "➖ <b>Stop watching which wallet?</b>", state, { reply_markup: { inline_keyboard: rows } });
});

bot.action(
  /^REMOVE_(0x[0-9a-fA-F]{40})$/,
  guard("REMOVE_<address>", async (ctx) => {
    await ui.ack(ctx);
    const address = ctx.match[1].toLowerCase();
    const removed = await wallet.removeWatchAddress(uid(ctx), address);
    if (removed) await watcher.refreshSubscriptions(uid(ctx));
    await showMain(ctx, removed ? `✅ Stopped watching <code>${address}</code>` : `ℹ️ That wallet was not on your list.`);
  })
);

action("SHOW_WATCH", async (ctx) => {
  await ui.ack(ctx);
  const state = await stateOf(uid(ctx));
  if (!state.wallets.length) {
    return ui.screen(ctx, "👀 <b>No wallets yet</b>\n\nTap <b>Add wallet</b> and paste the address you trade from.", state);
  }
  let text = `👀 <b>Watching</b>\n\n${ui.banner(state)}\n\n`;
  state.wallets.forEach((w, i) => { text += `${i + 1}. <code>${w.address}</code>\n`; });
  if (!state.watching) text += `\n<i>Tap the toggle below to go live.</i>`;
  await ui.screen(ctx, text, state);
});

action("SHOW_POSITIONS", async (ctx) => {
  await ui.ack(ctx);
  const state = await stateOf(uid(ctx));
  if (!state.hasWallet) return ui.screen(ctx, NEED_WALLET, state);
  if (!state.wallets.length) {
    return ui.screen(ctx, "📊 <b>Nothing to show</b>\n\nAdd a wallet you trade from and its holdings appear here.", state);
  }
  let text = "📊 <b>What the wallets you watch hold</b>\n";
  for (const w of state.wallets) {
    text += `\n<code>${w.address}</code>\n`;
    try {
      const tokens = await alchemy.getTokenBalances(w.address);
      text += tokens.length ? `${await tokenLines(tokens, 6)}\n` : "<i>no tokens</i>\n";
    } catch (err) {
      console.error(`[bot] positions ${w.address}: ${err.message}`);
      text += "<i>could not read this wallet just now</i>\n";
    }
  }
  await ui.screen(ctx, text, state);
});

async function tokenLines(balances, limit) {
  const withMeta = [];
  for (const b of balances) {
    const meta = await alchemy.getTokenMeta(b.token);
    withMeta.push({ ...b, meta, human: meta.decimals == null ? null : Number(b.amount) / 10 ** meta.decimals });
  }
  withMeta.sort((a, b) => (b.human ?? 0) - (a.human ?? 0));
  const lines = withMeta
    .slice(0, limit)
    .map((t) => `• <b>${t.meta.symbol ? esc(t.meta.symbol) : alchemy.shortAddress(t.token)}</b> — ${alchemy.formatAmount(t.amount, t.meta.decimals)}`);
  if (withMeta.length > limit) lines.push(`<i>…and ${withMeta.length - limit} more</i>`);
  return lines.join("\n");
}

// ---- the toggle ---------------------------------------------------------------------------
action("START_WATCH", async (ctx) => {
  await ui.ack(ctx, "Starting…");
  try {
    const { watched, lowBalance } = await watcher.startWatcher(bot, uid(ctx));
    let note = `🟢 <b>Moonbags on.</b> Watching ${watched} wallet${watched === 1 ? "" : "s"}.`;
    if (lowBalance) note += `\n⚠️ Your bot wallet holds less than one buy amount — top it up or buys will be skipped.`;
    await showMain(ctx, note);
  } catch (err) {
    const known = {
      NO_WALLET: NEED_WALLET,
      NO_WATCHED: "👀 <b>Add a wallet first</b>\n\nI need at least one wallet to watch before I can buy anything.",
      WALLET_BALANCE_ZERO: "⛽️ <b>Your bot wallet is empty</b>\n\nSend it some ETH for the buys and their gas, then try again.",
    }[err.message];
    if (!known) throw err;
    await showMain(ctx, known);
  }
});

action("STOP_WATCH", async (ctx) => {
  await ui.ack(ctx, "Pausing…");
  await watcher.stopWatcher(uid(ctx));
  await showMain(ctx, "⚪️ <b>Moonbags paused.</b> Nothing is being watched until you turn it back on.");
});

// ---- typed answers ----------------------------------------------------------------------------
// Free text only means something while a question is open.
bot.on(
  message("text"),
  guard("text", async (ctx) => {
    const telegramId = uid(ctx);
    const raw = (ctx.message.text || "").trim();
    if (raw.startsWith("/")) return;

    const conv = await wallet.getConversation(telegramId);
    if (!conv || !conv.awaiting) return sendMain(ctx);

    if (conv.awaiting === "buy_amount") {
      if (!/^(\d+\.?\d*|\.\d+)$/.test(raw) || Number(raw) <= 0) {
        return reject(ctx, "buy_amount", `"${esc(raw.slice(0, 24))}" is not an amount`, BUY_AMOUNT_Q, "0.005");
      }
      let wei;
      try {
        wei = await wallet.setBuyAmount(telegramId, raw);
      } catch {
        return reject(ctx, "buy_amount", "Too many decimal places", BUY_AMOUNT_Q, "0.005");
      }
      await closeQuestion(ctx, conv);
      const value = formatEther(wei);
      let note = `✅ <b>${value} ETH</b> per moonbag from now on.`;
      if (Number(value) > config.HIGH_BUY_WARN_ETH) note += `\n⚠️ That is a large amount — double-check it is what you meant.`;
      return sendMain(ctx, note);
    }

    if (conv.awaiting === "add_address") {
      const address = wallet.normalizeAddress(raw);
      if (!address) return reject(ctx, "add_address", "That is not a wallet address", ADDRESS_Q, "0x…");
      if (config.treasury && address === config.treasury.toLowerCase()) {
        return reject(ctx, "add_address", "That is the MoonBag treasury", ADDRESS_Q, "0x…");
      }
      const user = await wallet.getUser(telegramId);
      if (user && address === user.address.toLowerCase()) {
        return reject(
          ctx,
          "add_address",
          "That is your own bot wallet",
          `Watch the wallet you <i>trade</i> from, not the one I buy into.\n\n${ADDRESS_Q}`,
          "0x…"
        );
      }

      const { wallet: watched, added } = await wallet.addWatchAddress(telegramId, address);
      if (added) {
        try {
          await watcher.seedPositions(watched);
        } catch (err) {
          // Without baselines every holding would read as a fresh buy, so the
          // wallet comes back off the list rather than watching it wrongly.
          await wallet.removeWatchAddress(telegramId, address);
          throw err;
        }
        await watcher.refreshSubscriptions(telegramId);
      }
      await closeQuestion(ctx, conv);
      return sendMain(
        ctx,
        added ? `✅ Watching <code>${address}</code>` : `ℹ️ Already watching <code>${address}</code>`
      );
    }

    // An unknown value in the slot: clear it rather than stranding the user.
    await wallet.setAwaiting(telegramId, null);
    return sendMain(ctx);
  })
);

bot.catch((err, ctx) => {
  alerts.swallow(`telegraf ${ctx && ctx.updateType}`, err, { telegramId: ctx && ctx.from && ctx.from.id });
});

// ---- boot ---------------------------------------------------------------------
// The treasury receives a token transfer on every buy. If it is also a watched
// trading wallet, those transfers read as "Buy detected" and raise that wallet's
// baselines, so say so loudly instead of letting fee income look like trading.
async function warnIfTreasuryWatched() {
  if (!config.feeEnabled) return;
  try {
    const rows = await db.many("select telegram_id from watched_wallets where lower(address) = lower($1)", [config.treasury]);
    if (rows.length) {
      await alerts.notifyDev("The treasury is also a watched trading wallet", {
        treasury: config.treasury,
        telegramIds: rows.map((r) => r.telegram_id).join(", "),
        effect: "every fee payment reads as a buy and moves that wallet's baselines",
      });
    }
  } catch (err) {
    console.warn(`[boot] treasury check skipped: ${err.message}`);
  }
}

function startHttp() {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          chain: config.chainName,
          chainId: config.chainId,
          dryRun: config.dryRun,
          feeBips: config.feeEnabled ? config.FEE_BIPS : 0,
          treasury: config.treasury,
          maxBuyAttempts: config.MAX_BUY_ATTEMPTS,
          alerts: Boolean(config.adminChatId),
          ...watcher.status(),
          ...retry.status(),
        })
      );
      return;
    }
    res.end("Moonbag bot is alive 👍");
  });
  server.listen(config.port, () => console.log(`[http] listening on ${config.port}`));
  return server;
}

async function main() {
  await db.ensureSchema();
  console.log(`[boot] schema ok; chain=${config.chainName} (${config.chainId}) dryRun=${config.dryRun} fee=${config.feeEnabled ? `${config.FEE_BIPS}bps→${config.treasury}` : "off"}`);
  alerts.use(bot);
  await warnIfTreasuryWatched();
  if (!config.adminChatId) console.warn("[boot] ADMIN_CHAT_ID is not set: failures will only reach the logs");
  const server = startHttp();

  // launch() only resolves when polling stops, so the rest happens in the callback.
  bot
    .launch({ dropPendingUpdates: false }, () => {
      console.log(`[boot] @${bot.botInfo.username} is polling`);
      bot.telegram
        .setMyCommands([
          { command: "start", description: "Your moonbag dashboard" },
          { command: "help", description: "How MoonBag works" },
          { command: "retry", description: "Try my failed buys again" },
        ])
        .catch((err) => console.warn(`[boot] setMyCommands: ${err.message}`));
      retry.start(bot);
      watcher.resumeWatchers(bot).catch((err) => alerts.swallow("boot.resumeWatchers", err));
    })
    .catch((err) => {
      console.error("[boot] launch failed", err);
      process.exit(1);
    });

  const stop = (signal) => {
    console.log(`[boot] ${signal}, shutting down`);
    try { bot.stop(signal); } catch { /* not launched */ }
    watcher.shutdown();
    retry.stop();
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

module.exports = { bot, stateOf };
