// Telling the developers when something breaks that a user cannot fix.
// Always logs. Also messages ADMIN_CHAT_ID when it is set.
//
// Alerts are deduplicated by key for ALERT_COOLDOWN_MS: one unroutable token
// hit by a busy wallet must not turn into a hundred identical messages.
const config = require("../config");

const ALERT_COOLDOWN_MS = 10 * 60_000;
const lastSent = new Map(); // key -> timestamp
let botRef = null;

function use(bot) {
  if (bot) botRef = bot;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function shouldSend(key) {
  if (!key) return true;
  const now = Date.now();
  const prev = lastSent.get(key);
  if (prev && now - prev < ALERT_COOLDOWN_MS) return false;
  lastSent.set(key, now);
  // The map only ever holds one entry per distinct failure; drop stale ones so a
  // long-running process does not accumulate them.
  if (lastSent.size > 500) {
    for (const [k, t] of lastSent) if (now - t > ALERT_COOLDOWN_MS) lastSent.delete(k);
  }
  return true;
}

// subject: short line. fields: plain object rendered as "key: value" lines.
// key: dedupe key; pass null to always send.
async function notifyDev(subject, fields = {}, { key = subject, bot = botRef } = {}) {
  // The cooldown covers the log as well as the message. One unreachable user
  // hitting three sends per sell used to print the whole block three times.
  if (!shouldSend(key)) {
    console.warn(`[alert] ${subject} (repeat suppressed)`);
    return false;
  }
  const body = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${String(v).slice(0, 300)}`)
    .join("\n");
  console.error(`[alert] ${subject}${body ? `\n${body}` : ""}`);
  if (!config.adminChatId || !bot) return false;
  try {
    await bot.telegram.sendMessage(
      config.adminChatId,
      `🛠 <b>${esc(subject)}</b>\n${body ? `<pre>${esc(body)}</pre>` : ""}`,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
    );
    return true;
  } catch (err) {
    console.error(`[alert] could not reach ADMIN_CHAT_ID: ${err.message}`);
    return false;
  }
}

// For the top of a handler: log, alert, and never rethrow.
function swallow(where, err, fields = {}) {
  notifyDev(`Unhandled error in ${where}`, { error: err && (err.stack || err.message), ...fields }, { key: `unhandled:${where}` }).catch(
    () => {}
  );
}

module.exports = { use, notifyDev, swallow, ALERT_COOLDOWN_MS };
