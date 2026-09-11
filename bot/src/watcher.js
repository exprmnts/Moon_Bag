// Watches the wallets users asked about. Two triggers run the same check:
// an ERC-20 Transfer log involving a watched wallet (WSS, immediate) and a
// 60-second poll (backstop). Checks for one watched wallet are serialised so
// the two triggers can never race into a double buy.
const { parseAbiItem, getAddress } = require("viem");
const config = require("./config");
const db = require("./services/db");
const wallet = require("./wallet");
const alchemy = require("./services/alchemy");
const { decide } = require("./decide");
const executor = require("./executor");
const alerts = require("./services/alerts");
const ui = require("./ui");

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---- in-process state -------------------------------------------------------
const watchers = new Map(); // telegramId -> { since }
let botRef = null;
let pollTimer = null;
let polling = false;
const subs = { unwatch: [], healthy: false, addresses: new Set() };
const locks = new Map(); // watched_wallet_id -> tail of the promise chain
const debounces = new Map(); // watched address -> { timer, blockNumber }

function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key, next);
  next.finally(() => { if (locks.get(key) === next) locks.delete(key); }).catch(() => {});
  return next;
}

// Addressed to the user, not to a chat id: ui.toUser works out which chat that
// means (a group, for someone who has never opened a private chat).
async function send(telegramId, text) {
  if (!botRef) return null;
  return ui.toUser(botRef, telegramId, text);
}

async function tokenLabel(token) {
  const meta = await alchemy.getTokenMeta(token);
  return {
    name: meta.symbol ? esc(meta.symbol) : alchemy.shortAddress(token),
    fmt: (amount) => alchemy.formatAmount(amount, meta.decimals),
  };
}

// ---- positions ----------------------------------------------------------------
async function loadBaselines(watchedWalletId) {
  const rows = await db.many("select token, baseline_amount from positions where watched_wallet_id = $1", [watchedWalletId]);
  return new Map(rows.map((r) => [r.token, BigInt(r.baseline_amount)]));
}

async function setBaseline(watchedWalletId, token, amount) {
  await db.query(
    `insert into positions (watched_wallet_id, token, baseline_amount) values ($1, $2, $3)
     on conflict (watched_wallet_id, token) do update set baseline_amount = excluded.baseline_amount, updated_at = now()`,
    [watchedWalletId, token, amount.toString()]
  );
}

// Records the current balances as the baseline without messaging anyone.
// Used when a wallet is first added, so existing holdings are not "buys".
async function seedPositions(watchedWallet) {
  return withLock(watchedWallet.id, async () => {
    const current = await alchemy.getTokenBalances(watchedWallet.address);
    for (const t of current) await setBaseline(watchedWallet.id, t.token, t.amount);
    return current.length;
  });
}

// ---- the check ----------------------------------------------------------------
// Compares live balances of one watched wallet against its baselines, messages
// the user about changes, buys on a sell, and moves the baselines. Returns the
// list of decisions (used by the smoke script).
async function checkAddress(bot, telegramId, watchedWallet, { blockNumber } = {}) {
  if (bot) botRef = bot;
  return withLock(watchedWallet.id, async () => {
    const user = await wallet.getUser(telegramId);
    if (!user) return [];
    const addr = watchedWallet.address;

    const [current, baselines] = await Promise.all([
      alchemy.getTokenBalances(addr),
      loadBaselines(watchedWallet.id),
    ]);
    const currentMap = new Map(current.map((t) => [t.token, t.amount]));
    const tokens = new Set([...baselines.keys(), ...currentMap.keys()]);
    const decisions = [];
    let block = blockNumber;

    for (const token of tokens) {
      const base = baselines.has(token) ? baselines.get(token) : null;
      const now = currentMap.get(token) ?? 0n;
      const d = decide(base, now);
      decisions.push({ token, kind: d.kind, dropPct: d.dropPct, baseline: base, current: now });
      if (d.kind === "none") continue;

      const { name, fmt } = await tokenLabel(token);
      const short = alchemy.shortAddress(addr);

      if (d.kind === "new") {
        await send(telegramId, `📈 <b>Buy detected</b> · <code>${short}</code>\n<b>${name}</b> — ${fmt(now)} (new)`);
        await setBaseline(watchedWallet.id, token, now);
        continue;
      }
      if (d.kind === "up") {
        await send(telegramId, `📈 <b>Buy detected</b> · <code>${short}</code>\n<b>${name}</b> — +${fmt(now - base)} (now ${fmt(now)})`);
        await setBaseline(watchedWallet.id, token, now);
        continue;
      }

      // A sell. The key has to be unique per *user*, per sell:
      //
      //   <telegramId> several people may watch the same trading wallet, and each
      //                one is owed their own moonbag. Without this they collide and
      //                only whoever is processed first gets a buy.
      //   <address>    which watched wallet sold, for the message.
      //   <token>
      //   <block>
      //   <before-after> the exact balance transition, so selling the same token
      //                three times is three sells, while the WSS event and the
      //                poll seeing one drop still build one key and collapse.
      if (block == null) block = await alchemy.publicClient().getBlockNumber();
      const sellKey = `${telegramId}:${addr}:${token}:${block}:${base}-${now}`;
      // The baseline moves as soon as the sell is recorded. From that moment the
      // trades row owns the outcome, retries included, so a later check must not
      // see the same drop again and announce it twice.
      await setBaseline(watchedWallet.id, token, now);
      const result = await executor.buy(botRef, telegramId, token, sellKey);
      decisions[decisions.length - 1].buy = result.status;
    }
    return decisions;
  });
}

// Every enabled user's row for a watched address gets checked.
async function checkWatchedAddress(address, blockNumber) {
  const rows = await db.many(
    `select w.* from watched_wallets w join watcher_state s on s.telegram_id = w.telegram_id
     where s.enabled and w.address = $1`,
    [address.toLowerCase()]
  );
  for (const row of rows) {
    if (!watchers.has(row.telegram_id)) continue;
    try {
      await checkAddress(botRef, row.telegram_id, row, { blockNumber });
      failures.delete(row.id);
    } catch (err) {
      noteFailure(row, err);
    }
  }
}

// A check failing once is the RPC blinking. Failing repeatedly for the same
// wallet means the user's moonbags are silently not being watched, which is the
// one thing this bot must not do quietly.
const failures = new Map(); // watched_wallet_id -> consecutive failures
const FAILURES_BEFORE_ALERT = 3;

function noteFailure(row, err) {
  const n = (failures.get(row.id) || 0) + 1;
  failures.set(row.id, n);
  console.error(`[watcher] check ${row.address} for ${row.telegram_id} failed (${n}): ${err.shortMessage || err.message}`);
  if (n === FAILURES_BEFORE_ALERT) {
    alerts
      .notifyDev("Watched wallet keeps failing its check", {
        address: row.address,
        telegramId: row.telegram_id,
        failures: n,
        error: err.shortMessage || err.message,
      }, { key: `check:${row.id}` })
      .catch(() => {});
  }
}

// ---- WSS subscription -----------------------------------------------------------
function onLogs(logs) {
  for (const log of logs) {
    const from = log.args?.from?.toLowerCase();
    const to = log.args?.to?.toLowerCase();
    for (const address of [from, to]) {
      if (!address || !subs.addresses.has(address)) continue;
      const entry = debounces.get(address) || { timer: null, blockNumber: null };
      entry.blockNumber = log.blockNumber;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        debounces.delete(address);
        console.log(`[watcher] transfer touching ${address} at block ${entry.blockNumber}`);
        checkWatchedAddress(address, entry.blockNumber).catch((e) => console.error("[watcher] event check", e.message));
      }, config.EVENT_DEBOUNCE_MS);
      debounces.set(address, entry);
    }
  }
}

function onWsError(err) {
  if (subs.healthy) console.error(`[watcher] WSS error, relying on the poll until rebuilt: ${err.shortMessage || err.message}`);
  subs.healthy = false;
}

function teardownSubscriptions() {
  for (const unwatch of subs.unwatch) {
    try { unwatch(); } catch { /* socket already gone */ }
  }
  subs.unwatch = [];
  subs.addresses = new Set();
}

// Rebuilds the two Transfer subscriptions from the set of addresses watched by
// enabled users. Called whenever that set may have changed.
async function rebuildSubscriptions() {
  const rows = await db.many(
    `select distinct w.address from watched_wallets w join watcher_state s on s.telegram_id = w.telegram_id where s.enabled`
  );
  const addresses = [...new Set(rows.map((r) => r.address.toLowerCase()))];
  const wasHealthy = subs.healthy;
  teardownSubscriptions();
  subs.addresses = new Set(addresses);
  if (addresses.length === 0) { subs.healthy = true; return; }

  const client = wasHealthy ? alchemy.wsClient() : alchemy.resetWsClient();
  const checksummed = addresses.map((a) => getAddress(a));
  try {
    subs.unwatch.push(client.watchEvent({ event: TRANSFER, args: { from: checksummed }, onLogs, onError: onWsError }));
    subs.unwatch.push(client.watchEvent({ event: TRANSFER, args: { to: checksummed }, onLogs, onError: onWsError }));
    subs.healthy = true;
    console.log(`[watcher] WSS subscriptions rebuilt for ${addresses.length} address(es)`);
  } catch (err) {
    subs.healthy = false;
    // Not fatal: the 60-second poll is the backstop and pollOnce retries this
    // every tick. It is worth a developer's attention because latency goes from
    // seconds to a minute while it lasts.
    await alerts.notifyDev("WSS subscribe failed, falling back to the poll", {
      addresses: addresses.length,
      error: err.shortMessage || err.message,
    }, { key: "wss-subscribe" });
  }
}

// ---- poll ---------------------------------------------------------------------
async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    if (!subs.healthy) await rebuildSubscriptions();
    for (const telegramId of [...watchers.keys()]) {
      const wallets = await wallet.listWatchAddresses(telegramId);
      for (const w of wallets) {
        try {
          await checkAddress(botRef, telegramId, w);
          failures.delete(w.id);
        } catch (err) {
          noteFailure(w, err);
        }
      }
      await db.query("update watcher_state set last_poll_at = now() where telegram_id = $1", [telegramId]);
    }
  } catch (err) {
    // Everything per-wallet is already caught above, so reaching here means the
    // database or the wallet list is unavailable: nobody is being watched.
    alerts.swallow("watcher.pollOnce", err);
  } finally {
    polling = false;
  }
}

function ensurePoll() {
  if (pollTimer) return;
  pollTimer = setInterval(() => pollOnce().catch(() => {}), config.POLL_MS);
}

// ---- start / stop / resume ------------------------------------------------------
// Throws NO_WALLET / NO_WATCHED / WALLET_BALANCE_ZERO; index.js turns those into
// screens. Returns { watched, lowBalance } so the caller can warn about a wallet
// that is funded but thin.
async function startWatcher(bot, telegramId) {
  botRef = bot;
  const user = await wallet.getUser(telegramId);
  if (!user) throw new Error("NO_WALLET");

  const watched = await wallet.listWatchAddresses(telegramId);
  if (!watched.length) throw new Error("NO_WATCHED");

  const eth = await alchemy.getEthBalance(user.address);
  if (eth === 0n) throw new Error("WALLET_BALANCE_ZERO");
  const lowBalance = eth < user.buyAmountWei;

  await db.query(
    `insert into watcher_state (telegram_id, enabled) values ($1, true)
     on conflict (telegram_id) do update set enabled = true`,
    [telegramId]
  );
  watchers.set(telegramId, { since: Date.now() });
  ensurePoll();
  await rebuildSubscriptions();

  // First pass now, so the user does not wait for the poll. Not awaited: the
  // Telegram reply should not hang on RPC calls.
  (async () => {
    for (const w of watched) {
      try { await checkAddress(bot, telegramId, w); } catch (err) { noteFailure(w, err); }
    }
  })().catch((err) => alerts.swallow("watcher.initialPass", err, { telegramId }));
  console.log(`[watcher] started for ${telegramId} (${watched.length} wallet(s))`);
  return { watched: watched.length, lowBalance };
}

async function stopWatcher(telegramId) {
  watchers.delete(telegramId);
  await db.query(
    `insert into watcher_state (telegram_id, enabled) values ($1, false)
     on conflict (telegram_id) do update set enabled = false`,
    [telegramId]
  );
  await rebuildSubscriptions();
  console.log(`[watcher] stopped for ${telegramId}`);
}

// At boot: re-register everyone whose watcher was on, without the balance check.
async function resumeWatchers(bot) {
  botRef = bot;
  const rows = await db.many("select telegram_id from watcher_state where enabled");
  for (const r of rows) watchers.set(r.telegram_id, { since: Date.now() });
  ensurePoll();
  await rebuildSubscriptions();
  console.log(`[watcher] resumed ${rows.length} watcher(s)`);
  return rows.length;
}

// Called after a watched address is added or removed while a watcher is on.
async function refreshSubscriptions(telegramId) {
  if (watchers.has(telegramId)) await rebuildSubscriptions();
}

function isRunning(telegramId) {
  return watchers.has(telegramId);
}

function status() {
  return { watchers: watchers.size, wss: subs.healthy, addresses: subs.addresses.size };
}

function shutdown() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  for (const d of debounces.values()) clearTimeout(d.timer);
  debounces.clear();
  teardownSubscriptions();
}

module.exports = {
  checkAddress,
  seedPositions,
  startWatcher,
  stopWatcher,
  resumeWatchers,
  refreshSubscriptions,
  rebuildSubscriptions,
  pollOnce,
  isRunning,
  status,
  shutdown,
};
