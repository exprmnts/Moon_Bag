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

function decryptSecret(payload) {
  const key = getMasterKey();
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const decipher = crypto.createDecipheriv(AES_ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([
    decipher.update(Buffer.from(payload.ct, "base64")),
    decipher.final(),
  ]);
  return pt.toString("utf8");
}

module.exports = { encryptSecret, decryptSecret };
