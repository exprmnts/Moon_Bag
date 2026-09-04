// The fee, as pure functions. 1% of every buy is taken from the token bought and
// paid to the treasury inside the swap (Uniswap Trading API integratorFees).
// Nothing here touches the network; executor.js wires it in and test/fee.test.js
// covers it.
const { parseEventLogs, parseAbiItem } = require("viem");
const config = require("./config");

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

const same = (a, b) => Boolean(a) && Boolean(b) && String(a).toLowerCase() === String(b).toLowerCase();
const sum = (outputs) => outputs.reduce((acc, o) => acc + BigInt(o.amount), 0n);

// "1%" for 100 bips, "0.5%" for 50.
const pct = (bips) => `${bips / 100}%`;

// The integratorFees value for a /quote request, or null when the fee is off.
function integratorFees({ enabled = config.feeEnabled, bips = config.FEE_BIPS, treasury = config.treasury } = {}) {
  if (!enabled) return null;
  return [{ bips, recipient: treasury }];
}

// Reads a /quote response into what the user gets and what the treasury gets.
// Throws when the quote does not carry exactly the fee we asked for, so a swap
// that pays the wrong address or the wrong rate is never signed.
// Returns { userAmount: bigint | null, feeAmount: bigint, feeBips: number, feeRecipient: string | null }.
function splitOutputs(
  quoteResponse,
  { enabled = config.feeEnabled, bips = config.FEE_BIPS, treasury = config.treasury, swapper, tokenOut } = {}
) {
  const q = (quoteResponse && quoteResponse.quote) || {};
  const outputs = Array.isArray(q.aggregatedOutputs) ? q.aggregatedOutputs : [];
  const fees = outputs.filter((o) => o.fee === "INTEGRATOR");
  const principal = outputs.filter((o) => o.fee !== "INTEGRATOR");

  if (!enabled) {
    if (fees.length) throw new Error("Uniswap quote carries an integrator fee that was not requested");
    const amount = principal.length ? sum(principal) : q.output && q.output.amount != null ? BigInt(q.output.amount) : null;
    return { userAmount: amount, feeAmount: 0n, feeBips: 0, feeRecipient: null };
  }

  if (!outputs.length) throw new Error("Uniswap quote has no aggregatedOutputs; the fee cannot be verified");
  if (fees.length !== 1) throw new Error(`Uniswap quote has ${fees.length} fee outputs, expected 1`);
  const fee = fees[0];
  if (!same(fee.recipient, treasury)) throw new Error(`Uniswap quote fee recipient ${fee.recipient} is not the treasury`);
  if (Number(fee.bps) !== Number(bips)) throw new Error(`Uniswap quote fee is ${fee.bps} bps, expected ${bips}`);
  if (tokenOut && fee.token && !same(fee.token, tokenOut)) throw new Error("Uniswap quote fee is not in the token bought");
  if (!principal.length) throw new Error("Uniswap quote has no principal output");
  for (const p of principal) {
    if (swapper && p.recipient && !same(p.recipient, swapper)) throw new Error(`Uniswap quote pays ${p.recipient}, not the bot wallet`);
    if (tokenOut && p.token && !same(p.token, tokenOut)) throw new Error("Uniswap quote principal is not the token bought");
  }
  return { userAmount: sum(principal), feeAmount: BigInt(fee.amount), feeBips: Number(bips), feeRecipient: fee.recipient };
}

// What actually moved: the token's Transfer logs in a receipt, summed per
// destination. Either value is null when no log matched (then keep the quote).
function amountsFromReceipt(logs, token, user, treasury) {
  let parsed;
  try {
    parsed = parseEventLogs({ abi: [TRANSFER], logs: logs || [], eventName: "Transfer", strict: false });
  } catch {
    return { userAmount: null, feeAmount: null };
  }
  let userAmount = null;
  let feeAmount = null;
  for (const log of parsed) {
    if (!same(log.address, token) || !log.args || log.args.value == null) continue;
    if (same(log.args.to, user)) userAmount = (userAmount ?? 0n) + BigInt(log.args.value);
    else if (treasury && same(log.args.to, treasury)) feeAmount = (feeAmount ?? 0n) + BigInt(log.args.value);
  }
  return { userAmount, feeAmount };
}

module.exports = { integratorFees, splitOutputs, amountsFromReceipt, pct, TRANSFER };
