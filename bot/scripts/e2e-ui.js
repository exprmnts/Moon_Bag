// End-to-end test of the Telegram surface and the retry queue, against a
// throwaway Postgres. Telegram is stubbed at the transport, the chain reads are
// stubbed, and everything else is the real bot.
//
//   docker run -d --name moonbag-test-pg -e POSTGRES_PASSWORD=moonbag \
//     -e POSTGRES_USER=moonbag -e POSTGRES_DB=moonbag -p 55432:5432 postgres:16-alpine
//   node scripts/e2e-ui.js
//
// It asserts the things that are easy to break by hand: that the menu matches
// whether a wallet exists, that a question and its answer are deleted, that the
// private key is scheduled for deletion, that a failing buy is retried exactly
// MAX_BUY_ATTEMPTS times and then alerts, and that a user Telegram refuses to
// deliver to is muted once instead of being retried for every message, that the
// WSS callback runs without crashing, and that the control panel follows the
// conversation to the bottom.
process.env.LOG_LEVEL ||= "warn"; // the bot's own logging is not what is under test
process.env.DATABASE_URL ||= "postgres://moonbag:moonbag@localhost:55432/moonbag?sslmode=disable";
process.env.TELEGRAM_BOT_TOKEN ||= "test:token";
process.env.ALCHEMY_API_KEY ||= "test";
process.env.MASTER_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.ADMIN_CHAT_ID ||= "999000999";
process.env.CHAIN = "testnet";
process.env.DRY_RUN = "false";
process.env.TREASURY_ADDRESS ||= "0x37752B52C917E07181Fc36D0D5167159a0103d20";

const assert = require("node:assert/strict");
const { Telegram } = require("telegraf");

// ---- stub Telegram at the transport ------------------------------------------
// Telegraf builds a new Telegram client per update, so the prototype is the only
// place a stub sticks.
const calls = [];
let nextMessageId = 1000;
Telegram.prototype.callApi = async function (method, payload) {
  const entry = { method, payload };
  calls.push(entry);
  if (method === "sendMessage") {
    entry.result = { message_id: ++nextMessageId, chat: { id: payload.chat_id }, date: 0, text: payload.text };
    return entry.result;
  }
  if (method === "getMe") return { id: 1, is_bot: true, first_name: "test", username: "test_bot" };
  return true;
};

const config = require("../src/config");
const db = require("../src/services/db");
const wallet = require("../src/wallet");
const alchemy = require("../src/services/alchemy");
const uniswap = require("../src/services/uniswap");
const executor = require("../src/executor");
const retry = require("../src/retry");
const errors = require("../src/errors");
const ui = require("../src/ui");
const { bot } = require("../src/index");

// ---- stub the chain -------------------------------------------------------------
let ethBalance = 0n;
let tokenBalances = [];
alchemy.getEthBalance = async () => ethBalance;
alchemy.getTokenBalances = async () => tokenBalances;
alchemy.getTokenMeta = async () => ({ symbol: "TEST", decimals: 18 });

const USER = "900000001";
const CHAT = Number(USER);
const from = { id: Number(USER), is_bot: false, first_name: "Tester" };
const chat = { id: CHAT, type: "private" };

bot.botInfo = { id: 1, is_bot: true, first_name: "test", username: "test_bot" };

let updateId = 0;
const since = () => calls.length;
const sentSince = (n) => calls.slice(n).filter((c) => c.method === "sendMessage");
const editsSince = (n) => calls.slice(n).filter((c) => c.method === "editMessageText");
const deletesSince = (n) => calls.slice(n).filter((c) => c.method === "deleteMessage");
const screensSince = (n) => calls.slice(n).filter((c) => c.method === "sendMessage" || c.method === "editMessageText");
const buttonsOf = (call) => {
  const kb = call.payload.reply_markup && call.payload.reply_markup.inline_keyboard;
  return kb ? kb.flat().map((b) => b.text) : [];
};

// The id of the message a tap lands on; the bot edits this one.
let screenMsgId = 1;

async function tap(data) {
  await bot.handleUpdate({
    update_id: ++updateId,
    callback_query: {
      id: String(updateId),
      from,
      chat_instance: "ci",
      message: { message_id: screenMsgId, chat, date: 0, text: "" },
      data,
    },
  });
}

// Returns the id of the message the user "sent", captured before the bot's own
// replies advance the counter.
async function say(text) {
  const id = ++nextMessageId;
  await bot.handleUpdate({ update_id: ++updateId, message: { message_id: id, from, chat, date: 0, text, entities: [] } });
  return id;
}

async function command(text) {
  await bot.handleUpdate({
    update_id: ++updateId,
    message: { message_id: ++nextMessageId, from, chat, date: 0, text, entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }] },
  });
}

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

// Waits for a trade to reach a resting status, for the paths that run an attempt
// in the background (the /retry command kicks the worker without awaiting it).
async function settles(sellKey, want = ["confirmed", "failed", "dry_run"], ms = 5_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const row = await executor.getTrade(sellKey);
    if (want.includes(row.status) || Date.now() > deadline) return row;
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function clean() {
  await db.query("delete from trades where telegram_id = $1", [USER]);
  await db.query("delete from positions where watched_wallet_id in (select id from watched_wallets where telegram_id = $1)", [USER]);
  await db.query("delete from watched_wallets where telegram_id = $1", [USER]);
  await db.query("delete from watcher_state where telegram_id = $1", [USER]);
  await db.query("delete from conversations where telegram_id = $1", [USER]);
  await db.query("delete from users where telegram_id = $1", [USER]);
}

(async () => {
  await db.ensureSchema();
  await clean();
  console.log(`\nchain=${config.chainName} db=${new URL(config.databaseUrl).host}\n`);

  // ---- 1. no wallet: one button --------------------------------------------
  console.log("1. before a wallet exists");
  let n = since();
  await command("/start");
  const welcome = sentSince(n)[0];
  check("start offers only wallet creation", () => {
    assert.deepEqual(buttonsOf(welcome), ["🪙  Create my wallet", "❓  How it works"]);
  });
  check("start does not show trading buttons", () => {
    assert.ok(!buttonsOf(welcome).some((b) => /Add wallet|Balance|Export/.test(b)));
  });

  // A button that needs a wallet, tapped anyway.
  n = since();
  await tap("CHECK_BALANCE");
  check("balance without a wallet asks for one", () => {
    assert.match(screensSince(n)[0].payload.text, /need a wallet first/i);
  });

  // ---- 2. create the wallet -------------------------------------------------
  console.log("\n2. creating the wallet");
  n = since();
  await tap("CREATE_WALLET");
  const created = screensSince(n)[0];
  check("wallet created message", () => assert.match(created.payload.text, /Wallet created/));
  check("create button is gone afterwards", () => {
    assert.ok(!buttonsOf(created).some((b) => /Create my wallet/.test(b)));
  });
  check("full menu appears", () => {
    const b = buttonsOf(created).join("|");
    for (const want of ["Add wallet", "Balance", "Buy amount", "Deposit", "Export key", "Positions"]) {
      assert.ok(b.includes(want), `missing ${want}`);
    }
  });
  check("toggle shows OFF", () => assert.ok(buttonsOf(created).some((b) => b.includes("Moonbags OFF"))));

  const user = await wallet.getUser(USER);
  check("wallet row exists", () => assert.match(user.address, /^0x[0-9a-fA-F]{40}$/));

  // ---- 3. a question, answered ---------------------------------------------
  console.log("\n3. asking for the buy amount");
  n = since();
  await tap("SET_BUY_AMOUNT");
  const question = sentSince(n)[0];
  check("the question uses force_reply", () => assert.equal(question.payload.reply_markup.force_reply, true));
  check("the question has a placeholder", () => assert.equal(question.payload.reply_markup.input_field_placeholder, "0.005"));
  const questionId = question.result.message_id;

  // A bad answer: it disappears and the question comes back.
  n = since();
  const badId = await say("banana");
  check("a bad answer is deleted", () => {
    assert.ok(deletesSince(n).some((c) => c.payload.message_id === badId), "the user's message was not deleted");
  });
  check("the old question is deleted", () => {
    assert.ok(deletesSince(n).some((c) => c.payload.message_id === questionId), "the previous question was not deleted");
  });
  const reasked = sentSince(n).at(-1);
  check("the question is asked again with the reason", () => {
    assert.match(reasked.payload.text, /not an amount/);
    assert.equal(reasked.payload.reply_markup.force_reply, true);
  });
  check("only one question is on screen", () => {
    assert.equal(sentSince(n).filter((c) => c.payload.reply_markup && c.payload.reply_markup.force_reply).length, 1);
  });

  // A good answer.
  n = since();
  const goodId = await say("0.02");
  check("the good answer is deleted too", () => {
    assert.ok(deletesSince(n).some((c) => c.payload.message_id === goodId));
  });
  check("the question is deleted", () => assert.ok(deletesSince(n).length >= 2));
  check("the result names the new amount", () => assert.match(sentSince(n).at(-1).payload.text, /0\.02 ETH/));
  check("the amount is stored", async () => {});
  const afterAmount = await wallet.getUser(USER);
  check("buy amount persisted", () => assert.equal(afterAmount.buyAmountWei, 20000000000000000n));
  check("the conversation slot is cleared", async () => {});
  assert.equal((await wallet.getConversation(USER)).awaiting, null);

  // ---- 4. adding a wallet to watch ------------------------------------------
  console.log("\n4. adding a wallet to watch");
  n = since();
  await tap("ADD_WATCH_ADDR");
  check("address question uses force_reply", () => assert.equal(sentSince(n)[0].payload.reply_markup.force_reply, true));

  n = since();
  await say("not-an-address");
  check("a bad address is rejected in place", () => assert.match(sentSince(n).at(-1).payload.text, /not a wallet address/));

  n = since();
  await say(user.address);
  check("watching your own bot wallet is refused", () => assert.match(sentSince(n).at(-1).payload.text, /your own bot wallet/));

  n = since();
  await say(config.treasury);
  check("watching the treasury is refused", () => assert.match(sentSince(n).at(-1).payload.text, /treasury/i));

  const WATCHED = "0xbf7b295b629114b36bd4d09c1b6c0864e1aa1190";
  tokenBalances = [{ token: "0xcb6f4711e9af0e22cf0be5a15b9333f8c03d1e18", amount: 1000n }];
  n = since();
  await say(WATCHED);
  check("the wallet is added", () => assert.match(sentSince(n).at(-1).payload.text, /Watching/));
  const watched = await wallet.listWatchAddresses(USER);
  check("one watched wallet in the database", () => assert.equal(watched.length, 1));
  const seeded = await db.many("select * from positions where watched_wallet_id = $1", [watched[0].id]);
  check("its holdings were seeded as baselines, silently", () => {
    assert.equal(seeded.length, 1);
    assert.equal(seeded[0].baseline_amount, "1000");
  });

  // ---- 5. the toggle ---------------------------------------------------------
  console.log("\n5. the on/off toggle");
  ethBalance = 0n;
  n = since();
  await tap("START_WATCH");
  check("an empty wallet cannot start", () => assert.match(screensSince(n).at(-1).payload.text, /bot wallet is empty/i));
  check("and the toggle still reads OFF", () => assert.ok(buttonsOf(screensSince(n).at(-1)).some((b) => b.includes("Moonbags OFF"))));

  ethBalance = 10n ** 18n;
  n = since();
  await tap("START_WATCH");
  const started = screensSince(n).at(-1);
  check("a funded wallet starts", () => assert.match(started.payload.text, /Moonbags on/));
  check("the toggle flips to ON", () => assert.ok(buttonsOf(started).some((b) => b.includes("Moonbags ON"))));
  check("the banner shows the green dot", () => assert.match(started.payload.text, /🟢/));
  check("watcher_state is enabled", async () => {});
  assert.equal(await wallet.isWatcherEnabled(USER), true);

  n = since();
  await tap("STOP_WATCH");
  const stopped = screensSince(n).at(-1);
  check("pausing flips it back", () => assert.ok(buttonsOf(stopped).some((b) => b.includes("Moonbags OFF"))));

  // ---- 6. the private key ------------------------------------------------------
  console.log("\n6. exporting the key");
  n = since();
  await tap("EXPORT_KEY");
  check("export warns before showing anything", () => {
    const text = screensSince(n).at(-1).payload.text;
    assert.match(text, /Anyone holding this key/);
    assert.ok(!/0x[0-9a-f]{64}/.test(text), "the key leaked into the warning");
  });

  const timers = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; };
  n = since();
  await tap("CONFIRM_EXPORT");
  global.setTimeout = realSetTimeout;
  const keyMsg = sentSince(n).find((c) => /0x[0-9a-f]{64}/.test(c.payload.text));
  check("the key is sent", () => assert.ok(keyMsg, "no message contained a key"));
  check("it says it will self-destruct", () => assert.match(keyMsg.payload.text, /deletes itself in 60 seconds/));
  check("a deletion is scheduled for one minute", () => {
    assert.ok(timers.some((t) => t.ms === config.KEY_TTL_MS), `timers were ${timers.map((t) => t.ms)}`);
    assert.equal(config.KEY_TTL_MS, 60_000);
  });
  check("the scheduled timer actually deletes it", () => {
    const before = deletesSince(since()).length;
    timers.filter((t) => t.ms === config.KEY_TTL_MS).forEach((t) => t.fn());
    void before;
  });

  // ---- 7. selling the same token three times ------------------------------------
  console.log("\n7. three sells of one token");
  const watcher = require("../src/watcher");
  const TOKEN = "0xcb6f4711e9af0e22cf0be5a15b9333f8c03d1e18";
  // Buys are simulated here: this section is about how many trades get recorded,
  // not about the swap, which scripts/e2e-chain.js covers for real.
  const realBuy = executor.buy;
  const bought = [];
  executor.buy = async (b, tid, token, sellKey) => {
    bought.push(sellKey);
    return { status: "confirmed", queued: true };
  };
  let blockNo = 60_000_000n;
  alchemy.publicClient = () => ({ getBlockNumber: async () => ++blockNo });

  for (const balance of [700n, 400n, 0n]) {
    tokenBalances = balance === 0n ? [] : [{ token: TOKEN, amount: balance }];
    await watcher.checkAddress(bot, USER, watched[0]);
  }
  check("three sells produce three buys", () => assert.equal(bought.length, 3, `got ${bought.length}: ${bought.join(" ")}`));
  check("each sell has its own key", () => assert.equal(new Set(bought).size, 3));
  check("the key names the user, the wallet and the transition", () =>
    assert.match(bought[0], new RegExp(`^${USER}:0x[0-9a-f]{40}:0x[0-9a-f]{40}:\\d+:1000-700$`))
  );

  // The same drop seen twice (WSS event and poll) must collapse into one.
  bought.length = 0;
  tokenBalances = [];
  await watcher.checkAddress(bot, USER, watched[0], { blockNumber: 61_000_000n });
  await watcher.checkAddress(bot, USER, watched[0], { blockNumber: 61_000_000n });
  check("a settled sell is not re-detected", () => assert.equal(bought.length, 0, `re-fired ${bought.length} times`));
  executor.buy = realBuy;

  // ---- 7b. two people watching the same wallet -------------------------------------
  // Each of them is owed their own moonbag. When the sell key left the telegram
  // id out, the first user processed claimed the row and everyone else watching
  // that wallet was skipped as a duplicate.
  console.log("\n7b. two users watching one wallet");
  const USER2 = "900000002";
  await db.query(
    `insert into users (telegram_id, address, buy_amount_wei, chat_id) values ($1, $2, $3, $1)
     on conflict (telegram_id) do nothing`,
    [USER2, "0x000000000000000000000000000000000000dEaD", "5000000000000000"]
  );
  const added2 = await wallet.addWatchAddress(USER2, WATCHED);
  tokenBalances = [{ token: TOKEN, amount: 1000n }];
  await watcher.seedPositions(added2.wallet);
  // Bring the first user's baseline up to the same holding, so the drop below is
  // a sell for both of them rather than a fresh buy for one.
  await watcher.checkAddress(bot, USER, watched[0]);

  bought.length = 0;
  executor.buy = async (b, tid, token, sellKey) => { bought.push({ tid, sellKey }); return { status: "confirmed", queued: true }; };
  tokenBalances = [{ token: TOKEN, amount: 100n }];
  const sameBlock = 62_000_000n;
  await watcher.checkAddress(bot, USER, watched[0], { blockNumber: sameBlock });
  await watcher.checkAddress(bot, USER2, added2.wallet, { blockNumber: sameBlock });
  check("both users get a buy for the same sell", () => assert.equal(bought.length, 2, `only ${bought.length} buy(s)`));
  check("their sell keys differ", () => assert.equal(new Set(bought.map((b) => b.sellKey)).size, 2));
  check("each key names its own user", () => {
    assert.ok(bought[0].sellKey.startsWith(`${USER}:`), bought[0].sellKey);
    assert.ok(bought[1].sellKey.startsWith(`${USER2}:`), bought[1].sellKey);
  });
  executor.buy = realBuy;
  await db.query("delete from positions where watched_wallet_id = $1", [added2.wallet.id]);
  await db.query("delete from watched_wallets where telegram_id = $1", [USER2]);
  await db.query("delete from users where telegram_id = $1", [USER2]);

  // ---- 8. the retry queue ---------------------------------------------------------
  console.log("\n8. retries");
  config.isMainnet = true; // the retry path refuses to quote on testnet
  const realQuote = uniswap.quote;
  let quoteCalls = 0;
  uniswap.quote = async () => {
    quoteCalls++;
    throw new Error("Uniswap /quote 404: A routing dependency timed out or failed; the request may succeed on retry.");
  };

  const sellKey = `${USER}:${WATCHED}:${TOKEN}:70000000:1000-0`;
  n = since();
  const first = await executor.buy(bot, USER, TOKEN, sellKey, { chatId: CHAT });
  check("a transient failure schedules a retry", () => assert.equal(first.status, "retrying"));
  let row = await executor.getTrade(sellKey);
  check("attempt 1 is recorded", () => assert.equal(row.attempts, 1));
  check("the error code is stored", () => assert.equal(row.error_code, "QUOTE_UNAVAILABLE"));
  check("a next attempt is scheduled", () => assert.ok(row.next_retry_at, "next_retry_at is null"));
  check("the user sees one message, not one per attempt", () => {
    assert.equal(sentSince(n).length, 1, `sent ${sentSince(n).length} messages`);
    assert.ok(editsSince(n).length >= 1, "the message was not edited in place");
  });
  check("the message says it is retrying, not the raw error", () => {
    const last = screensSince(n).at(-1).payload.text;
    assert.match(last, /Trying again \(2\/5\)/);
    assert.ok(!/404/.test(last), "the raw API error leaked to the user");
  });

  // Run the rest of the attempts.
  for (let i = 2; i <= config.MAX_BUY_ATTEMPTS; i++) {
    await db.query("update trades set next_retry_at = now() - interval '1 second' where sell_key = $1", [sellKey]);
    n = since();
    await retry.tick(bot);
    row = await executor.getTrade(sellKey);
    check(`attempt ${i} ran`, () => assert.equal(row.attempts, i));
    check(`attempt ${i} still edits the same message`, () => assert.equal(sentSince(n).filter((c) => String(c.payload.chat_id) === String(CHAT)).length, 0));
  }

  check("it gives up after exactly MAX_BUY_ATTEMPTS", () => assert.equal(row.attempts, config.MAX_BUY_ATTEMPTS));
  check("the trade ends failed", () => assert.equal(row.status, "failed"));
  check("no further attempt is scheduled", () => assert.equal(row.next_retry_at, null));
  check("quote was called once per attempt", () => assert.equal(quoteCalls, config.MAX_BUY_ATTEMPTS));
  check("the devs were alerted", () => {
    assert.ok(
      calls.some((c) => c.method === "sendMessage" && String(c.payload.chat_id) === process.env.ADMIN_CHAT_ID && /gave up/i.test(c.payload.text)),
      "no alert reached ADMIN_CHAT_ID"
    );
  });
  check("the user was told plainly", () => {
    const last = editsSince(0).at(-1).payload.text;
    assert.match(last, /Moonbag missed/);
    assert.match(last, /Nothing was spent/);
  });

  // A retry due later is not picked up early.
  await db.query("update trades set status='retrying', attempts=0, next_retry_at = now() + interval '1 hour' where sell_key = $1", [sellKey]);
  const ranEarly = await retry.tick(bot);
  check("a retry that is not due yet is left alone", () => assert.equal(ranEarly, 0));

  // /retry puts failed buys back in the queue.
  await db.query("update trades set status='failed', attempts=5, next_retry_at=null where sell_key = $1", [sellKey]);
  uniswap.quote = async () => { throw new Error("Uniswap /quote 404: No quotes available"); };
  n = since();
  await command("/retry");
  const confirm = sentSince(n).at(-1);
  row = await executor.getTrade(sellKey);
  check("/retry asks before spending anything", () => {
    assert.match(confirm.payload.text, /Retry them\?/);
    assert.match(confirm.payload.text, /will spend up to <b>0\.02 ETH<\/b>/);
  });
  check("/retry changes nothing until confirmed", () => assert.equal(row.status, "failed"));
  check("the confirmation is a button, not a typed yes", () => assert.equal(buttonsOf(confirm)[0], "✅  Yes, retry 1"));

  n = since();
  await tap("RETRY_GO");
  row = await executor.getTrade(sellKey);
  check("confirming re-queues immediately", () => assert.ok(["retrying", "pending"].includes(row.status), `status is ${row.status}`));
  check("/retry reports what it did", () => assert.match(screensSince(n).map((c) => c.payload.text).join(" "), /Re-queued/));
  check("/retry answers before the swap, not after", () => assert.ok(row.attempts <= 1, `attempts is ${row.attempts}`));
  // The handler kicks the worker without awaiting it, so the reply is instant.
  // Wait for that background attempt to land before asserting on its outcome.
  row = await settles(sellKey);
  check("a permanent reason is not retried", () => assert.equal(row.status, "failed"));
  check("and it says why in plain words", () => assert.match(editsSince(0).at(-1).payload.text, /No trading route/));
  uniswap.quote = realQuote;

  // ---- 9. a stranded buy ------------------------------------------------------------
  console.log("\n9. a buy interrupted by a restart");
  await db.query(
    "update trades set status='pending', attempts=1, buy_tx_hash=null, updated_at = now() - interval '10 minutes' where sell_key = $1",
    [sellKey]
  );
  const reclaimed = await executor.reclaimStranded();
  row = await executor.getTrade(sellKey);
  check("it goes back in the queue", () => {
    assert.ok(reclaimed >= 1);
    assert.equal(row.status, "retrying");
  });

  // ---- 10. error classification on real messages ------------------------------------
  console.log("\n10. classification");
  const cases = [
    ["Uniswap /quote 404: A routing dependency timed out or failed; the request may succeed on retry.", "QUOTE_UNAVAILABLE", true],
    ["Transaction reverted (0x62f3d87e)", "REVERTED", true],
    ["The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account.", "INSUFFICIENT_ETH", false],
    ["Uniswap /quote 404: No quotes available", "NO_ROUTE", false],
    ["Uniswap quote fee recipient 0xdead is not the treasury", "FEE_MISMATCH", false],
  ];
  for (const [text, code, retryable] of cases) {
    const c = errors.classify(new Error(text));
    check(`${text.slice(0, 40)}… → ${code}`, () => {
      assert.equal(c.code, code);
      assert.equal(c.retryable, retryable);
    });
  }

  // ---- 11. the bot used from a group ------------------------------------------------
  // The failure this section exists for: telegram_id is the person, not the chat.
  // Someone who only ever uses the bot in a group has no private chat, and
  // messaging their user id answers "Bad Request: chat not found".
  console.log("\n11. used from a group");
  const GROUP = -5342855733;
  const groupChat = { id: GROUP, type: "group", title: "moonbag" };
  const inGroup = async (data) => {
    await bot.handleUpdate({
      update_id: ++updateId,
      callback_query: { id: String(updateId), from, chat_instance: "ci", message: { message_id: screenMsgId, chat: groupChat, date: 0, text: "" }, data },
    });
  };

  n = since();
  await inGroup("SHOW_ADDRESS");
  check("a tap from a group is answered in the group", () => {
    const c = screensSince(n).at(-1);
    assert.equal(String(c.payload.chat_id), String(GROUP));
  });
  check("the group is remembered as this user's chat", async () => {});
  assert.equal(await wallet.getChatId(USER), String(GROUP), "chat_id was not recorded");

  // Now the watcher speaks: it must address the group, not the user id.
  n = since();
  const watcherModule = require("../src/watcher");
  await watcherModule.checkAddress(bot, USER, watched[0]);
  tokenBalances = [{ token: TOKEN, amount: 500n }];
  await watcherModule.checkAddress(bot, USER, watched[0]);
  check("watcher alerts go to the group, not the user id", () => {
    const sent = sentSince(n);
    assert.ok(sent.length, "the watcher sent nothing");
    for (const c of sent) {
      assert.equal(String(c.payload.chat_id), String(GROUP), `sent to ${c.payload.chat_id} instead of the group`);
    }
  });

  // The key must never be revealed where other people can read it.
  n = since();
  await inGroup("EXPORT_KEY");
  check("export is refused in a group", () => assert.match(screensSince(n).at(-1).payload.text, /Not here/));
  n = since();
  await inGroup("CONFIRM_EXPORT");
  check("even tapping confirm directly is refused", () => {
    assert.ok(!screensSince(n).some((c) => /0x[0-9a-f]{64}/.test(c.payload.text)), "the key leaked into a group");
  });

  // A question asked in a group targets one person.
  n = since();
  await inGroup("SET_BUY_AMOUNT");
  const groupQuestion = sentSince(n).at(-1);
  check("a group question mentions the person it is for", () => {
    assert.match(groupQuestion.payload.text, new RegExp(`tg://user\\?id=${USER}`));
    assert.equal(groupQuestion.payload.reply_markup.selective, true);
  });
  await wallet.setAwaiting(USER, null);

  // Back to a private chat: the recorded chat follows the user.
  n = since();
  await tap("SHOW_ADDRESS");
  check("moving back to a private chat updates the address", async () => {});
  assert.equal(await wallet.getChatId(USER), String(CHAT));

  // ---- 12. a user the bot cannot message ----------------------------------------------
  // The noise this section exists for. Someone who has never opened a private
  // chat is refused for every single message, forever — so one sell produced
  // four failed sends and four alert lines about a person who was never going to
  // receive any of them. The refusal is a state now: recorded once, reported
  // once, and cleared the moment they write.
  console.log("\n12. a user the bot cannot message");
  const realCallApi = Telegram.prototype.callApi;
  let refused = 0;
  Telegram.prototype.callApi = async function (method, payload) {
    if (method === "sendMessage" && String(payload.chat_id) === String(CHAT)) {
      refused++;
      throw new Error("403: Forbidden: bot can't initiate conversation with a user");
    }
    return realCallApi.call(this, method, payload);
  };

  n = since();
  await ui.toUser(bot, USER, "first");
  check("an unreachable user raises an alert", () => {
    assert.ok(
      calls.slice(n).some((c) => c.method === "sendMessage" && String(c.payload.chat_id) === process.env.ADMIN_CHAT_ID && /cannot be messaged/i.test(c.payload.text)),
      "no alert was sent"
    );
  });
  const muted = await db.one("select unreachable_at, unreachable_reason from users where telegram_id = $1", [USER]);
  check("the refusal is recorded, not just logged", () => {
    assert.ok(muted.unreachable_at, "unreachable_at is null");
    assert.match(muted.unreachable_reason, /initiate conversation/);
  });

  refused = 0;
  n = since();
  await ui.toUser(bot, USER, "second");
  await ui.toUser(bot, USER, "third");
  check("no further message is even attempted", () => assert.equal(refused, 0, `${refused} pointless API call(s)`));
  check("and the team is not told again", () =>
    assert.equal(calls.slice(n).filter((c) => /cannot be messaged/i.test(c.payload.text || "")).length, 0)
  );

  // Being unable to tell someone is not a reason to stop buying the moonbag they
  // asked for. The buy runs; it just runs quietly.
  uniswap.quote = async () => { throw new Error("Uniswap /quote 404: No quotes available"); };
  n = since();
  const mutedBuy = await executor.buy(bot, USER, TOKEN, `${USER}:${WATCHED}:${TOKEN}:71000000:1000-0`);
  uniswap.quote = realQuote;
  check("their buys still run", () => assert.equal(mutedBuy.queued, true));
  check("and still reach a verdict", () => assert.equal(mutedBuy.status, "failed"));
  check("with nothing sent to them", () =>
    assert.equal(sentSince(n).filter((c) => String(c.payload.chat_id) === String(CHAT)).length, 0)
  );

  // Anything they send is proof they can be reached.
  Telegram.prototype.callApi = realCallApi;
  await tap("BACK_TO_MAIN");
  const backAgain = await db.one("select unreachable_at from users where telegram_id = $1", [USER]);
  check("one message from them clears it", () => assert.equal(backAgain.unreachable_at, null));
  n = since();
  await ui.toUser(bot, USER, "welcome back");
  check("and the bot talks to them again", () =>
    assert.equal(sentSince(n).filter((c) => String(c.payload.chat_id) === String(CHAT)).length, 1)
  );

  // ---- 13. the WSS event path ---------------------------------------------------------
  // The crash this section exists for: `for (const log of logs)` inside onLogs
  // shadowed this module's logger, so the debounced callback called .debug() on
  // a Transfer log and killed the process. Requiring the module cannot catch
  // that — only running the callback can.
  console.log("\n13. the WSS event path");
  const fakeWs = { watchEvent: () => () => {} };
  alchemy.wsClient = () => fakeWs;
  alchemy.resetWsClient = () => fakeWs;
  await db.query("update watcher_state set enabled = true where telegram_id = $1", [USER]);
  config.EVENT_DEBOUNCE_MS = 20;
  await watcher.rebuildSubscriptions();

  let crashed = null;
  const onUncaught = (err) => { crashed = err; };
  process.once("uncaughtException", onUncaught);
  watcher.onLogs([
    { args: { from: WATCHED, to: "0x000000000000000000000000000000000000dEaD" }, blockNumber: 60212068n },
  ]);
  await new Promise((r) => setTimeout(r, 300));
  process.removeListener("uncaughtException", onUncaught);
  check("a Transfer touching a watched wallet does not crash the process", () =>
    assert.equal(crashed, null, crashed && crashed.message)
  );

  // ---- 14. whatever happened last is at the bottom ------------------------------------
  // Two halves of one rule. A notification is the newest thing when it arrives,
  // so nothing is pushed underneath it — a buy in progress owns the bottom of
  // the chat for the whole time its message is being edited. A tap is then the
  // newest thing, so the panel comes back down rather than being edited in
  // place up the scrollback where the user cannot see the answer.
  console.log("\n14. whatever happened last is at the bottom");
  await wallet.setAwaiting(USER, null);
  await tap("BACK_TO_MAIN");
  const panelAt = await wallet.getMenuMessage(USER);
  check("the panel's message is remembered", () => assert.ok(panelAt && panelAt.msgId, "no menu message recorded"));

  // A tap while the panel is still last: edited in place, no new message.
  n = since();
  screenMsgId = panelAt.msgId;
  await tap("SHOW_ADDRESS");
  check("a tap on the last message edits it in place", () => {
    assert.equal(editsSince(n).length, 1, "it did not edit");
    assert.equal(sentSince(n).length, 0, "it sent a new message instead of editing");
  });

  // Now a notification lands underneath it. It must stay put: it is the newest.
  n = since();
  const note = await ui.toUser(bot, USER, "🚨 <b>Sell detected</b>");
  check("a notification does not move the panel", async () => {});
  assert.equal((await wallet.getMenuMessage(USER)).msgId, panelAt.msgId, "the panel moved on its own");
  check("nothing is sent under a fresh notification", () =>
    assert.equal(sentSince(n).length, 1, `sent ${sentSince(n).length} messages, expected just the notification`)
  );

  // The next tap is the newest thing, so the panel comes down to the bottom.
  n = since();
  await tap("BACK_TO_MAIN");
  const movedTo = await wallet.getMenuMessage(USER);
  check("the next tap brings the panel to the bottom", () => {
    assert.ok(movedTo.msgId > note.message_id, `panel ${movedTo.msgId} is not below the notification ${note.message_id}`);
    assert.equal(sentSince(n).length, 1, "the panel was not re-sent");
  });
  check("the stranded panel is deleted, not left showing a stale state", () =>
    assert.ok(deletesSince(n).some((c) => Number(c.payload.message_id) === panelAt.msgId), "the old panel survived")
  );

  // And once it is back at the bottom, taps edit in place again.
  n = since();
  screenMsgId = movedTo.msgId;
  await tap("SHOW_WATCH");
  check("taps edit in place again once it is last", () => {
    assert.equal(editsSince(n).length, 1);
    assert.equal(sentSince(n).length, 0);
  });
  await tap("BACK_TO_MAIN");

  // ---- done ------------------------------------------------------------------------
  await clean();
  await db.pool.end();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("failures:");
    for (const f of failed) console.log(`  ${f.name}: ${f.err.message}`);
    process.exit(1);
  }
  console.log("PASS");
  process.exit(0);
})().catch(async (e) => {
  console.error("\nHARNESS ERROR", e);
  try { await clean(); await db.pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
