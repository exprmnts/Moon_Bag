process.env.TELEGRAM_BOT_TOKEN ??= "test";
process.env.DATABASE_URL ??= "postgres://test";
process.env.ALCHEMY_API_KEY ??= "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const { decide } = require("../src/decide");

test("a token not seen before is new", () => {
  assert.deepEqual(decide(null, 100n), { kind: "new", dropPct: 0 });
});

test("a balance increase is up", () => {
  assert.equal(decide(100n, 150n).kind, "up");
});

test("a drop of at least 5% is a sell", () => {
  assert.deepEqual(decide(100n, 95n), { kind: "sell", dropPct: 0.05 });
  assert.equal(decide(100n, 0n).kind, "sell");
  assert.equal(decide(100n, 0n).dropPct, 1);
  assert.equal(decide(1_000_000_000_000_000_000n, 900_000_000_000_000_000n).dropPct, 0.1);
});

test("a smaller drop or no change is none", () => {
  assert.equal(decide(100n, 96n).kind, "none");
  assert.equal(decide(100n, 100n).kind, "none");
  assert.equal(decide(0n, 0n).kind, "none");
});
