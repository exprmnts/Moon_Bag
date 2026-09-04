// Uniswap Trading API: POST /quote then POST /swap (CLASSIC routing).
// Mainnet only; the API does not know testnet 46630. Both calls throw with
// the API's own error text so the user sees why a buy failed.
const config = require("../config");

async function post(path, body) {
  if (!config.uniswapApiKey) throw new Error("UNISWAP_API_KEY is not set");
  const res = await fetch(`${config.uniswapApiBase}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": config.uniswapApiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) {
    const detail = json?.detail || json?.errorCode || json?.message || text.slice(0, 200);
    throw new Error(`Uniswap ${path} ${res.status}: ${detail}`);
  }
  return json;
}

// Exact-input quote: native ETH in, `tokenOut` out. Returns the full quote response.
async function quote({ tokenOut, amountWei, swapper }) {
  return post("/quote", {
    tokenIn: config.nativeEth,
    tokenOut,
    tokenInChainId: config.chainId,
    tokenOutChainId: config.chainId,
    amount: amountWei.toString(),
    type: "EXACT_INPUT",
    swapper,
    slippageTolerance: config.SLIPPAGE,
    routingPreference: "BEST_PRICE",
  });
}

// Builds the transaction for a quote. Returns { to, value, data, chainId, gasLimit }.
async function swap(quoteResponse) {
  const json = await post("/swap", { quote: quoteResponse.quote, simulateTransaction: false });
  if (!json?.swap?.to || !json.swap.data) throw new Error("Uniswap /swap returned no transaction");
  return json.swap;
}

module.exports = { quote, swap };
