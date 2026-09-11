// Chain constants and environment parsing. Every derived value lives here;
// the rest of the code never reads process.env directly.
require("dotenv").config();

const { robinhood, robinhoodTestnet } = require("viem/chains");
const { parseEther, isAddress, getAddress } = require("viem");

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in environment`);
  return v;
}

const CHAIN_NAME = (process.env.CHAIN || "testnet").toLowerCase();
if (!["mainnet", "testnet"].includes(CHAIN_NAME)) {
  throw new Error(`CHAIN must be "mainnet" or "testnet", got "${CHAIN_NAME}"`);
}

const IS_MAINNET = CHAIN_NAME === "mainnet";
const ALCHEMY_API_KEY = required("ALCHEMY_API_KEY");
const ALCHEMY_NETWORK = IS_MAINNET ? "robinhood-mainnet" : "robinhood-testnet";

const chain = IS_MAINNET ? robinhood : robinhoodTestnet;

// The fee: 1% of every buy, taken from the token bought and paid to the treasury
// inside the swap (Uniswap Trading API integratorFees). The treasury is a public
// address only; the bot never holds its key. Mainnet refuses to boot without one
// so a forgotten variable cannot silently run fee-free.
const FEE_BIPS = 100;
const TREASURY_RAW = (process.env.TREASURY_ADDRESS || "").trim();
let treasury = null;
if (TREASURY_RAW) {
  if (!isAddress(TREASURY_RAW, { strict: false })) {
    throw new Error(`TREASURY_ADDRESS is not a valid address: ${TREASURY_RAW}`);
  }
  treasury = getAddress(TREASURY_RAW);
}
if (IS_MAINNET && !treasury) {
  throw new Error("Missing TREASURY_ADDRESS in environment: CHAIN=mainnet needs somewhere to send the 1% buy fee");
}

const config = {
  chainName: CHAIN_NAME,
  isMainnet: IS_MAINNET,
  chain,
  chainId: chain.id,
  // RPC_URL / WSS_URL override Alchemy. Only for pointing a test run at a local
  // fork (anvil); production leaves both unset.
  rpcUrl: process.env.RPC_URL || `https://${ALCHEMY_NETWORK}.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  wssUrl: process.env.WSS_URL || `wss://${ALCHEMY_NETWORK}.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  explorerTx: IS_MAINNET
    ? "https://robinhoodchain.blockscout.com/tx/"
    : "https://explorer.testnet.chain.robinhood.com/tx/",
  // Reference only; buys use native ETH. Testnet: the wrapper with deposit()
  // (0x7943…52Fa from the roadmap is a different WETH-named token).
  weth: IS_MAINNET
    ? "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"
    : "0x33e4191705c386532ba27cbf171db86919200b94",

  telegramToken: required("TELEGRAM_BOT_TOKEN"),
  databaseUrl: required("DATABASE_URL"),
  uniswapApiKey: process.env.UNISWAP_API_KEY || "",
  uniswapApiBase: "https://trade-api.gateway.uniswap.org/v1",
  nativeEth: "0x0000000000000000000000000000000000000000",

  dryRun: String(process.env.DRY_RUN ?? "true").toLowerCase() !== "false",
  port: Number(process.env.PORT || 3000),

  treasury, // checksummed, or null (testnet only)
  FEE_BIPS, // basis points of the tokens bought, 100 = 1%; Uniswap allows at most 500
  feeEnabled: Boolean(treasury) && FEE_BIPS > 0,

  DEFAULT_BUY_ETH: "0.005",
  DEFAULT_BUY_WEI: parseEther("0.005"),
  SELL_THRESHOLD: 0.05, // a ≥5% drop from baseline is a sell
  SLIPPAGE: 1, // percent, Uniswap Trading API slippageTolerance
  POLL_MS: 60_000,
  EVENT_DEBOUNCE_MS: 2_000,
  HIGH_BUY_WARN_ETH: 1,

  // Retries. A buy that fails for a transient reason (Uniswap's router timing
  // out, a price that moved, an RPC hiccup) is attempted at most this many times
  // in total; the delay before attempt N+1 is RETRY_BACKOFF_MS[N-1], last value
  // reused. The worker wakes every RETRY_TICK_MS and runs whatever is due.
  MAX_BUY_ATTEMPTS: 5,
  RETRY_BACKOFF_MS: [5_000, 15_000, 45_000, 120_000],
  RETRY_TICK_MS: 10_000,
  // A trade left 'pending' by a crash is re-queued once it is this old.
  STRANDED_AFTER_MS: 5 * 60_000,

  // How long the Uniswap Trading API gets, and how many times one call retries
  // its own transient failures before the attempt is counted as failed.
  UNISWAP_TIMEOUT_MS: 20_000,
  UNISWAP_RETRIES: 2,

  // Gas. The Uniswap Trading API's own gasLimit has been seen 4x too low on
  // Robinhood Chain (tx 0x62f3d87efc128a4376a6109d4a5a211893cad0b0761759cfe7f0d62b3c4bfb97
  // used its whole 259 000 limit and reverted out of gas while the call really
  // needed ~1.13M), so every swap is estimated locally and the larger of the two,
  // plus a buffer, is sent.
  GAS_BUFFER_PCT: 35,
  GAS_LIMIT_CAP: 5_000_000n,
};

module.exports = config;
