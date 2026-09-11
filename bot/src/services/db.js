const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const config = require("../config");

// Neon strings carry sslmode=require; pg warns about it, so we strip the
// parameter and ask for a verified TLS connection explicitly. A local Postgres
// (a test container) speaks plain TCP, so TLS is skipped when the host is local
// or the string says sslmode=disable — never for anything remote.
const url = new URL(config.databaseUrl);
const sslmode = url.searchParams.get("sslmode");
url.searchParams.delete("sslmode");
const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(url.hostname);
const ssl = sslmode === "disable" || local ? false : { rejectUnauthorized: true };

const pool = new Pool({
  connectionString: url.toString(),
  ssl,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on("error", (err) => {
  console.error("[db] idle client error", err.message);
});

async function ensureSchema() {
  const sql = fs.readFileSync(path.join(__dirname, "..", "..", "schema.sql"), "utf8");
  await pool.query(sql);
}

const query = (text, params) => pool.query(text, params);

async function one(text, params) {
  const { rows } = await pool.query(text, params);
  return rows[0] || null;
}

async function many(text, params) {
  const { rows } = await pool.query(text, params);
  return rows;
}

module.exports = { pool, query, one, many, ensureSchema };
