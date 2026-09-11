// Telling the developers when something breaks that a user cannot fix.
// Always logs. Also messages ADMIN_CHAT_ID when it is set.
//
// Alerts are deduplicated by key for ALERT_COOLDOWN_MS: one unroutable token
// hit by a busy wallet must not turn into a hundred identical messages.
const config = require("../config");
const log = require("../log").scope("alert");

const ALERT_COOLDOWN_MS = 10 * 60_000;
const recent = new Map(); // key -> { at, suppressed }
let botRef = null;

function use(bot) {
  if (bot) botRef = bot;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Returns { send, suppressed }: whether this alert goes out, and how many of the
// same one were swallowed while the cooldown was running. That count rides along
// on the next alert instead of being printed each time it happens.
function gate(key) {
  if (!key) return { send: true, suppressed: 0 };
  const now = Date.now();
  const prev = recent.get(key);
  if (prev && now - prev.at < ALERT_COOLDOWN_MS) {
    prev.suppressed += 1;
    return { send: false, suppressed: prev.suppressed };
  }
  recent.set(key, { at: now, suppressed: 0 });
  // The map only ever holds one entry per distinct failure; drop stale ones so a
  // long-running process does not accumulate them.
  if (recent.size > 500) {
    for (const [k, v] of recent) if (now - v.at > ALERT_COOLDOWN_MS) recent.delete(k);
  }
  return { send: true, suppressed: prev ? prev.suppressed : 0 };
}

// subject: short line. fields: plain object rendered as "key: value" lines.
// key: dedupe key; pass null to always send.
async function notifyDev(subject, fields = {}, { key = subject, bot = botRef } = {}) {
  // The cooldown covers the log as well as the message: an alert nobody can act
  // on twice is noise, so a repeat is a debug line and a counter, nothing more.
  const { send, suppressed } = gate(key);
  if (!send) {
    log.debug(`${subject} (suppressed, ${suppressed} since the last one)`);
    return false;
  }
  const body = Object.entries({ ...fields, ...(suppressed ? { repeats: `${suppressed} since the last alert` } : {}) })
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${String(v).slice(0, 300)}`)
    .join("\n");
  log.error(`${subject}${body ? `\n${body}` : ""}`);
  if (!config.adminChatId || !bot) return false;
  try {
    await bot.telegram.sendMessage(
      config.adminChatId,
      `🛠 <b>${esc(subject)}</b>\n${body ? `<pre>${esc(body)}</pre>` : ""}`,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
    );
    return true;
  } catch (err) {
    log.error(`could not reach ADMIN_CHAT_ID: ${err.message}`);
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
