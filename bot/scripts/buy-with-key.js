// Buy a token with a private key you hold, outside the bot.
//
//   node scripts/buy-with-key.js <token> [eth] [--yes]
//
// The key is read, in order, from --key, from PRIVATE_KEY in the environment,
// or from a hidden prompt. Prefer the prompt or the environment: a key passed
// as --key is written to your shell history and to the process list.
//
//   PRIVATE_KEY=0x… node scripts/buy-with-key.js 0xtoken… 0.01 --yes
//   node scripts/buy-with-key.js 0xtoken… 0.01        # asks for the key, quotes, stops
//
// It is the same swap path the bot uses — the real Uniswap quote, fee.splitOutputs
// checking the 1% lands on the treasury, executor.gasFor correcting the Trading
// API's too-low gasLimit — with none of the bookkeeping: no database row, no
// Telegram message, no retries. One quote, one transaction, one receipt.
//
// Without --yes it quotes and prints what it would spend, and sends nothing.
// DRY_RUN=true in .env blocks the send outright, --yes or not.
//
// It reads .env for ALCHEMY_API_KEY, CHAIN, UNISWAP_API_KEY and TREASURY_ADDRESS
// through src/config, which also insists on TELEGRAM_BOT_TOKEN and DATABASE_URL
// being set; neither is used here.
const { createPublicClient, createWalletClient, http, parseEther, formatEther, isAddress, getAddress } = require("viem");
const config = require("../src/config");
const uniswap = require("../src/services/uniswap");
const executor = require("../src/executor");
const fee = require("../src/fee");
const { parseArgs, die, readKey, accountFrom, fmt } = require("./lib/cli");

const ERC20 = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
];

const { flag, has, positional } = parseArgs(process.argv.slice(2), ["--key"]);
const [TOKEN, AMOUNT] = positional;
const GO = has("--yes");

(async () => {
  if (!TOKEN) die("usage: node scripts/buy-with-key.js <token> [eth] [--yes]   (key from --key, PRIVATE_KEY, or the prompt)");
  if (!isAddress(TOKEN, { strict: false })) die(`"${TOKEN}" is not a token address`);
  const token = getAddress(TOKEN);

  let amountWei;
  try {
    amountWei = AMOUNT ? parseEther(AMOUNT) : config.DEFAULT_BUY_WEI;
  } catch {
    die(`"${AMOUNT}" is not an amount of ETH`);
  }
  if (amountWei <= 0n) die("the amount must be more than 0 ETH");

  const account = accountFrom(await readKey(flag("--key")));

  const publicClient = createPublicClient({ chain: config.chain, transport: http(config.rpcUrl, { timeout: 15_000, retryCount: 2 }) });
  const [eth, gasPrice, meta] = await Promise.all([
    publicClient.getBalance({ address: account.address }),
    publicClient.getGasPrice().catch(() => 0n),
    Promise.all([
      publicClient.readContract({ address: token, abi: ERC20, functionName: "symbol" }).catch(() => null),
      publicClient.readContract({ address: token, abi: ERC20, functionName: "decimals" }).catch(() => null),
    ]).then(([symbol, decimals]) => ({ symbol, decimals: decimals == null ? null : Number(decimals) })),
  ]);
  const name = meta.symbol || token;

  console.log("=".repeat(68));
  console.log(`wallet     ${account.address}`);
  console.log(`balance    ${formatEther(eth)} ETH`);
  console.log(`buying     ${formatEther(amountWei)} ETH of ${name}`);
  console.log(`token      ${token}`);
  console.log(`chain      ${config.chainName} (${config.chainId})   dryRun=${config.dryRun}`);
  console.log(`rpc        ${new URL(config.rpcUrl).host}`);
  console.log(`fee        ${config.feeEnabled ? `${config.FEE_BIPS} bips → ${config.treasury}` : "off (no TREASURY_ADDRESS)"}`);
  console.log("=".repeat(68));

  if (!config.isMainnet) die(`CHAIN=${config.chainName} — Uniswap only exists on mainnet 4663.`);
  if (eth <= amountWei) die(`not enough ETH: the wallet holds ${formatEther(eth)} and this buy spends ${formatEther(amountWei)} plus gas.`);

  // The quote is free and tells you the price, so it runs before any gate.
  const quote = await uniswap.quote({ tokenOut: token, amountWei, swapper: account.address });
  // Refuses to go on unless the quote pays exactly our fee to our treasury.
  const split = fee.splitOutputs(quote, { swapper: account.address, tokenOut: token });
  console.log(`\nquote      ${fmt(split.userAmount, meta.decimals)} ${meta.symbol || "tokens"} to the wallet`);
  if (config.feeEnabled) console.log(`fee        ${fmt(split.feeAmount, meta.decimals)} ${meta.symbol || "tokens"} (${fee.pct(split.feeBips)}) to ${split.feeRecipient}`);
  console.log(`slippage   ${config.SLIPPAGE}%`);

  if (config.dryRun) die("DRY_RUN=true in .env — nothing was sent. Set DRY_RUN=false to buy for real.");

  const tx = await uniswap.swap(quote);
  const { gas, estimated, fromApi } = await executor.gasFor(publicClient, account, tx);
  const cost = BigInt(tx.value || 0) + gas * gasPrice;
  console.log(`gas        ${gas} (estimated ${estimated}, Uniswap said ${fromApi || "nothing"}) at ${gasPrice} wei`);
  console.log(`total      ~${formatEther(cost)} ETH out of the wallet`);

  if (eth < cost) die(`not enough ETH: the wallet holds ${formatEther(eth)}, this buy needs about ${formatEther(cost)}.`);
  if (!GO) {
    console.log("\nThis would spend real ETH. Re-run with --yes to send it.");
    process.exit(0);
  }

  const walletClient = createWalletClient({ account, chain: config.chain, transport: http(config.rpcUrl, { timeout: 30_000 }) });
  const hash = await walletClient.sendTransaction({ to: tx.to, value: BigInt(tx.value || 0), data: tx.data, gas });
  console.log(`\nsent       ${config.explorerTx}${hash}\nwaiting for the receipt…`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") die(`the swap reverted (gas used ${receipt.gasUsed} of ${gas}): ${config.explorerTx}${hash}`);

  // What actually moved beats what was quoted.
  const moved = fee.amountsFromReceipt(receipt.logs, token, account.address, config.treasury);
  const held = await publicClient.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [account.address] });

  console.log("\n--- confirmed ---");
  console.log(`tokens     +${moved.userAmount == null ? "?" : fmt(moved.userAmount, meta.decimals)} ${meta.symbol || ""}`);
  if (config.feeEnabled) console.log(`fee        ${moved.feeAmount == null ? "?" : fmt(moved.feeAmount, meta.decimals)} to the treasury`);
  console.log(`wallet now ${fmt(held, meta.decimals)} ${meta.symbol || "tokens"}, ${formatEther(await publicClient.getBalance({ address: account.address }))} ETH`);
  console.log(`gas used   ${receipt.gasUsed} of ${gas}`);
  process.exit(0);
})().catch((err) => {
  console.error("\n✖ failed:", err.shortMessage || err.message);
  process.exit(1);
});
