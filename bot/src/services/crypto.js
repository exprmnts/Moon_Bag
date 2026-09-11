const crypto = require("crypto");

const AES_ALGO = "aes-256-gcm";

function getMasterKey() {
  const key = process.env.MASTER_ENCRYPTION_KEY;
  if (!key || key.length < 32) {
    throw new Error("MASTER_ENCRYPTION_KEY must be at least 32 chars");
  }
  return crypto.createHash("sha256").update(key).digest();
}

function encryptSecret(plaintextBase58) {
  const iv = crypto.randomBytes(12);
  const key = getMasterKey();
  const cipher = crypto.createCipheriv(AES_ALGO, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintextBase58, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    ct: ciphertext.toString("base64"),
    tag: authTag.toString("base64"),
  };
}

// A wallet is sealed under MASTER_ENCRYPTION_KEY and can only be opened by the
// same one. When the key in the environment is not the key the row was written
// with, GCM's tag check fails and node throws "Unsupported state or unable to
// authenticate data" — six words that name neither the key nor the cause. On
// 2026-09-11 that message reached a user as "something went wrong on our side"
// and was retried five times, because nothing here said what it meant. It is
// tagged now, so errors.js can say the true thing and stop.
function decryptSecret(payload) {
  const key = getMasterKey();
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  try {
    const decipher = crypto.createDecipheriv(AES_ALGO, key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([
      decipher.update(Buffer.from(payload.ct, "base64")),
      decipher.final(),
    ]);
    return pt.toString("utf8");
  } catch (cause) {
    const err = new Error(
      "This wallet was encrypted with a different MASTER_ENCRYPTION_KEY than the one this process is running with"
    );
    err.code = "KEY_MISMATCH";
    err.cause = cause;
    throw err;
  }
}

// The first twelve hex of sha256(key): enough to tell two environments apart in
// a log or an alert, never enough to reconstruct the key.
function masterKeyFingerprint() {
  return getMasterKey().toString("hex").slice(0, 12);
}

module.exports = { encryptSecret, decryptSecret, masterKeyFingerprint };
