const axios = require("axios");
const {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} = require("@solana/web3.js");

const JUP_QUOTE_API = "https://quote-api.jup.ag/v6/quote";
const JUP_SWAP_API = "https://quote-api.jup.ag/v6/swap";

function getSolanaConnection() {
  const rpc =
    process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  return new Connection(rpc, "confirmed");
}

async function fetchQuote({ inputMint, outputMint, amount, slippageBps }) {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amount), // in smallest unit
    slippageBps: String(slippageBps ?? 100),
  });
  const { data } = await axios.get(`${JUP_QUOTE_API}?${params.toString()}`);
  return data;
}

async function executeSwap({
  walletKeypair,
  inputMint,
  outputMint,
  amount,
  slippageBps,
}) {
  const connection = getSolanaConnection();
  const quote = await fetchQuote({
    inputMint,
    outputMint,
    amount,
    slippageBps,
  });
  if (!quote || !quote.routePlan || quote.routePlan.length === 0) {
    throw new Error("No route from Jupiter");
  }
  const { data } = await axios.post(JUP_SWAP_API, {
    quoteResponse: quote,
    userPublicKey: walletKeypair.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
  });

  const swapTx = VersionedTransaction.deserialize(
    Buffer.from(data.swapTransaction, "base64")
  );
  swapTx.sign([walletKeypair]);
  const raw = swapTx.serialize();
  const sig = await connection.sendRawTransaction(raw, {
    skipPreflight: false,
    maxRetries: 3,
  });
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

module.exports = { fetchQuote, executeSwap, getSolanaConnection };
