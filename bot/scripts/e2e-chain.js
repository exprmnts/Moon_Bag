// End-to-end proof of the gas fix, against a local anvil fork of Robinhood
// Chain mainnet. Real Uniswap quote and calldata, real pool state, fake money.
//
//   anvil --fork-url https://robinhood-mainnet.g.alchemy.com/v2/$ALCHEMY_API_KEY \
//         --chain-id 4663 --port 8545 --silent &
//   RPC_URL=http://localhost:8545 node scripts/e2e-chain.js [tokenOut]
//
// It sends the same swap twice: once with the gasLimit the Uniswap Trading API
// returns (what the bot used to do) and once with executor.gasFor's number.
// The first is expected to run out of gas and revert — that is the bug behind
// "Buy failed: Transaction reverted" — and the second to confirm.
require("dotenv").config();
const { createPublicClient, createWalletClient, http, formatEther } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const config = require("../src/config");
const uniswap = require("../src/services/uniswap");
const executor = require("../src/executor");
const fee = require("../src/fee");

const RPC = process.env.RPC_URL || "http://localhost:8545";
const TOKEN = process.argv[2] || "0xcb6f4711e9af0e22cf0be5a15b9333f8c03d1e18";
// anvil's first dev account, pre-funded on any fork.
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const line = (s) => console.log(s);

(async () => {
  if (!RPC.includes("localhost") && !RPC.includes("127.0.0.1")) {
    throw new Error(`refusing to run against ${RPC}: this script sends transactions, point RPC_URL at anvil`);
  }
  const account = privateKeyToAccount(KEY);
  const publicClient = createPublicClient({ chain: config.chain, transport: http(RPC) });
  const walletClient = createWalletClient({ account, chain: config.chain, transport: http(RPC) });

  const block = await publicClient.getBlockNumber();
  const balance = await publicClient.getBalance({ address: account.address });
  line(`fork block ${block}, swapper ${account.address} holds ${formatEther(balance)} ETH`);

  const amountWei = config.DEFAULT_BUY_WEI;
  const q = await uniswap.quote({ tokenOut: TOKEN, amountWei, swapper: account.address });
  const split = fee.splitOutputs(q, { swapper: account.address, tokenOut: TOKEN });
  line(`quote ok: ${split.userAmount} to the wallet, ${split.feeAmount} fee (${split.feeBips} bps → ${split.feeRecipient})`);

  const tx = await uniswap.swap(q);
  const apiGas = BigInt(tx.gasLimit || 0);
  const { gas, estimated } = await executor.gasFor(publicClient, account, tx);
  line(`gas: API says ${apiGas}, local estimate ${estimated}, executor will send ${gas}`);

  const send = async (label, gasLimit) => {
    const hash = await walletClient.sendTransaction({
      to: tx.to,
      value: BigInt(tx.value || 0),
      data: tx.data,
      gas: gasLimit,
    });
    const r = await publicClient.waitForTransactionReceipt({ hash });
    line(`  ${label}: gas ${gasLimit} → used ${r.gasUsed} → ${r.status}`);
    return r;
  };

  let oldWay = null;
  if (apiGas > 0n) {
    // Snapshot so the failed attempt does not change the state the good one sees.
    const snap = await publicClient.request({ method: "evm_snapshot", params: [] });
    line("\nwith the Uniswap gasLimit (the old behaviour):");
    oldWay = await send("old", apiGas).catch((e) => ({ status: "threw", err: e.shortMessage || e.message }));
    if (oldWay.err) line(`  old: rejected before sending — ${oldWay.err}`);
    await publicClient.request({ method: "evm_revert", params: [snap] });
  }

  line("\nwith the estimated gas (the fix):");
  const fixed = await send("fixed", gas);

  const tokenBalance = await publicClient.readContract({
    address: TOKEN,
    abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
    functionName: "balanceOf",
    args: [account.address],
  });
  const treasuryBalance = config.treasury
    ? await publicClient.readContract({
        address: TOKEN,
        abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
        functionName: "balanceOf",
        args: [config.treasury],
      })
    : 0n;

  const moved = fee.amountsFromReceipt(fixed.logs, TOKEN, account.address, config.treasury);
  line(`\nwallet now holds ${tokenBalance} of the token; treasury ${treasuryBalance}`);
  line(`receipt says user +${moved.userAmount} fee +${moved.feeAmount}`);

  const oldFailed = !oldWay || oldWay.status !== "success";
  line("");
  line(`old gasLimit  : ${oldWay ? oldWay.status || "threw" : "n/a"}`);
  line(`fixed gasLimit: ${fixed.status}`);
  if (fixed.status !== "success") throw new Error("FAIL: the fix did not confirm");
  if (moved.userAmount == null || moved.userAmount <= 0n) throw new Error("FAIL: no tokens reached the wallet");
  if (config.feeEnabled && (moved.feeAmount == null || moved.feeAmount <= 0n)) throw new Error("FAIL: no fee reached the treasury");
  line(oldFailed ? "PASS: the old gas limit failed, the estimated one bought the moonbag" : "PASS (note: the old limit also worked at this block)");
})().catch((e) => {
  console.error("FAIL", e.shortMessage || e.message);
  process.exit(1);
});
