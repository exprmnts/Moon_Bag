// Uniswap Trading API: POST /quote then POST /swap (CLASSIC routing).
// Mainnet only; the API does not know testnet 46630. Both calls throw with
// the API's own error text so the user sees why a buy failed. The 1% fee is
// requested in /quote (integratorFees) and lands in the /swap calldata.
//
// The router behind /quote intermittently answers 404 "A routing dependency
// timed out or failed; the request may succeed on retry" for tokens that quote
// fine a second later, so every call retries its own transient failures before
// giving up. Persistent failures still throw, and executor.js counts those.
const config = require("../config");
const fee = require("../fee");
const log = require("../log").scope("uniswap");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retryable at the HTTP layer: anything 5xx, 429, and the 404s whose body says
// the request may succeed on retry. A plain 404 ("no quotes available") is the
// token having no pool and is not worth a second call.
function transient(status, detail) {
  if (status >= 500 || status === 429 || status === 408) return true;
  const d = String(detail || "").toLowerCase();
  return d.includes("may succeed on retry") || d.includes("timed out") || d.includes("dependency");
}

async function once(path, body) {
  const res = await fetch(`${config.uniswapApiBase}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": config.uniswapApiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.UNISWAP_TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) {
    const detail = json?.detail || json?.errorCode || json?.message || text.slice(0, 200);
    const err = new Error(`Uniswap ${path} ${res.status}: ${detail}`);
    err.status = res.status;
    err.retryable = transient(res.status, detail);
    throw err;
  }
  return json;
}

async function post(path, body) {
  if (!config.uniswapApiKey) throw new Error("UNISWAP_API_KEY is not set");
  let last;
  for (let attempt = 0; attempt <= config.UNISWAP_RETRIES; attempt++) {
    try {
      return await once(path, body);
    } catch (err) {
      last = err;
      // A network-level failure (abort, DNS, socket) carries no status and is
      // always worth one more try.
      const retryable = err.status == null ? true : err.retryable;
      if (!retryable || attempt === config.UNISWAP_RETRIES) break;
      const wait = 700 * (attempt + 1) + Math.floor(Math.random() * 300);
      // The router timing out and recovering is not an incident.
      log.debug(`${path} ${err.message.slice(0, 120)} — retrying in ${wait}ms`);
      await sleep(wait);
    }
  }
  throw last;
}

// Exact-input quote: native ETH in, `tokenOut` out, 1% of the output to the
// treasury when the fee is on. Returns the full quote response; read it with
// fee.splitOutputs before signing anything.
async function quote({ tokenOut, amountWei, swapper }) {
  const body = {
    tokenIn: config.nativeEth,
    tokenOut,
    tokenInChainId: config.chainId,
    tokenOutChainId: config.chainId,
    amount: amountWei.toString(),
    type: "EXACT_INPUT",
    swapper,
    slippageTolerance: config.SLIPPAGE,
    routingPreference: "BEST_PRICE",
  };
  const fees = fee.integratorFees();
  if (fees) body.integratorFees = fees;
  return post("/quote", body);
}

// Builds the transaction for a quote. Returns { to, value, data, chainId, gasLimit }.
async function swap(quoteResponse) {
  const json = await post("/swap", { quote: quoteResponse.quote, simulateTransaction: false });
  if (!json?.swap?.to || !json.swap.data) throw new Error("Uniswap /swap returned no transaction");
  return json.swap;
}

module.exports = { quote, swap, transient };
