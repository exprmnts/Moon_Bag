const axios = require('axios');

const MORALIS_API_BASE = 'https://solana-gateway.moralis.io';

function getApiKey() {
	const apiKey = process.env.MORALIS_API_KEY;
	if (!apiKey) throw new Error('Missing MORALIS_API_KEY');
	return apiKey;
}

async function getSplTokenBalances(address) {
	const url = `${MORALIS_API_BASE}/account/mainnet/${address}/tokens`;
	const { data } = await axios.get(url, {
		headers: { 'X-API-Key': getApiKey() },
	});
	return data; // array of tokens with amount and mint
}

async function getPortfolio(address) {
	const url = `${MORALIS_API_BASE}/account/mainnet/${address}`;
	const { data } = await axios.get(url, {
		headers: { 'X-API-Key': getApiKey() },
	});
	return data;
}

module.exports = { getSplTokenBalances, getPortfolio };


