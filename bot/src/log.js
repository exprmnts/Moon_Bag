// What reaches the console, and at which level.
//
// The rule this exists to enforce: a run where nothing went wrong reads clean.
// A buy that works prints two lines — sent, confirmed — and a minute where
// nothing happened prints nothing at all. Everything that used to print
// unconditionally (every transfer touching a watched wallet, every duplicate
// sell collapsing into one buy, the gas arithmetic behind each swap) is still
// there under LOG_LEVEL=debug, which is when you actually want it.
//
//   debug  every trigger, every skip, the numbers behind a decision
//   info   something changed: booted, buy sent, buy confirmed, watcher started
//   warn   recovered from, or a condition worth a human's eye eventually
//   error  failed
//
// The prefix convention is the one the code already used when every line was a
// bare console.log: log.scope("executor").info("…") prints "[executor] …".
const config = require("./config");

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const threshold = LEVELS[config.logLevel];

// True when a line at this level would be printed. Worth checking before
// building an expensive debug string.
const enabled = (level) => LEVELS[level] >= threshold;

function scope(name) {
  const prefix = `[${name}]`;
  const at = (level, write) => (...args) => {
    if (enabled(level)) write(prefix, ...args);
  };
  return {
    debug: at("debug", console.log),
    info: at("info", console.log),
    warn: at("warn", console.warn),
    error: at("error", console.error),
    enabled,
  };
}

module.exports = { scope, enabled, LEVELS, level: config.logLevel };
