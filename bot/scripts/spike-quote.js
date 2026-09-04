// Phase 0 spike: quote and build a swap for a Pons token on MAINNET via the
// Uniswap Trading API. Nothing is signed or sent. Pass = /swap returns 200.
//   node scripts/spike-quote.js [tokenOut] [swapper]
require("dotenv").config();
const { generatePrivateKey, privateKeyToAccount } = require("viem/accounts");

const API = "https://trade-api.gateway.uniswap.org/v1";
const key = process.env.UNISWAP_API_KEY;
if (!key) throw new Error("UNISWAP_API_KEY missing");

const tokenOut = process.argv[2] || "0x39dBED3a2bd333467115dE45665cC57F813C4571";
const swapper = process.argv[3] || privateKeyToAccount(generatePrivateKey()).address;

async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

(async () => {
  const quoteReq = {
    tokenIn: "0x0000000000000000000000000000000000000000",
    tokenOut,
    tokenInChainId: 4663,
    tokenOutChainId: 4663,
    amount: "1000000000000000", // 0.001 ETH
    type: "EXACT_INPUT",
    swapper,
    slippageTolerance: 1,
    routingPreference: "BEST_PRICE",
  };
  const q = await post("/quote", quoteReq);
  console.log("/quote status", q.status, "routing", q.json.routing);
  if (q.status !== 200) { console.log(JSON.stringify(q.json, null, 2)); process.exit(1); }
  console.log("quote.output.amount", q.json.quote?.output?.amount, "gasFeeUSD", q.json.quote?.gasFeeUSD);

  const s = await post("/swap", { quote: q.json.quote, simulateTransaction: false });
  console.log("/swap status", s.status);
  if (s.status !== 200) { console.log(JSON.stringify(s.json, null, 2)); process.exit(1); }
  const { to, value, chainId, data, gasLimit } = s.json.swap || {};
  console.log({ to, value, chainId, gasLimit, dataBytes: data ? (data.length - 2) / 2 : 0 });
  console.log("PASS: /swap returned 200 (nothing sent)");
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
