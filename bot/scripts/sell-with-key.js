// Sell a token back to ETH with a private key you hold, outside the bot.
//
//   node scripts/sell-with-key.js <token> [amount|all|50%] [--yes]
//
// The key is read, in order, from --key, from PRIVATE_KEY in the environment,
// or from a hidden prompt. Prefer the prompt or the environment: a key passed
// as --key is written to your shell history and to the process list.
//
//   PRIVATE_KEY=0x… node scripts/sell-with-key.js 0xtoken… all --yes
//   node scripts/sell-with-key.js 0xtoken… 50%     # asks for the key, quotes, stops
//
// The mirror of scripts/buy-with-key.js, and the one thing the bot itself never
// does (see ROADMAP.md: "Buying with native ETH needs no approval. Selling
// would."). Selling an ERC-20 through the Universal Router takes two things
// buying does not:
//
//   1. a one-off ERC-20 approve() of Permit2, which this script sends only if
//      the current allowance is too small, and
//   2. a signed Permit2 PermitSingle (the quote's permitData), which gives the
//      router a time-limited allowance without a second transaction.
//
// No fee is taken. The 1% is charged on the way in, in the token bought; these
// are already your tokens, so the whole proceeds come back to your wallet, and
// the script refuses to sign a quote that says otherwise.
//
// Without --yes it quotes and prints what it would sell, and sends nothing.
// DRY_RUN=true in .env blocks the send outright, --yes or not.
//
// It reads .env through src/config, which also insists on TELEGRAM_BOT_TOKEN and
// DATABASE_URL being set; neither is used here.
const { createPublicClient, createWalletClient, http, parseUnits, formatEther, isAddress, getAddress, maxUint256 } = require("viem");
const config = require("../src/config");
const uniswap = require("../src/services/uniswap");
const executor = require("../src/executor");
const fee = require("../src/fee");
const { parseArgs, die, readKey, accountFrom, fmt } = require("./lib/cli");

// The canonical Permit2, same address on every chain (ROADMAP.md).
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

const ERC20 = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
];

const { flag, has, positional } = parseArgs(process.argv.slice(2), ["--key"]);
const [TOKEN, AMOUNT = "all"] = positional;
const GO = has("--yes");

// "all", "100%", "12.5%" or a plain token amount ("1000", "0.5"). Percentages
// are taken of the balance in whole units, so selling 50% of an odd balance
// rounds down and never tries to sell a token that is not there.
function resolveAmount(input, balance, decimals) {
  const text = String(input).trim().toLowerCase();
  if (text === "all" || text === "max" || text === "100%") return balance;
  const asPct = text.match(/^(\d+(?:\.\d+)?)%$/);
  if (asPct) {
    const scaled = parseUnits(asPct[1], 4); // 100% → 1_000_000
    if (scaled <= 0n || scaled > 1_000_000n) die(`"${input}" is not a percentage between 0 and 100`);
    return (balance * scaled) / 1_000_000n;
  }
  if (decimals == null) die(`${TOKEN} does not report its decimals, so "${input}" cannot be read as an amount — use all or a percentage`);
  try {
    return parseUnits(text, decimals);
  } catch {
    return die(`"${input}" is not an amount of tokens: use all, a percentage like 50%, or a number`);
  }
}

(async () => {
  if (!TOKEN) die("usage: node scripts/sell-with-key.js <token> [amount|all|50%] [--yes]   (key from --key, PRIVATE_KEY, or the prompt)");
  if (!isAddress(TOKEN, { strict: false })) die(`"${TOKEN}" is not a token address`);
  const token = getAddress(TOKEN);

  const account = accountFrom(await readKey(flag("--key")));
  const publicClient = createPublicClient({ chain: config.chain, transport: http(config.rpcUrl, { timeout: 15_000, retryCount: 2 }) });
  const read = (functionName, args) => publicClient.readContract({ address: token, abi: ERC20, functionName, args });

  const [eth, gasPrice, symbol, decimalsRaw, balance, allowance] = await Promise.all([
    publicClient.getBalance({ address: account.address }),
    publicClient.getGasPrice().catch(() => 0n),
    read("symbol").catch(() => null),
    read("decimals").catch(() => null),
    read("balanceOf", [account.address]).catch(() => 0n),
    read("allowance", [account.address, PERMIT2]).catch(() => 0n),
  ]);
  const decimals = decimalsRaw == null ? null : Number(decimalsRaw);
  const name = symbol || token;
  const amountWei = resolveAmount(AMOUNT, balance, decimals);

  console.log("=".repeat(68));
  console.log(`wallet     ${account.address}`);
  console.log(`holds      ${fmt(balance, decimals)} ${name}, ${formatEther(eth)} ETH`);
  console.log(`selling    ${fmt(amountWei, decimals)} ${name}${AMOUNT === "all" ? " (the whole balance)" : ""}`);
  console.log(`token      ${token}`);
  console.log(`chain      ${config.chainName} (${config.chainId})   dryRun=${config.dryRun}`);
  console.log(`rpc        ${new URL(config.rpcUrl).host}`);
  console.log(`permit2    ${allowance >= amountWei ? "already approved" : "approval needed (one extra transaction)"}`);
  console.log("=".repeat(68));

  if (!config.isMainnet) die(`CHAIN=${config.chainName} — Uniswap only exists on mainnet 4663.`);
  if (balance <= 0n) die(`the wallet holds none of ${name}.`);
  if (amountWei <= 0n) die("that works out at 0 tokens.");
  if (amountWei > balance) die(`the wallet holds ${fmt(balance, decimals)} ${name}, which is less than that.`);

  // The quote is free and tells you the price, so it runs before any gate.
  const quote = await uniswap.quoteSell({ tokenIn: token, amountWei, swapper: account.address });
  // No fee was requested, so this refuses a quote that carries one anyway, or
  // that pays anyone but this wallet.
  const split = fee.splitOutputs(quote, { enabled: false, swapper: account.address, tokenOut: config.nativeEth });
  const minOut = BigInt(quote.quote?.output?.minimumAmount ?? 0);
  console.log(`\nquote      ${formatEther(split.userAmount)} ETH for ${fmt(amountWei, decimals)} ${name}`);
  console.log(`minimum    ${formatEther(minOut)} ETH at ${config.SLIPPAGE}% slippage`);

  if (config.dryRun) die("DRY_RUN=true in .env — nothing was sent. Set DRY_RUN=false to sell for real.");
  if (!GO) {
    console.log(
      `\nThis would sell real tokens${allowance >= amountWei ? "" : ", after one approval transaction"}. Re-run with --yes to send it.`
    );
    process.exit(0);
  }

  const walletClient = createWalletClient({ account, chain: config.chain, transport: http(config.rpcUrl, { timeout: 30_000 }) });

  // 1. The ERC-20 allowance to Permit2. Granted once per token per wallet, for
  // the maximum, so a later sell of the same token needs no second approval.
  if (allowance < amountWei) {
    const approveGas = await publicClient
      .estimateContractGas({ address: token, abi: ERC20, functionName: "approve", args: [PERMIT2, maxUint256], account })
      .catch(() => 100_000n);
    const hash = await walletClient.writeContract({
      address: token,
      abi: ERC20,
      functionName: "approve",
      args: [PERMIT2, maxUint256],
      gas: (approveGas * BigInt(100 + config.GAS_BUFFER_PCT)) / 100n,
    });
    console.log(`\napproving  ${config.explorerTx}${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") die(`the approval reverted: ${config.explorerTx}${hash}`);
    console.log(`approved   Permit2 may now move your ${name}`);
  }

  // 2. The Permit2 signature. It is what lets the router pull the tokens in the
  // same transaction as the swap, instead of a second on-chain approval.
  let signature = null;
  if (quote.permitData) {
    const { domain, types, values } = quote.permitData;
    signature = await account.signTypedData({ domain, types, primaryType: "PermitSingle", message: values });
    console.log(`permit     signed, spender ${values.spender}`);
  }

  const tx = await uniswap.swap(quote, { signature });
  // The Trading API's gasLimit has been seen 4x too low on this chain, so the
  // swap is estimated locally and the larger number sent (see executor.gasFor).
  const { gas, estimated, fromApi } = await executor.gasFor(publicClient, account, tx);
  console.log(`gas        ${gas} (estimated ${estimated}, Uniswap said ${fromApi || "nothing"}) at ${gasPrice} wei`);

  const ethBefore = await publicClient.getBalance({ address: account.address });
  const hash = await walletClient.sendTransaction({ to: tx.to, value: BigInt(tx.value || 0), data: tx.data, gas });
  console.log(`\nsent       ${config.explorerTx}${hash}\nwaiting for the receipt…`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") die(`the swap reverted (gas used ${receipt.gasUsed} of ${gas}): ${config.explorerTx}${hash}`);

  // What actually moved. ETH arrives without a Transfer log, so it is read from
  // the balance and the gas is added back to separate the two.
  const [ethAfter, tokensLeft] = await Promise.all([
    publicClient.getBalance({ address: account.address }),
    read("balanceOf", [account.address]).catch(() => null),
  ]);
  const spentOnGas = receipt.gasUsed * (receipt.effectiveGasPrice ?? gasPrice);
  const received = ethAfter - ethBefore + spentOnGas;

  console.log("\n--- confirmed ---");
  console.log(`received   ${formatEther(received)} ETH (${formatEther(spentOnGas)} of it went to gas)`);
  console.log(`sold       ${fmt(amountWei, decimals)} ${name}`);
  console.log(`wallet now ${fmt(tokensLeft, decimals)} ${name}, ${formatEther(ethAfter)} ETH`);
  console.log(`gas used   ${receipt.gasUsed} of ${gas}`);
  process.exit(0);
})().catch((err) => {
  console.error("\n✖ failed:", err.shortMessage || err.message);
  process.exit(1);
});
