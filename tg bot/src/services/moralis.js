const axios = require("axios");

const MORALIS_API_BASE = "https://solana-gateway.moralis.io";

function getApiKey() {
  const apiKey = process.env.MORALIS_API_KEY;
  if (!apiKey) throw new Error("Missing MORALIS_API_KEY");
  return apiKey;
}

const SOLANA_NETWORK = process.env.SOLANA_NETWORK || "mainnet";

async function getSplTokenBalances(address) {
  const url = `${MORALIS_API_BASE}/account/${SOLANA_NETWORK}/${address}/tokens`;
  const { data } = await axios.get(url, {
    headers: { "X-API-Key": getApiKey() },
  });
  return data; // array of tokens with amount and mint
}

async function getPortfolio(address) {
  const url = `${MORALIS_API_BASE}/account/${SOLANA_NETWORK}/${address}`;
  const { data } = await axios.get(url, {
    headers: { "X-API-Key": getApiKey() },
  });
  return data;
}

module.exports = { getSplTokenBalances, getPortfolio };
