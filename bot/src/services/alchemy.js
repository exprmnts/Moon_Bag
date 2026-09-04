// viem clients on Alchemy's Robinhood Chain endpoints, plus the three reads
// the bot needs: ETH balance, ERC-20 balances, token metadata (cached).
const { createPublicClient, createWalletClient, http, webSocket, getAddress, formatUnits } = require("viem");
const config = require("../config");
const db = require("./db");

const ERC20_META_ABI = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
];

let _public;
let _ws;

function publicClient() {
  if (!_public) {
    _public = createPublicClient({
      chain: config.chain,
      transport: http(config.rpcUrl, { timeout: 15_000, retryCount: 2 }),
    });
  }
  return _public;
}

function wsClient() {
  if (!_ws) {
    _ws = createPublicClient({
      chain: config.chain,
      transport: webSocket(config.wssUrl, { reconnect: { attempts: 10, delay: 2_000 }, keepAlive: true }),
    });
  }
  return _ws;
}

// A fresh WebSocket client (used after an error so the old socket is abandoned).
function resetWsClient() {
  _ws = null;
  return wsClient();
}

function walletClient(account) {
  return createWalletClient({
    account,
    chain: config.chain,
    transport: http(config.rpcUrl, { timeout: 30_000 }),
  });
}

async function getEthBalance(address) {
  return publicClient().getBalance({ address: getAddress(address) });
}

// Returns [{ token: lowercased address, amount: bigint }] for every ERC-20 with a
// non-zero balance. Uses alchemy_getTokenBalances (paginated, capped at 3 pages).
async function getTokenBalances(address) {
  const client = publicClient();
  const out = [];
  let pageKey;
  for (let page = 0; page < 3; page++) {
    const params = [getAddress(address), "erc20"];
    if (pageKey) params.push({ pageKey });
    const res = await client.request({ method: "alchemy_getTokenBalances", params });
    for (const t of res.tokenBalances || []) {
      if (t.error || !t.tokenBalance) continue;
      const amount = BigInt(t.tokenBalance);
      if (amount > 0n) out.push({ token: t.contractAddress.toLowerCase(), amount });
    }
    pageKey = res.pageKey;
    if (!pageKey) break;
  }
  return out;
}

const metaCache = new Map(); // address -> { symbol, decimals }

// Symbol and decimals for a token, cached in memory and in the tokens table.
// Falls back to { symbol: null, decimals: null } for tokens that refuse to answer.
async function getTokenMeta(tokenAddress) {
  const address = tokenAddress.toLowerCase();
  if (metaCache.has(address)) return metaCache.get(address);

  const row = await db.one("select symbol, decimals from tokens where address = $1", [address]);
  if (row && row.symbol != null && row.decimals != null) {
    metaCache.set(address, row);
    return row;
  }

  try {
    const client = publicClient();
    const checksummed = getAddress(address);
    const [symbol, decimals] = await Promise.all([
      client.readContract({ address: checksummed, abi: ERC20_META_ABI, functionName: "symbol" }),
      client.readContract({ address: checksummed, abi: ERC20_META_ABI, functionName: "decimals" }),
    ]);
    const meta = { symbol: String(symbol).slice(0, 32), decimals: Number(decimals) };
    await db.query(
      `insert into tokens (address, symbol, decimals) values ($1, $2, $3)
       on conflict (address) do update set symbol = excluded.symbol, decimals = excluded.decimals, updated_at = now()`,
      [address, meta.symbol, meta.decimals]
    );
    metaCache.set(address, meta);
    return meta;
  } catch (err) {
    console.warn(`[alchemy] token metadata failed for ${address}: ${err.shortMessage || err.message}`);
    return { symbol: null, decimals: null };
  }
}

function shortAddress(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// Human amount for display: raw units → decimal string, trimmed.
function formatAmount(amount, decimals) {
  if (decimals == null) return amount.toString();
  const s = formatUnits(amount, decimals);
  const [int, frac = ""] = s.split(".");
  const intFmt = BigInt(int).toLocaleString("en-US");
  const fracTrim = frac.replace(/0+$/, "").slice(0, 6);
  return fracTrim ? `${intFmt}.${fracTrim}` : intFmt;
}

module.exports = {
  publicClient,
  wsClient,
  resetWsClient,
  walletClient,
  getEthBalance,
  getTokenBalances,
  getTokenMeta,
  shortAddress,
  formatAmount,
};
