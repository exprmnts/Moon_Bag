const axios = require("axios");
const https = require("https");

const MORALIS_API_BASE = "https://solana-gateway.moralis.io";

// Re-use TLS sockets for many rapid calls
const httpsAgent = new https.Agent({ keepAlive: true });

async function fetchWithRetry(url, options = {}, retries = 3) {
  try {
    return await axios.get(url, { httpsAgent, timeout: 10_000, ...options });
  } catch (err) {
    if (retries > 0 && shouldRetry(err)) {
      await new Promise((r) => setTimeout(r, 500));
      return fetchWithRetry(url, options, retries - 1);
    }
    throw err;
  }
}

function shouldRetry(err) {
  if (!err || !err.response) return true;
  const status = err.response.status;
  return status === 429 || status >= 500;
}

function getApiKey() {
  const apiKey = process.env.MORALIS_API_KEY;
  if (!apiKey) throw new Error("Missing MORALIS_API_KEY");
  return apiKey;
}

const SOLANA_NETWORK = process.env.SOLANA_NETWORK || "mainnet";

async function getSplTokenBalances(address) {
  console.log(`[Moralis] Fetching SPL token balances for ${address}`);
  const url = `${MORALIS_API_BASE}/account/${SOLANA_NETWORK}/${address}/tokens`;
  const { data } = await fetchWithRetry(url, {
    headers: { "X-API-Key": getApiKey() },
  });
  console.log(`[Moralis] ${address} -> ${data.length} tokens returned`);
  return data; // array of tokens with amount and mint
}

async function getPortfolio(address) {
  const url = `${MORALIS_API_BASE}/account/${SOLANA_NETWORK}/${address}`;
  const { data } = await fetchWithRetry(url, {
    headers: { "X-API-Key": getApiKey() },
  });
  return data;
}

async function getTokenMetadata(mintAddress) {
  try {
    const url = `${MORALIS_API_BASE}/token/${SOLANA_NETWORK}/${mintAddress}/metadata`;
    const { data } = await axios.get(url, {
      headers: { "X-API-Key": getApiKey() },
    });
    return {
      name: data.name || "Unknown Token",
      symbol: data.symbol || "UNKNOWN",
      decimals: data.decimals || 0,
      logo: data.logo || null,
    };
  } catch (error) {
    // Return default metadata if API call fails
    return {
      name: "Unknown Token",
      symbol: "UNKNOWN",
      decimals: 0,
      logo: null,
    };
  }
}

module.exports = { getSplTokenBalances, getPortfolio, getTokenMetadata };
