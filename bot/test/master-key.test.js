process.env.TELEGRAM_BOT_TOKEN ??= "test";
process.env.DATABASE_URL ??= "postgres://test";
process.env.ALCHEMY_API_KEY ??= "test";
process.env.MASTER_ENCRYPTION_KEY = "a".repeat(64);

// The 2026-09-11 incident: the deployed bot held a different
// MASTER_ENCRYPTION_KEY than the one the wallets were sealed with, and the only
// symptom was two users' buys dying with six words of node crypto prose. These
// cover the boot check that now refuses to start in that state. db is stubbed,
// so nothing here touches a real row.
const test = require("node:test");
const assert = require("node:assert/strict");
const B = require("path").join(__dirname, "..");

// Stub the db module before wallet.js requires it: no network, no real rows.
const db = require(B + "/src/services/db");
let ROWS = [];
db.many = async () => ROWS;

const { encryptSecret } = require(B + "/src/services/crypto");
const wallet = require(B + "/src/wallet");

const sealed = (k) => {
  const was = process.env.MASTER_ENCRYPTION_KEY;
  process.env.MASTER_ENCRYPTION_KEY = k;
  const e = encryptSecret("0xdeadbeef");
  process.env.MASTER_ENCRYPTION_KEY = was;
  return { key_iv: e.iv, key_ct: e.ct, key_tag: e.tag };
};

test("the right key opens every wallet", async () => {
  ROWS = [sealed("a".repeat(64)), sealed("a".repeat(64))];
  const r = await wallet.checkMasterKey();
  assert.deepEqual({ checked: r.checked, opened: r.opened, failed: r.failed }, { checked: 2, opened: 2, failed: 0 });
});

test("a wrong key opens none of them", async () => {
  ROWS = [sealed("b".repeat(64)), sealed("b".repeat(64))];
  const r = await wallet.checkMasterKey();
  assert.deepEqual({ checked: r.checked, opened: r.opened, failed: r.failed }, { checked: 2, opened: 2 - 2, failed: 2 });
});

test("a key changed mid-life shows as a mixed cohort", async () => {
  ROWS = [sealed("a".repeat(64)), sealed("b".repeat(64))];
  const r = await wallet.checkMasterKey();
  assert.equal(r.opened, 1);
  assert.equal(r.failed, 1);
});

test("no wallets yet is not a failure", async () => {
  ROWS = [];
  const r = await wallet.checkMasterKey();
  assert.deepEqual({ checked: r.checked, failed: r.failed }, { checked: 0, failed: 0 });
});

test("the fingerprint rides along for the operator", async () => {
  ROWS = [sealed("a".repeat(64))];
  const r = await wallet.checkMasterKey();
  assert.equal(r.fingerprint.length, 12);
});
