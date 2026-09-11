// The background half of a buy. Every config.RETRY_TICK_MS it runs whatever
// attempts have come due, so a buy that lost to a router timeout finishes on its
// own instead of needing the user to do anything.
//
// It is deliberately thin: executor.attempt claims each row with a conditional
// UPDATE, so this worker running at the same moment as a watcher check is safe,
// and a tick that overruns the interval cannot double up (the `running` flag).
const config = require("./config");
const executor = require("./executor");
const alerts = require("./services/alerts");
const log = require("./log").scope("retry");

let timer = null;
let running = false;
let botRef = null;
const stats = { ticks: 0, attempts: 0, lastTickAt: null };

// One pass. Returns how many attempts it ran. Exported for tests and the smoke
// script, which call it directly rather than waiting for the interval.
async function tick(bot = botRef) {
  if (running) return 0;
  running = true;
  let ran = 0;
  try {
    const rows = await executor.due();
    for (const row of rows) {
      try {
        await executor.attempt(bot, row.sell_key, { from: ["retrying"] });
        ran++;
      } catch (err) {
        // executor.attempt is supposed to swallow everything; if it did not,
        // one bad row must not stop the rest of the queue.
        alerts.swallow("retry.tick", err, { sellKey: row.sell_key });
      }
    }
    stats.ticks++;
    stats.attempts += ran;
    stats.lastTickAt = new Date().toISOString();
  } catch (err) {
    alerts.swallow("retry.tick", err);
  } finally {
    running = false;
  }
  return ran;
}

function start(bot) {
  botRef = bot;
  alerts.use(bot);
  // Buys interrupted by a restart go back in the queue before the first tick.
  executor.reclaimStranded().catch((err) => alerts.swallow("retry.reclaimStranded", err));
  if (timer) return;
  timer = setInterval(() => { tick().catch(() => {}); }, config.RETRY_TICK_MS);
  if (timer.unref) timer.unref();
  log.info(`worker every ${config.RETRY_TICK_MS / 1000}s, up to ${config.MAX_BUY_ATTEMPTS} attempts per buy`);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

const status = () => ({ retryTicks: stats.ticks, retryAttempts: stats.attempts, lastRetryTickAt: stats.lastTickAt });

module.exports = { start, stop, tick, status };
