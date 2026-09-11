process.env.TELEGRAM_BOT_TOKEN ??= "test";
process.env.DATABASE_URL ??= "postgres://test";
process.env.ALCHEMY_API_KEY ??= "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const { classify, tagged, backoffMs, canRetry } = require("../src/errors");

// The messages below are copied from real failures in the trades table, so a
// change in how they are parsed shows up here first.
const REAL = {
  routerTimeout: "Uniswap /quote 404: A routing dependency timed out or failed; the request may succeed on retry.",
  noPool: "Uniswap /quote 404: No quotes available",
  reverted: "Transaction reverted (0x62f3d87efc128a4376a6109d4a5a211893cad0b0761759cfe7f0d62b3c4bfb97)",
  broke: "The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account.",
  // 2026-09-11: the deployed bot held a different MASTER_ENCRYPTION_KEY than the
  // one the wallets were sealed with. This is all node says about it.
  wrongKey: "Unsupported state or unable to authenticate data",
};

test("a router timeout is retryable", () => {
  const c = classify(new Error(REAL.routerTimeout));
  assert.equal(c.code, "QUOTE_UNAVAILABLE");
  assert.equal(c.retryable, true);
  assert.equal(c.alert, false);
});

test("a token with no pool is not retryable", () => {
  const c = classify(new Error(REAL.noPool));
  assert.equal(c.code, "NO_ROUTE");
  assert.equal(c.retryable, false);
});

test("a revert is retryable: the price may have moved", () => {
  assert.equal(classify(new Error(REAL.reverted)).code, "REVERTED");
  assert.equal(classify(new Error(REAL.reverted)).retryable, true);
});

test("an empty wallet is not retried, it is reported", () => {
  const c = classify(new Error(REAL.broke));
  assert.equal(c.code, "INSUFFICIENT_ETH");
  assert.equal(c.retryable, false);
  assert.match(c.user, /enough ETH/);
});

test("a quote that pays the wrong fee fails closed and alerts", () => {
  const c = classify(new Error("Uniswap quote fee recipient 0xdead is not the treasury"));
  assert.equal(c.code, "FEE_MISMATCH");
  assert.equal(c.retryable, false);
  assert.equal(c.alert, true);
});

test("a failed gas estimate means the swap would revert", () => {
  assert.equal(classify(new Error("execution reverted")).code, "WOULD_REVERT");
  assert.equal(classify(new Error("execution reverted")).retryable, true);
});

test("rate limiting is retryable", () => {
  assert.equal(classify(new Error("Uniswap /quote 429: Too many requests")).code, "RATE_LIMITED");
});

test("a server error is retryable", () => {
  assert.equal(classify(new Error("Uniswap /swap 503: upstream unavailable")).code, "QUOTE_UNAVAILABLE");
});

test("network noise is retryable", () => {
  for (const m of ["fetch failed", "socket hang up", "ETIMEDOUT", "nonce too low"]) {
    assert.equal(classify(new Error(m)).retryable, true, m);
  }
});

test("an unknown error is retried once but alerts", () => {
  const c = classify(new Error("something nobody predicted"));
  assert.equal(c.code, "UNKNOWN");
  assert.equal(c.retryable, true);
  assert.equal(c.alert, true);
});

test("our own tagged errors keep their code", () => {
  assert.equal(classify(tagged("RECEIPT_TIMEOUT", "still waiting on 0xabc")).code, "RECEIPT_TIMEOUT");
  assert.equal(classify(tagged("NO_WALLET")).retryable, false);
});

test("the user message never carries the raw error", () => {
  for (const m of Object.values(REAL)) {
    const c = classify(new Error(m));
    assert.ok(!c.user.includes("0x"), `${c.code} leaked a hash`);
    assert.ok(!/\d{3}:/.test(c.user), `${c.code} leaked a status code`);
    assert.ok(c.user.length < 120, `${c.code} is too long for a chat`);
  }
});

test("backoff grows and then holds steady", () => {
  const table = [5_000, 15_000, 45_000, 120_000];
  assert.equal(backoffMs(1, table), 5_000);
  assert.equal(backoffMs(2, table), 15_000);
  assert.equal(backoffMs(4, table), 120_000);
  assert.equal(backoffMs(9, table), 120_000, "past the table the last delay repeats");
  assert.equal(backoffMs(0, table), 5_000, "attempt counts below 1 clamp to the first delay");
});

test("attempts are capped", () => {
  assert.equal(canRetry(4, 5), true);
  assert.equal(canRetry(5, 5), false, "the fifth failure is the last");
  assert.equal(canRetry(6, 5), false);
});

// A wallet sealed under another key cannot be opened by trying again: the sixth
// attempt fails exactly like the first. Before this was classified it landed in
// UNKNOWN, which is retryable, and burned five attempts and five alerts.
test("a wallet sealed under another master key is not retryable", () => {
  const c = classify(new Error(REAL.wrongKey));
  assert.equal(c.code, "KEY_MISMATCH");
  assert.equal(c.retryable, false);
  assert.equal(c.alert, true);
});

test("services/crypto tags the decrypt failure itself", () => {
  const c = classify(tagged("KEY_MISMATCH", "This wallet was encrypted with a different MASTER_ENCRYPTION_KEY"));
  assert.equal(c.code, "KEY_MISMATCH");
  assert.equal(c.retryable, false);
});

test("the user is told their funds are untouched, not that we broke", () => {
  const c = classify(new Error(REAL.wrongKey));
  assert.match(c.user, /untouched/);
  assert.doesNotMatch(c.user, /Something went wrong/);
});
