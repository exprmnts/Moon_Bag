// Every way a buy can fail, in one place. Pure: no I/O, so test/errors.test.js
// covers it. `classify` turns whatever was thrown into
//
//   { code, retryable, user, alert }
//
//   code      short constant, stored in trades.error_code
//   retryable whether another attempt could plausibly succeed
//   user      one plain sentence for the person who owns the moonbag; it never
//             contains a stack, a selector or an API URL
//   alert     whether a developer should hear about it even on the first failure
//
// The rule of thumb: anything caused by the outside world moving (a router
// timing out, a price changing, an RPC blinking) is retryable. Anything caused
// by the state of the account or by our own configuration is not, because
// retrying it five times just burns four more minutes.
const config = require("./config");

const CODES = {
  NO_WALLET: { retryable: false, alert: false, user: "Your bot wallet is missing. Create one and try again." },
  NOT_MAINNET: { retryable: false, alert: true, user: "Swaps are only live on Robinhood Chain mainnet." },
  CONFIG: { retryable: false, alert: true, user: "The bot is misconfigured. The team has been alerted." },
  FEE_MISMATCH: { retryable: false, alert: true, user: "The quote did not match the expected fee, so nothing was signed." },
  NO_ROUTE: { retryable: false, alert: false, user: "No trading route for this token yet — it may not have graduated to Uniswap." },
  QUOTE_UNAVAILABLE: { retryable: true, alert: false, user: "Uniswap's router did not answer in time." },
  RATE_LIMITED: { retryable: true, alert: false, user: "Uniswap is rate-limiting us." },
  NETWORK: { retryable: true, alert: false, user: "The network did not answer in time." },
  WOULD_REVERT: { retryable: true, alert: false, user: "The swap would have failed at this price, so it was not sent." },
  REVERTED: { retryable: true, alert: false, user: "The swap was sent but reverted on chain." },
  RECEIPT_TIMEOUT: { retryable: true, alert: false, user: "The swap was sent; waiting for it to confirm." },
  INSUFFICIENT_ETH: { retryable: false, alert: false, user: "Your bot wallet does not have enough ETH for this buy plus gas." },
  UNKNOWN: { retryable: true, alert: true, user: "Something went wrong on our side." },
};

// Errors that carry a hash must never be blindly re-sent; the next attempt
// re-checks the hash first (see executor.resumeSentTx).
const KEEPS_HASH = new Set(["RECEIPT_TIMEOUT", "REVERTED"]);

function messageOf(err) {
  if (!err) return "";
  return String(err.shortMessage || err.details || err.message || err);
}

// The HTTP status embedded by services/uniswap.js in "Uniswap /quote 404: …".
function uniswapStatus(text) {
  const m = /^Uniswap \/\w+ (\d{3}):/.exec(text);
  return m ? Number(m[1]) : null;
}

function codeFor(err) {
  const text = messageOf(err);
  const lower = text.toLowerCase();

  if (err && err.code && CODES[err.code]) return err.code;

  if (lower.includes("no wallet") || lower === "no user") return "NO_WALLET";
  if (lower.includes("only exist on robinhood chain mainnet")) return "NOT_MAINNET";
  if (lower.includes("uniswap_api_key") || lower.includes("is not set")) return "CONFIG";
  // fee.splitOutputs fails closed; every one of its messages starts this way.
  if (lower.includes("uniswap quote") && (lower.includes("fee") || lower.includes("principal") || lower.includes("pays"))) {
    return "FEE_MISMATCH";
  }

  const status = uniswapStatus(text);
  if (status === 429) return "RATE_LIMITED";
  if (status != null) {
    // A 404 is Uniswap's answer both to "the router timed out" (retry works,
    // the body says so) and to "this token has no pool" (retrying cannot help).
    const routable = lower.includes("timed out") || lower.includes("may succeed on retry") || lower.includes("dependency");
    if (status >= 500 || routable) return "QUOTE_UNAVAILABLE";
    if (status === 404 || lower.includes("no quotes") || lower.includes("no route") || lower.includes("not supported")) {
      return "NO_ROUTE";
    }
    return "QUOTE_UNAVAILABLE";
  }

  if (lower.includes("insufficient funds") || lower.includes("exceeds the balance") || lower.includes("insufficient_eth")) {
    return "INSUFFICIENT_ETH";
  }
  if (lower.includes("transaction reverted")) return "REVERTED";
  if (lower.includes("waiting for transaction receipt") || lower.includes("timed out while waiting")) return "RECEIPT_TIMEOUT";
  if (lower.includes("execution reverted") || lower.includes("gas required exceeds") || lower.includes("cannot estimate gas")) {
    return "WOULD_REVERT";
  }
  if (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("fetch failed") ||
    lower.includes("socket") ||
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("network") ||
    lower.includes("nonce") ||
    lower.includes("underpriced") ||
    (err && (err.name === "AbortError" || err.name === "TimeoutError"))
  ) {
    return "NETWORK";
  }
  return "UNKNOWN";
}

function classify(err) {
  const code = codeFor(err);
  const spec = CODES[code] || CODES.UNKNOWN;
  return { code, retryable: spec.retryable, user: spec.user, alert: spec.alert, detail: messageOf(err).slice(0, 400) };
}

// An error we raise ourselves with a known code, so classify does not have to
// read it back out of prose.
function tagged(code, detail) {
  const err = new Error(detail || code);
  err.code = code;
  return err;
}

// Delay in ms before attempt `attempts + 1`. Past the end of the table the last
// value repeats, so a long outage settles into a steady two-minute retry.
function backoffMs(attempts, table = config.RETRY_BACKOFF_MS) {
  if (!table.length) return 0;
  const i = Math.max(0, Math.min(attempts - 1, table.length - 1));
  return table[i];
}

const canRetry = (attempts, max = config.MAX_BUY_ATTEMPTS) => attempts < max;

module.exports = { classify, tagged, backoffMs, canRetry, messageOf, CODES, KEEPS_HASH };
