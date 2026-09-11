// Users, their encrypted keys, buy amounts, watched wallets and the
// one-slot conversation state. All persistence goes through services/db.
const { isAddress, parseEther, getAddress } = require("viem");
const { generatePrivateKey, privateKeyToAccount } = require("viem/accounts");
const db = require("./services/db");
const { encryptSecret, decryptSecret, masterKeyFingerprint } = require("./services/crypto");
const config = require("./config");

function rowToUser(row) {
  if (!row) return null;
  return {
    telegramId: row.telegram_id,
    address: row.address,
    buyAmountWei: BigInt(row.buy_amount_wei),
    chatId: row.chat_id || null,
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

// ---- where to message this user ------------------------------------------------
// telegram_id identifies the person; chat_id is the conversation. They are the
// same in a private chat and different in a group, and a person who has only
// ever used the bot in a group has no private chat to receive anything — so
// sending to telegram_id fails with "chat not found". Every update refreshes
// this, and every outbound message reads it.
//
// A route also carries whether Telegram has already refused delivery. That
// refusal is permanent until the user comes back, so it is remembered: without
// it, one sell produced four failed sends and four alert lines for a user who
// was never going to receive any of them.
const routes = new Map(); // telegramId -> { chatId, blocked }

async function routeFor(telegramId) {
  const cached = routes.get(telegramId);
  if (cached) return cached;
  const row = await db.one("select chat_id, unreachable_at from users where telegram_id = $1", [telegramId]);
  // The fallback is right for everyone who uses the bot in a private chat,
  // including users who predate the column.
  const route = { chatId: (row && row.chat_id) || String(telegramId), blocked: Boolean(row && row.unreachable_at) };
  routes.set(telegramId, route);
  return route;
}

// Called for every update, before anything else. Returns true when this update
// is what made a previously unreachable user reachable again — the one moment
// worth a log line.
async function rememberChat(telegramId, chatId) {
  if (chatId == null) return false;
  const value = String(chatId);
  const known = routes.get(telegramId);
  if (known && known.chatId === value && !known.blocked) return false;
  const recovered = Boolean(known && known.blocked);
  routes.set(telegramId, { chatId: value, blocked: false });
  // Hearing from someone is proof they can be reached, so the same write clears
  // the block. Conditional, so the common case costs nothing.
  await db.query(
    `update users set chat_id = $2, unreachable_at = null, unreachable_reason = null
     where telegram_id = $1 and (coalesce(chat_id, '') is distinct from $2 or unreachable_at is not null)`,
    [telegramId, value]
  );
  return recovered;
}

async function getChatId(telegramId) {
  return (await routeFor(telegramId)).chatId;
}

// Records that Telegram will not deliver to this user. Returns true only the
// first time, which is what keeps the alert from repeating: the condition is
// stored, so a restart does not re-announce it either.
async function markUnreachable(telegramId, reason) {
  const route = routes.get(telegramId);
  if (route) route.blocked = true;
  const row = await db.one(
    `update users set unreachable_at = now(), unreachable_reason = $2
     where telegram_id = $1 and unreachable_at is null returning telegram_id`,
    [telegramId, String(reason || "").slice(0, 200)]
  );
  return Boolean(row);
}

function forgetChat(telegramId) {
  routes.delete(telegramId);
}

// ---- where the control panel is ------------------------------------------------
// One message with the buttons on it, edited in place. Remembering which one
// lets the bot delete it and re-send it at the bottom when notifications have
// pushed it up the chat.
async function setMenuMessage(telegramId, chatId, msgId) {
  await db.query("update users set menu_chat_id = $2, menu_msg_id = $3 where telegram_id = $1", [
    telegramId,
    chatId == null ? null : String(chatId),
    msgId == null ? null : Number(msgId),
  ]);
}

async function getMenuMessage(telegramId) {
  const row = await db.one("select menu_chat_id, menu_msg_id from users where telegram_id = $1", [telegramId]);
  if (!row || row.menu_msg_id == null) return null;
  return { chatId: row.menu_chat_id, msgId: Number(row.menu_msg_id) };
}

// Decrypts the user's key and returns a viem account for signing.
async function getAccount(telegramId) {
  const row = await db.one("select key_iv, key_ct, key_tag from users where telegram_id = $1", [telegramId]);
  if (!row || !row.key_ct) throw new Error("No wallet for this user");
  const privateKey = decryptSecret({ iv: row.key_iv, ct: row.key_ct, tag: row.key_tag });
  return privateKeyToAccount(privateKey);
}

// ---- does this process hold the right master key? ------------------------------
// A wallet is sealed under MASTER_ENCRYPTION_KEY at creation and can only be
// opened by the same one, so a deploy carrying the wrong key cannot sign for
// anyone — and says nothing about it until the first buy dies. That is exactly
// what happened on 2026-09-11: the key in Railway was not the key the wallets
// were written with, and the only symptom was two users' buys failing with six
// words of node crypto prose. This turns that into a failed boot.
//
// Checks the most recent wallets rather than all of them: a wrong key fails on
// every row, and a key changed mid-life shows up in the newest ones first.
const KEY_CHECK_SAMPLE = 200;

async function checkMasterKey() {
  const rows = await db.many(
    `select key_iv, key_ct, key_tag from users where key_ct is not null order by created_at desc limit ${KEY_CHECK_SAMPLE}`
  );
  let opened = 0;
  const failed = [];
  for (const row of rows) {
    try {
      decryptSecret({ iv: row.key_iv, ct: row.key_ct, tag: row.key_tag });
      opened += 1;
    } catch {
      failed.push(row);
    }
  }
  return { checked: rows.length, opened, failed: failed.length, fingerprint: masterKeyFingerprint() };
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
  rememberChat,
  routeFor,
  getChatId,
  markUnreachable,
  forgetChat,
  setMenuMessage,
  getMenuMessage,
  createUserWalletIfMissing,
  checkMasterKey,
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
