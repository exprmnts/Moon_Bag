// How the bot talks. Everything that builds a keyboard, sends, edits or deletes
// a Telegram message lives here so the handlers stay about what they do.
//
// Three ideas keep the chat readable:
//
//   1. One screen. A button tap edits the message the button was on instead of
//      pushing a new menu, so the chat does not grow a wall of keyboards.
//   2. Nothing temporary sticks around. Confirmations and errors delete
//      themselves; so does the private key, after config.KEY_TTL_MS.
//   3. A question is a force-reply, and answering it removes both the question
//      and the answer, leaving only the result.
//
// Every helper swallows Telegram errors: a message that cannot be edited or
// deleted (too old, already gone, user blocked the bot) must never abort a
// handler.
const { Markup } = require("telegraf");
const config = require("./config");
const alerts = require("./services/alerts");
const log = require("./log").scope("ui");

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const html = (extra = {}) => ({ parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra });

const RULE = "━━━━━━━━━━━━━━━";

// ---- keyboards ------------------------------------------------------------
// Before a wallet exists there is exactly one thing to do, so that is the only
// button. Afterwards Create Wallet is gone and the toggle carries the state:
// a filled green dot when moonbags are on, a hollow one when they are not.
function menu({ hasWallet, watching }) {
  if (!hasWallet) {
    return Markup.inlineKeyboard([
      [Markup.button.callback("🪙  Create my wallet", "CREATE_WALLET")],
      [Markup.button.callback("❓  How it works", "HELP")],
    ]);
  }
  return Markup.inlineKeyboard([
    [
      watching
        ? Markup.button.callback("🟢  Moonbags ON  ·  tap to pause", "STOP_WATCH")
        : Markup.button.callback("⚪️  Moonbags OFF  ·  tap to start", "START_WATCH"),
    ],
    [Markup.button.callback("➕  Add wallet", "ADD_WATCH_ADDR"), Markup.button.callback("➖  Remove", "REMOVE_WATCH_ADDR")],
    [Markup.button.callback("👀  Watching", "SHOW_WATCH"), Markup.button.callback("📊  Positions", "SHOW_POSITIONS")],
    [Markup.button.callback("💰  Balance", "CHECK_BALANCE"), Markup.button.callback("💸  Buy amount", "SET_BUY_AMOUNT")],
    [Markup.button.callback("🏦  Deposit", "SHOW_ADDRESS"), Markup.button.callback("🔑  Export key", "EXPORT_KEY")],
    [Markup.button.callback("❓  Help", "HELP")],
  ]);
}

const backOnly = () => Markup.inlineKeyboard([[Markup.button.callback("🔙  Back", "BACK_TO_MAIN")]]);

// The one-line state banner every screen starts with.
function banner({ hasWallet, watching, watched = 0 }) {
  if (!hasWallet) return "⚪️ <b>No wallet yet</b>";
  if (!watched) return "⚪️ <b>Moonbags off</b> · no wallets watched yet";
  return watching
    ? `🟢 <b>Moonbags on</b> · watching ${watched} wallet${watched === 1 ? "" : "s"}`
    : `⚪️ <b>Moonbags off</b> · ${watched} wallet${watched === 1 ? "" : "s"} ready`;
}

// ---- raw Telegram, never throwing ------------------------------------------
const api = (botOrCtx) => (botOrCtx && botOrCtx.telegram) || botOrCtx;

async function send(botOrCtx, chatId, text, extra = {}) {
  try {
    return await api(botOrCtx).sendMessage(chatId, text, html(extra));
  } catch (err) {
    log.error(`send to ${chatId} failed: ${err.message}`);
    return null;
  }
}

// Telegram's way of saying "there is nowhere to deliver this": the user never
// opened a private chat with the bot (so it may not write first), blocked it,
// deleted their account, or removed it from the group.
const UNREACHABLE =
  /chat not found|bot can.t initiate conversation|bot was blocked|user is deactivated|bot was kicked|not enough rights|chat_id is empty|peer_id_invalid/i;
const unreachable = (err) => UNREACHABLE.test(String((err && err.message) || err));

// Sends to a *user*, resolving which chat that means. Prefer this over send()
// for anything the watcher or the executor generates: telegram_id is only a
// valid chat id for people who have a private chat with the bot.
//
// Silent for a user Telegram has already refused: the refusal stands until they
// come back, so repeating it would be one wasted API call and one log line per
// message, forever. Their buys still run; wallet.rememberChat un-mutes them the
// moment they send anything.
async function toUser(botOrCtx, telegramId, text, extra = {}) {
  const wallet = require("./wallet"); // required here: wallet.js must not depend on ui.js
  const route = await wallet.routeFor(telegramId).catch(() => ({ chatId: String(telegramId), blocked: false }));
  if (route.blocked) return null;
  try {
    return await api(botOrCtx).sendMessage(route.chatId, text, html(extra));
  } catch (err) {
    if (unreachable(err)) await mute(telegramId, route, err);
    else log.error(`send to ${telegramId} (chat ${route.chatId}) failed: ${err.message}`);
    return null;
  }
}

// Records the refusal and tells the team once. Nothing here may throw: a buy
// must not fail because the message about it could not be delivered.
async function mute(telegramId, route, err) {
  const wallet = require("./wallet");
  const first = await wallet.markUnreachable(telegramId, err.message).catch(() => false);
  route.blocked = true;
  if (!first) return; // already known and already reported
  log.warn(`${telegramId} (chat ${route.chatId}) cannot be messaged: ${err.message} — muted until they write`);
  await alerts
    .notifyDev("A user cannot be messaged", {
      telegramId,
      chatId: route.chatId,
      error: err.message,
      impact: "their buys still run and still cost them ETH; they just hear nothing about it",
      fix: "that user sends anything to the bot in the chat they want alerts in — or pauses their watcher",
      note: "muted until then, so this will not repeat",
    }, { key: `unreachable:${telegramId}` })
    .catch(() => {});
}

async function edit(botOrCtx, chatId, messageId, text, extra = {}) {
  try {
    await api(botOrCtx).editMessageText(chatId, messageId, undefined, text, html(extra));
    return true;
  } catch (err) {
    // "message is not modified" means the screen already says this. Anything
    // else means the message is gone or too old; the caller sends a new one.
    if (/not modified/i.test(err.message || "")) return true;
    return false;
  }
}

async function del(botOrCtx, chatId, messageId) {
  if (!chatId || !messageId) return false;
  try {
    await api(botOrCtx).deleteMessage(chatId, Number(messageId));
    return true;
  } catch {
    return false; // already deleted, older than 48h, or never existed
  }
}

// Deletes later without holding the event loop open at shutdown.
function delLater(botOrCtx, chatId, messageId, ms = config.EPHEMERAL_TTL_MS) {
  if (!chatId || !messageId) return null;
  const t = setTimeout(() => { del(botOrCtx, chatId, messageId).catch(() => {}); }, ms);
  if (t.unref) t.unref();
  return t;
}

// A message that removes itself. Used for confirmations and input errors.
async function temp(ctx, text, ms = config.EPHEMERAL_TTL_MS, extra = {}) {
  const m = await send(ctx, ctx.chat.id, text, extra);
  if (m) delLater(ctx, ctx.chat.id, m.message_id, ms);
  return m;
}

// ---- screens ----------------------------------------------------------------
// A tap edits the message the button sits on; anything else sends a new one.
// Either way the user ends up looking at exactly one menu.
async function screen(ctx, text, state, extra = {}) {
  const options = { ...menu(state), ...extra };
  const on = ctx.callbackQuery && ctx.callbackQuery.message;
  if (on && (await edit(ctx, on.chat.id, on.message_id, text, options))) return;
  await send(ctx, ctx.chat.id, text, options);
}

// Answering a callback query can fail when the tap is old; never abort on it.
async function ack(ctx, text) {
  try { await ctx.answerCbQuery(text); } catch { /* stale tap */ }
}

module.exports = { esc, html, menu, backOnly, banner, send, toUser, unreachable, edit, del, delLater, temp, screen, ack, api, RULE };
