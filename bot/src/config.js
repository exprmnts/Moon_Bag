// Chain constants and environment parsing. Every derived value lives here;
// the rest of the code never reads process.env directly.
require("dotenv").config();

const { robinhood, robinhoodTestnet } = require("viem/chains");
const { parseEther } = require("viem");

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

const config = {
  chainName: CHAIN_NAME,
  isMainnet: IS_MAINNET,
  chain,
  chainId: chain.id,
  rpcUrl: `https://${ALCHEMY_NETWORK}.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  wssUrl: `wss://${ALCHEMY_NETWORK}.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
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

  DEFAULT_BUY_ETH: "0.005",
  DEFAULT_BUY_WEI: parseEther("0.005"),
  SELL_THRESHOLD: 0.05, // a ≥5% drop from baseline is a sell
  SLIPPAGE: 1, // percent, Uniswap Trading API slippageTolerance
  POLL_MS: 60_000,
  EVENT_DEBOUNCE_MS: 2_000,
  HIGH_BUY_WARN_ETH: 1,
};

module.exports = config;
