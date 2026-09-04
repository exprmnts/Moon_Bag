// The one rule. Pure: no I/O, so it is unit-testable and easy to reason about.
//   baseline, current: bigint raw token units (null baseline = token not seen before)
//   returns { kind: 'new' | 'up' | 'sell' | 'none', dropPct }
const { SELL_THRESHOLD } = require("./config");

function decide(baseline, current, threshold = SELL_THRESHOLD) {
  if (baseline == null) return { kind: "new", dropPct: 0 };
  if (current > baseline) return { kind: "up", dropPct: 0 };
  if (baseline === 0n) return { kind: "none", dropPct: 0 };
  // Ratio in basis points to stay in bigint land; then a plain number.
  const dropPct = Number(((baseline - current) * 10_000n) / baseline) / 10_000;
  if (dropPct >= threshold) return { kind: "sell", dropPct };
  return { kind: "none", dropPct };
}

module.exports = { decide };
