// Read-only probe: does a candidate MASTER_ENCRYPTION_KEY decrypt the wallet
// rows in a given database? Prints counts and a per-day cohort breakdown only —
// never an id, an address or a key.
//
//   CHECK_DB_URL=... CHECK_KEY=... node scripts/keycheck.js
//
// Both default to the values in bot/.env, so a bare run tests the local key
// against the local DATABASE_URL.
const B = require("path").join(__dirname, "..");
require(B + "/node_modules/dotenv").config({ path: B + "/.env" });

const crypto = require("crypto");
const { Pool } = require(B + "/node_modules/pg");

const url = process.env.CHECK_DB_URL || process.env.DATABASE_URL;
const candidate = process.env.CHECK_KEY || process.env.MASTER_ENCRYPTION_KEY;
if (!url || !candidate) {
  console.error("need a database url and a candidate key");
  process.exit(1);
}

const aesKey = crypto.createHash("sha256").update(candidate).digest();
function decrypts(row) {
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", aesKey, Buffer.from(row.key_iv, "base64"));
    d.setAuthTag(Buffer.from(row.key_tag, "base64"));
    Buffer.concat([d.update(Buffer.from(row.key_ct, "base64")), d.final()]);
    return true;
  } catch {
    return false;
  }
}

(async () => {
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  const { rows } = await pool.query(
    "select key_iv, key_ct, key_tag, created_at from users where key_ct is not null order by created_at"
  );

  console.log("db host:      ", new URL(url).hostname);
  console.log("key length:   ", candidate.length, /\s/.test(candidate) ? "(WARNING: contains whitespace)" : "");

  const byDay = new Map();
  let ok = 0;
  for (const r of rows) {
    const good = decrypts(r);
    if (good) ok++;
    const day = new Date(r.created_at).toISOString().slice(0, 10);
    const c = byDay.get(day) || { ok: 0, fail: 0 };
    c[good ? "ok" : "fail"]++;
    byDay.set(day, c);
  }

  console.log(`\nwallets=${rows.length}  decrypt_ok=${ok}  decrypt_fail=${rows.length - ok}`);
  if (rows.length !== ok && ok !== 0) console.log("MIXED: these rows were written under more than one key.");
  console.log("\nby day created:");
  for (const [day, c] of byDay) console.log(`  ${day}  ok=${String(c.ok).padStart(3)}  fail=${String(c.fail).padStart(3)}`);

  await pool.end();
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
