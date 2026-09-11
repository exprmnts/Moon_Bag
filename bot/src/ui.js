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
    console.error(`[ui] send to ${chatId} failed: ${err.message}`);
    return null;
  }
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

module.exports = { esc, html, menu, backOnly, banner, send, edit, del, delLater, temp, screen, ack, api, RULE };
