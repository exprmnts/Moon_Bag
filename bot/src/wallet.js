// Users, their encrypted keys, buy amounts, watched wallets and the
// one-slot conversation state. All persistence goes through services/db.
const { isAddress, parseEther, getAddress } = require("viem");
const { generatePrivateKey, privateKeyToAccount } = require("viem/accounts");
const db = require("./services/db");
const { encryptSecret, decryptSecret } = require("./services/crypto");
const config = require("./config");

function rowToUser(row) {
  if (!row) return null;
  return {
    telegramId: row.telegram_id,
    address: row.address,
    buyAmountWei: BigInt(row.buy_amount_wei),
    createdAt: row.created_at,
  };
}

async function getUser(telegramId) {
  const row = await db.one("select * from users where telegram_id = $1", [telegramId]);
  return rowToUser(row);
}

// Creates a fresh EVM key for the user if they have none. Returns
// { user, created }. The private key is never returned from here.
async function createUserWalletIfMissing(telegramId) {
  const existing = await getUser(telegramId);
  if (existing) return { user: existing, created: false };

  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const enc = encryptSecret(privateKey);
  const row = await db.one(
    `insert into users (telegram_id, address, key_iv, key_ct, key_tag, buy_amount_wei)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (telegram_id) do nothing
     returning *`,
    [telegramId, account.address, enc.iv, enc.ct, enc.tag, config.DEFAULT_BUY_WEI.toString()]
  );
  if (!row) return { user: await getUser(telegramId), created: false };
  await db.query(
    "insert into watcher_state (telegram_id, enabled) values ($1, false) on conflict do nothing",
    [telegramId]
  );
  return { user: rowToUser(row), created: true };
}

// Decrypts the user's key and returns a viem account for signing.
async function getAccount(telegramId) {
  const row = await db.one("select key_iv, key_ct, key_tag from users where telegram_id = $1", [telegramId]);
  if (!row || !row.key_ct) throw new Error("No wallet for this user");
  const privateKey = decryptSecret({ iv: row.key_iv, ct: row.key_ct, tag: row.key_tag });
  return privateKeyToAccount(privateKey);
}

// The raw private key, for the Export Key button only.
async function exportPrivateKey(telegramId) {
  const row = await db.one("select key_iv, key_ct, key_tag from users where telegram_id = $1", [telegramId]);
  if (!row || !row.key_ct) throw new Error("No wallet for this user");
  return decryptSecret({ iv: row.key_iv, ct: row.key_ct, tag: row.key_tag });
}

// ethText is the user's decimal string ("0.005"); stored as wei.
async function setBuyAmount(telegramId, ethText) {
  const wei = parseEther(ethText);
  if (wei <= 0n) throw new Error("Buy amount must be positive");
  await db.query("update users set buy_amount_wei = $2 where telegram_id = $1", [telegramId, wei.toString()]);
  return wei;
}

function normalizeAddress(input) {
  const trimmed = String(input || "").trim();
  if (!isAddress(trimmed, { strict: false })) return null;
  return getAddress(trimmed).toLowerCase();
}

// Returns { wallet, added }. Addresses are stored lowercased; duplicates are a no-op.
async function addWatchAddress(telegramId, input) {
  const address = normalizeAddress(input);
  if (!address) throw new Error("INVALID_ADDRESS");
  const row = await db.one(
    `insert into watched_wallets (telegram_id, address) values ($1, $2)
     on conflict (telegram_id, address) do nothing returning *`,
    [telegramId, address]
  );
  if (row) return { wallet: row, added: true };
  const existing = await db.one(
    "select * from watched_wallets where telegram_id = $1 and address = $2",
    [telegramId, address]
  );
  return { wallet: existing, added: false };
}

async function removeWatchAddress(telegramId, input) {
  const address = normalizeAddress(input);
  if (!address) throw new Error("INVALID_ADDRESS");
  const { rowCount } = await db.query(
    "delete from watched_wallets where telegram_id = $1 and address = $2",
    [telegramId, address]
  );
  return rowCount > 0;
}

async function listWatchAddresses(telegramId) {
  return db.many(
    "select id, telegram_id, address, added_at from watched_wallets where telegram_id = $1 order by added_at, id",
    [telegramId]
  );
}

async function getWatchedWallet(id) {
  return db.one("select * from watched_wallets where id = $1", [id]);
}

async function isWatcherEnabled(telegramId) {
  const row = await db.one("select enabled from watcher_state where telegram_id = $1", [telegramId]);
  return Boolean(row && row.enabled);
}

// Conversation slot: a user can only be awaiting one thing at a time. The
// prompt's chat and message id ride along so answering it can delete the
// question (see ui.ask / ui.closePrompt in index.js).
async function setAwaiting(telegramId, awaiting, { chatId = null, msgId = null } = {}) {
  await db.query(
    `insert into conversations (telegram_id, awaiting, prompt_chat_id, prompt_msg_id) values ($1, $2, $3, $4)
     on conflict (telegram_id) do update set awaiting = excluded.awaiting,
       prompt_chat_id = excluded.prompt_chat_id, prompt_msg_id = excluded.prompt_msg_id, updated_at = now()`,
    [telegramId, awaiting, chatId == null ? null : String(chatId), msgId == null ? null : Number(msgId)]
  );
}

async function getAwaiting(telegramId) {
  const row = await getConversation(telegramId);
  return row ? row.awaiting : null;
}

// { awaiting, promptChatId, promptMsgId } or null.
async function getConversation(telegramId) {
  const row = await db.one(
    "select awaiting, prompt_chat_id, prompt_msg_id from conversations where telegram_id = $1",
    [telegramId]
  );
  if (!row) return null;
  return { awaiting: row.awaiting, promptChatId: row.prompt_chat_id, promptMsgId: row.prompt_msg_id };
}

module.exports = {
  getUser,
  createUserWalletIfMissing,
  getAccount,
  exportPrivateKey,
  setBuyAmount,
  normalizeAddress,
  addWatchAddress,
  removeWatchAddress,
  listWatchAddresses,
  getWatchedWallet,
  isWatcherEnabled,
  setAwaiting,
  getAwaiting,
  getConversation,
};
