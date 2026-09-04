process.env.TELEGRAM_BOT_TOKEN ??= "test";
process.env.DATABASE_URL ??= "postgres://test";
process.env.ALCHEMY_API_KEY ??= "test";
process.env.CHAIN ??= "testnet";
process.env.TREASURY_ADDRESS ??= "0x1111111111111111111111111111111111111111";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { encodeEventTopics, toHex } = require("viem");
const config = require("../src/config");
const fee = require("../src/fee");

const TREASURY = config.treasury;
const USER = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x3333333333333333333333333333333333333333";
const OTHER = "0x4444444444444444444444444444444444444444";

const principal = (over = {}) => ({ token: TOKEN, amount: "990", recipient: USER, bps: 9900, minAmount: "980", ...over });
const feeOut = (over = {}) => ({ token: TOKEN, amount: "10", recipient: TREASURY, bps: 100, minAmount: "9", fee: "INTEGRATOR", ...over });
const quoteWith = (aggregatedOutputs) => ({ quote: { output: { amount: "1000", token: TOKEN }, aggregatedOutputs } });

test("the fee is on in this test environment", () => {
  assert.equal(config.feeEnabled, true);
  assert.equal(config.FEE_BIPS, 100);
  assert.equal(fee.pct(config.FEE_BIPS), "1%");
});

test("integratorFees is one entry at FEE_BIPS to the treasury, or null when off", () => {
  assert.deepEqual(fee.integratorFees(), [{ bips: 100, recipient: TREASURY }]);
  assert.equal(fee.integratorFees({ enabled: false }), null);
});

test("splitOutputs reads the user's tokens and the treasury's fee", () => {
  const r = fee.splitOutputs(quoteWith([principal(), feeOut()]), { swapper: USER, tokenOut: TOKEN });
  assert.deepEqual(r, { userAmount: 990n, feeAmount: 10n, feeBips: 100, feeRecipient: TREASURY });
});

test("splitOutputs accepts the treasury in any case and sums several principal outputs", () => {
  const r = fee.splitOutputs(quoteWith([principal({ amount: "500" }), principal({ amount: "490" }), feeOut({ recipient: TREASURY.toLowerCase() })]));
  assert.equal(r.userAmount, 990n);
  assert.equal(r.feeAmount, 10n);
});

test("splitOutputs refuses a quote without outputs while the fee is on", () => {
  assert.throws(() => fee.splitOutputs({ quote: { output: { amount: "1000" } } }), /aggregatedOutputs/);
});

test("splitOutputs refuses a fee to the wrong address", () => {
  assert.throws(() => fee.splitOutputs(quoteWith([principal(), feeOut({ recipient: OTHER })])), /not the treasury/);
});

test("splitOutputs refuses the wrong rate and a second fee", () => {
  assert.throws(() => fee.splitOutputs(quoteWith([principal(), feeOut({ bps: 250 })])), /250 bps, expected 100/);
  assert.throws(() => fee.splitOutputs(quoteWith([principal(), feeOut(), feeOut()])), /2 fee outputs/);
  assert.throws(() => fee.splitOutputs(quoteWith([principal()])), /0 fee outputs/);
});

test("splitOutputs refuses a principal paid to someone else or in another token", () => {
  assert.throws(() => fee.splitOutputs(quoteWith([principal({ recipient: OTHER }), feeOut()]), { swapper: USER }), /not the bot wallet/);
  assert.throws(() => fee.splitOutputs(quoteWith([principal({ token: OTHER }), feeOut()]), { tokenOut: TOKEN }), /principal is not the token/);
  assert.throws(() => fee.splitOutputs(quoteWith([principal(), feeOut({ token: OTHER })]), { tokenOut: TOKEN }), /fee is not in the token/);
});

test("with the fee off, splitOutputs falls back to output.amount and refuses stray fees", () => {
  const off = { enabled: false };
  assert.deepEqual(fee.splitOutputs({ quote: { output: { amount: "1000" } } }, off), { userAmount: 1000n, feeAmount: 0n, feeBips: 0, feeRecipient: null });
  assert.deepEqual(fee.splitOutputs(quoteWith([principal({ amount: "1000" })]), off).userAmount, 1000n);
  assert.equal(fee.splitOutputs({}, off).userAmount, null);
  assert.throws(() => fee.splitOutputs(quoteWith([principal(), feeOut()]), off), /not requested/);
});

test("amountsFromReceipt sums the token's transfers to the wallet and to the treasury", () => {
  const log = (to, value, address = TOKEN) => ({
    address,
    topics: encodeEventTopics({ abi: [fee.TRANSFER], eventName: "Transfer", args: { from: OTHER, to } }),
    data: toHex(value, { size: 32 }),
    blockNumber: 1n,
    logIndex: 0,
    transactionHash: "0x00",
    transactionIndex: 0,
    blockHash: "0x00",
    removed: false,
  });
  const logs = [log(USER, 900n), log(USER, 90n), log(TREASURY, 10n), log(USER, 5n, OTHER), log(OTHER, 7n)];
  assert.deepEqual(fee.amountsFromReceipt(logs, TOKEN, USER, TREASURY), { userAmount: 990n, feeAmount: 10n });
  assert.deepEqual(fee.amountsFromReceipt([log(USER, 1n)], TOKEN, USER, TREASURY), { userAmount: 1n, feeAmount: null });
  assert.deepEqual(fee.amountsFromReceipt([], TOKEN, USER, TREASURY), { userAmount: null, feeAmount: null });
  assert.deepEqual(fee.amountsFromReceipt(undefined, TOKEN, USER, TREASURY), { userAmount: null, feeAmount: null });
});

function bootConfig(env) {
  return spawnSync(process.execPath, ["-e", 'require("./src/config")'], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

test("config refuses mainnet without a treasury and refuses a bad address", () => {
  const noTreasury = bootConfig({ CHAIN: "mainnet", TREASURY_ADDRESS: "" });
  assert.notEqual(noTreasury.status, 0);
  assert.match(noTreasury.stderr, /TREASURY_ADDRESS/);

  const bad = bootConfig({ CHAIN: "testnet", TREASURY_ADDRESS: "0x1234" });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /not a valid address/);

  const ok = bootConfig({ CHAIN: "mainnet", TREASURY_ADDRESS: TREASURY });
  assert.equal(ok.status, 0, ok.stderr);

  const testnetNoFee = bootConfig({ CHAIN: "testnet", TREASURY_ADDRESS: "" });
  assert.equal(testnetNoFee.status, 0, testnetNoFee.stderr);
});
