# How the bot works

Read this once before changing anything in `bot/src`. It is short on purpose; the code is the detail.

## 1. The rule

Everything reduces to one pure function, `src/decide.js`:

```
decide(baseline, current) →
  baseline == null        → 'new'   (token not seen before in this wallet)
  current  >  baseline    → 'up'    (balance increased)
  drop     >= 5%          → 'sell'  (balance fell 5% or more from baseline)
  otherwise               → 'none'
```

`baseline` and `current` are raw token units as `bigint`. The rule never looks at prices. A "sell" is a balance drop, whatever caused it.

What happens per outcome, in `src/watcher.js` `checkAddress`:

| Outcome | Message to the user | Baseline | Buy |
| --- | --- | --- | --- |
| `new` | one line, "Buy detected" | set to current | no |
| `up` | one line, "Buy detected" with the increase | raised to current | no |
| `sell` | one message that becomes the buy's status | moved to current **as soon as the sell is recorded** | yes, `executor.buy` |
| `none` | nothing | unchanged | no |

The baseline moving at record time, not at settle time, is what makes "sold three times, bought three times" work. From the moment the `trades` row exists it owns the outcome — including every retry — so a later check must not see the same drop again.

The bot never sells. The bought tokens sit in the user's bot wallet; the only way out is Export Key.

## 2. Files

```
src/config.js          env parsing + chain constants (viem chain objects, Alchemy URLs, explorer, thresholds, retry, gas and log settings)
src/log.js             log levels: scope("executor").info(…) prints "[executor] …" when LOG_LEVEL allows it
src/index.js           Telegraf handlers, boot, /health. Exports { bot }; boots only when run directly.
src/ui.js              keyboards, screens, force-reply questions, message deletion — how the chat looks and behaves
src/wallet.js          users, encrypted keys, buy amount, watched wallets, the one-slot conversation state
src/decide.js          the rule above
src/errors.js          pure: classify() turns any failure into { code, retryable, user, alert }; backoffMs(); canRetry()
src/fee.js             the 1% fee, pure: integratorFees() for the quote, splitOutputs() to verify it, amountsFromReceipt() to read what actually moved
src/watcher.js         WSS Transfer subscriptions, 60 s poll, checkAddress, start/stop/resume
src/executor.js        buy(): trades row → quote → gas estimate → send → receipt → message; retry scheduling; DRY_RUN branch
src/retry.js           the worker: every 10 s, run the attempts that are due
src/services/db.js     pg Pool, ensureSchema() runs ../schema.sql at boot, query helpers
src/services/crypto.js AES-256-GCM with a key derived from MASTER_ENCRYPTION_KEY
src/services/alchemy.js viem clients (http + ws), getEthBalance, getTokenBalances (alchemy_getTokenBalances), getTokenMeta (cached)
src/services/uniswap.js Trading API: quote() and swap(), with retries for the router's transient 404s
src/services/alerts.js notifyDev() → ADMIN_CHAT_ID + the log, deduplicated for 10 minutes per failure (repeats are counted, not printed)
schema.sql             idempotent DDL
scripts/               spike-quote, spike-ws, smoke, e2e-ui, e2e-chain (see DEPLOYMENT.md)
test/                  node:test — decide, fee, errors
```

## 2b. What the chat looks like (`ui.js`)

Four rules, all enforced here rather than in the handlers:

- **The menu matches the state.** Before a wallet exists the only buttons are Create wallet and How it works. Afterwards Create wallet is gone. The first row is a single toggle that carries the state in its own label: `🟢 Moonbags ON · tap to pause` or `⚪️ Moonbags OFF · tap to start`, and every screen opens with the same banner.
- **A tap edits the message it was on.** `ui.screen` edits the tapped message instead of sending a new menu, so the chat does not grow a wall of keyboards. It falls back to a new message when the old one cannot be edited.
- **A question is a force-reply, and it cleans up after itself.** `ask()` deletes any question already open and sends the new one with `force_reply` plus a placeholder, so Telegram puts the user straight in the reply box. Answering deletes both the question and the answer (`closeQuestion`), leaving only the result. A rejected answer is deleted and the question comes back carrying the reason, so exactly one question is ever on screen.
- **Temporary things delete themselves.** `ui.temp` for confirmations and errors; the private key after `KEY_TTL_MS` (60 s), announced in the message that carries it.
- **The control panel stays at the bottom.** The panel is one message edited in place, which works until a notification is sent underneath it and strands the buttons up the scrollback. So its message id is stored (`users.menu_chat_id` / `menu_msg_id`), and `ui.bump` schedules `ui.moveMenu`: after `MENU_BUMP_MS` (4 s) of quiet the panel is re-sent at the bottom and the old copy deleted. It is debounced, so a burst of notifications moves it once; it is skipped when the panel is already the last thing the bot sent, and while a question is open, because that question owns the reply box. `index.js` supplies the drawing via `ui.onMenu` — `ui.js` knows nothing about dashboards.
- **A state is stated once.** `dashboard()` prints the banner, so a note that repeats it prints the same sentence twice. The toggle passes no note; the banner flipping from `⚪️` to `🟢` is the confirmation.

Every handler is wrapped in `guard(name, fn)`: nothing thrown reaches Telegraf, the user gets one short line, and the developers get the stack through `alerts`.

A fifth rule sits underneath those: **the bot never speaks to a `telegram_id`, only to a chat.** `ui.toUser` resolves the chat through `wallet.routeFor`, because `telegram_id` is a valid chat id only for people who have a private chat with the bot — see §2c.

## 2c. A user the bot cannot message

Someone who only ever used the bot in a group has no private chat, and Telegram refuses every message to their user id with `chat not found` or `bot can't initiate conversation with a user`. That refusal is permanent until they come back, so it is stored rather than retried:

- `ui.toUser` asks `wallet.routeFor(telegramId)` for `{ chatId, blocked }` and sends nothing when `blocked`.
- A refusal that matches `ui.UNREACHABLE` calls `wallet.markUnreachable`, which sets `users.unreachable_at` **only if it was null** and returns whether it did. So the alert to `ADMIN_CHAT_ID` fires once per episode, not once per message and not again after a restart.
- Any update from that user runs `wallet.rememberChat` in the `bot.use` middleware, which writes the new `chat_id` and clears `unreachable_at` in the same statement, and returns `true` so the recovery gets one log line.
- Their buys keep running while they are muted. `executor.screen` returns early instead of sending; nothing else about the trade changes.

Before this, one sell produced four failed sends and four alert lines for a user who was never going to receive any of them.

## 2d. What reaches the console (`log.js`)

`LOG_LEVEL` (default `info`) decides. The contract is that **a run where nothing went wrong reads clean**: a buy that works prints two lines and a quiet minute prints nothing.

```
[executor] 990333293 0xcb6f…1e18 buying MOON for 0.005 ETH · gas 1468280 · 0xd26aeda5…9640bf
[executor] 990333293 0xcb6f…1e18 confirmed 0xd26aeda5…9640bf · +5,137.591536 MOON · fee 51.894866 → treasury
```

`debug` adds what is normal but noisy: every transfer touching a watched wallet, every duplicate sell collapsing into one buy, the gas arithmetic, the router's transient 404s, the full sell key. Two things were demoted deliberately, because they described the machine working: the Trading API's gasLimit being too low (that is why `gasFor` exists, it happens on every swap) and a sell arriving twice from the WSS event and the poll.

`info` is state changes, `warn` is recovered-from, `error` is failed. A retryable attempt failure is a `warn`; only the last one is an `error`.

## 3. Data flow

**A button tap** → Telegram update → `index.js` handler → `wallet.js` reads/writes Postgres → reply with the main keyboard. Handlers that need typed input (buy amount, address) write `conversations.awaiting` and the next text message is routed by that value. A user can be awaiting one thing at a time; invalid input keeps them waiting, valid input clears it.

**A transfer on chain** → Alchemy WSS delivers an ERC-20 `Transfer` log whose `from` or `to` is a watched address → `watcher.onLogs` debounces 2 s per address → `checkWatchedAddress` runs `checkAddress` for every enabled user watching that address.

**Every 60 s** → `pollOnce` runs `checkAddress` for every watched wallet of every enabled user, stamps `watcher_state.last_poll_at`, and rebuilds the WSS subscription if it had errored.

**`checkAddress`** → `alchemy.getTokenBalances(address)` (all ERC-20s with non-zero balance) and the wallet's rows in `positions` → union of tokens → `decide` per token → messages, baseline updates, and `executor.buy` on a sell.

**`executor.buy`** → insert `trades(sell_key, status='queued')`, skip if the row already exists → run the first attempt.

**One attempt** (`executor.attempt`) → claim the row with a conditional `UPDATE` to `pending` and `attempts + 1`, which is what stops the watcher and the retry worker from running two attempts at once → if `DRY_RUN`, mark `dry_run` and show "Would buy" → else, if the row already carries a transaction hash, **resolve that first** (a lost receipt must never become a second buy) → `uniswap.quote` (native ETH in, token out, 1% slippage, **1% fee to the treasury**) → `fee.splitOutputs` verifies the quote pays exactly `FEE_BIPS` to `TREASURY_ADDRESS` and **throws before anything is signed** if it does not → `uniswap.swap` → `executor.gasFor` estimates the gas locally and sends the larger of that (plus 35%) and the API's own limit → refuse if the wallet cannot cover value plus gas → `sendTransaction` with the user's decrypted key → `waitForTransactionReceipt` → `fee.amountsFromReceipt` reads the token's `Transfer` logs for what actually moved → mark `confirmed`, store `fee_amount` and `tokens_out`, show the amounts with a Blockscout link.

**Messaging the user** → `ui.toUser`, never `sendMessage(telegram_id, …)`. It resolves the chat and skips a muted user entirely (§2c). `executor.screen` edits one message for the whole life of a buy — first attempt, each retry, and the outcome — so a buy that took four tries is still one message in the chat.

**On failure** → `errors.classify` decides. Retryable and under `MAX_BUY_ATTEMPTS` → status `retrying` with `next_retry_at = now() + backoff`, and the message becomes "Trying again (3/5) in 45s". Otherwise → status `failed`, one plain sentence about why, and `alerts.notifyDev` when it was exhausted or is our fault. `buy` and `attempt` never throw.

**`retry.js`** → every `RETRY_TICK_MS` (10 s), `executor.due()` selects `retrying` rows whose `next_retry_at` has passed and runs each through the same `attempt`. At boot it also calls `reclaimStranded()`, which puts back in the queue any row a crash left `pending`.

**Gas.** The Trading API's `gasLimit` has been measured about 4× too low on Robinhood Chain: transaction `0x62f3d87e…` burned its whole 259 000 limit and reverted, while `eth_estimateGas` on the same call returns ~1 130 000. That single number explains most of the "Buy failed: Transaction reverted" history. Estimating locally also catches a swap that would revert **before** it is sent, which costs nothing instead of the whole gas limit. `scripts/e2e-chain.js` reproduces both halves against an anvil fork.

**The fee.** 1% of every buy is taken from the token bought and paid to the treasury **inside the same swap transaction**, using the Uniswap Trading API's `integratorFees` field (`[{ bips, recipient }]` on `/quote`, encoded into the `/swap` calldata). There is no second transaction, the bot never holds the treasury's key, and a reverted swap pays no fee. The quote reports it in `quote.aggregatedOutputs[]`: one entry for the bot wallet, one tagged `fee: "INTEGRATOR"` for the treasury. Native-ETH input never routes through UniswapX, so this stays on the CLASSIC path. `fee.js` is pure and covered by `test/fee.test.js`; it fails closed, so a quote missing `aggregatedOutputs`, paying the wrong address, or carrying the wrong rate aborts the buy.

## 4. Tables (`schema.sql`)

| Table | Row is | Notes |
| --- | --- | --- |
| `users` | one Telegram user | `address` is the bot wallet; `key_iv/key_ct/key_tag` the AES-GCM parts; `buy_amount_wei` numeric; `chat_id` is where to message them; `unreachable_at` + `unreachable_reason` mute a user Telegram refuses to deliver to (§2c); `menu_chat_id` + `menu_msg_id` are the control panel's current message |
| `watched_wallets` | one (user, address) pair | addresses stored lowercase; unique per user |
| `positions` | one (watched wallet, token) baseline | `baseline_amount` raw units as numeric; cascades on wallet delete |
| `watcher_state` | one per user | `enabled` is the source of truth for resume-on-boot; `last_poll_at` |
| `trades` | one sell, and every attempt to buy it back | `sell_key = <telegramId>:<watched>:<token>:<block>:<before>-<after>`; `status` queued / pending / retrying / confirmed / failed / dry_run; `attempts`, `next_retry_at`, `error`, `error_code`; `chat_id` + `status_msg_id` are the message edited in place; fee columns `fee_bips`, `fee_recipient`, `fee_amount`, `tokens_out` (raw token units, quoted first then overwritten from the receipt) |
| `tokens` | metadata cache | `symbol`, `decimals` from on-chain reads; shared across chains, so never point two chains at one database |
| `conversations` | one per user | `awaiting` = `buy_amount` \| `add_address` \| null; `prompt_chat_id` + `prompt_msg_id` are the question currently on screen, so answering it can delete it |

Amounts are `bigint` in code and `numeric` in Postgres. Never `Number()` a wei value. Ratios in `decide` are computed in basis points with bigint.

## 5. Boot and shutdown (`index.js` `main`)

1. `db.ensureSchema()` runs `schema.sql` (all `create ... if not exists`).
2. `wallet.checkMasterKey()` decrypts the 200 most recent wallets. If any of them fail to open, the bot alerts `ADMIN_CHAT_ID` and exits 1 instead of starting. See §5b.
3. HTTP server starts; `/health` returns `{ ok, chain, chainId, dryRun, watchers, wss, addresses }`.
4. `bot.launch()` with a callback. The promise only resolves when polling stops, so the callback is where `watcher.resumeWatchers(bot)` runs: it re-registers every `watcher_state.enabled` user without the balance check and builds the WSS subscriptions.
5. `SIGINT`/`SIGTERM`: stop polling, clear timers and subscriptions, close HTTP, end the pool, exit.

## 5b. The master key must open the wallets

Every private key in `users` is sealed with AES-256-GCM under `sha256(MASTER_ENCRYPTION_KEY)` (`services/crypto.js`). A wallet can only be opened by the key that created it, so a process holding the wrong one can sign for nobody — while looking completely healthy. Nothing reads a private key until someone's watched wallet sells, so the wrong key is invisible from deploy until the first buy.

That is what happened on 2026-09-11: Railway held a different key from the one the wallets were written with, two users' buys failed at `wallet.getAccount`, and the whole signal was node's `Unsupported state or unable to authenticate data` — which names neither the key nor the cause, and was classified `UNKNOWN`, so it was retried five times and alerted five times.

Three things changed:

- `decryptSecret` tags its failure `KEY_MISMATCH` and says what actually went wrong.
- `errors.js` makes `KEY_MISMATCH` non-retryable and alerting. The sixth attempt fails exactly like the first; only an operator changes the outcome. The user is told their funds are untouched.
- `index.js` refuses to boot when the key cannot open existing wallets, so a bad deploy fails loudly at boot instead of quietly at someone's first buy.

`opened === 0` means the environment is simply running the wrong key — put the right one back. A **mixed** result (some open, some do not) is worse: wallets were created under two different keys, no single key opens them all, and fixing it needs both keys and a re-encryption pass. Do not rotate `MASTER_ENCRYPTION_KEY` on a live database without one.

Boot logs the key's fingerprint — the first twelve hex of its sha256 — which identifies the key across environments without revealing it. `node scripts/keycheck.js` prints the same fingerprint for any key/database pair, so a candidate key can be checked before it is deployed.

## 6. Concurrency and idempotence

- **One process.** Telegram long-polling and the WSS subscription both assume a single instance. Two instances double-buy.
- **Per-wallet lock.** `withLock(watchedWalletId, fn)` chains checks for the same wallet, so an event-triggered check and a poll check never interleave. Verified: two concurrent checks produce exactly one sell.
- **Debounce.** Events for one address are coalesced for 2 s; the last log's block number is used.
- **`sell_key` dedupe.** The key is `<telegramId>:<watched>:<token>:<block>:<before>-<after>`. Every part earns its place. Two triggers seeing one drop build the same key and insert once; a wallet selling the same token three times builds three keys and gets three buys (keying on the block alone made the second and third look like duplicates); and several users watching one trading wallet each get their own buy (leaving the telegram id out meant whoever was processed first claimed the row and the rest were skipped as duplicates).
- **Claiming.** One conditional `UPDATE` moves a row to `pending` and increments `attempts`. Whoever loses the race gets no row back and does nothing, so the watcher and the retry worker cannot both attempt the same buy.
- **Never two transactions for one sell.** An attempt that finds a hash on the row waits for that receipt before quoting again. A lost receipt therefore costs a delay, never a double buy.
- **Failed buys move the baseline anyway**, because the `trades` row owns the retries from that moment. That is what stopped the old "message a minute" behaviour: a wallet that cannot buy now says so once, retries quietly, and gives up with one sentence.
- **Seeding.** When a watched wallet is added, its current balances are written as baselines silently, so existing holdings are not announced as buys. If seeding fails, the wallet is removed again and the user is told.

## 7. Configuration (`config.js`)

`CHAIN` picks the viem chain object (`robinhood` 4663 or `robinhoodTestnet` 46630, both shipped by viem with multicall3), the Alchemy HTTPS and WSS URLs, the explorer base and the WETH reference. Constants: `DEFAULT_BUY_ETH = 0.005`, `SELL_THRESHOLD = 0.05`, `SLIPPAGE = 1` (%), `POLL_MS = 60000`, `EVENT_DEBOUNCE_MS = 2000`, `HIGH_BUY_WARN_ETH = 1`, `FEE_BIPS = 100` (1%; Uniswap allows at most 500). Retries: `MAX_BUY_ATTEMPTS = 5`, `RETRY_BACKOFF_MS = [5s, 15s, 45s, 2m]` (the last repeats), `RETRY_TICK_MS = 10s`, `STRANDED_AFTER_MS = 5m`. Gas: `GAS_BUFFER_PCT = 35`, `GAS_LIMIT_CAP = 5,000,000`. Messages: `KEY_TTL_MS = 60s`, `EPHEMERAL_TTL_MS = 30s`. `DRY_RUN` defaults to true unless the string is exactly `false`.

`ADMIN_CHAT_ID` (optional) is where `services/alerts.js` sends failures a user cannot fix; without it they only reach the log, and the boot says so. `LOG_LEVEL` (`debug|info|warn|error|silent`, default `info`) sets how much reaches the console — see §2d. `RPC_URL` / `WSS_URL` (optional) override Alchemy and exist only so a test run can point at a local anvil fork.

`TREASURY_ADDRESS` is validated and checksummed at boot; `config.feeEnabled` is true only when it is set. **Mainnet throws at boot without it**, so a forgotten variable can never trade fee-free; testnet tolerates it missing (there is no Uniswap there anyway). The treasury must not also be a watched trading wallet: fee transfers into it read as "Buy detected" and move that wallet's baselines. `index.js` warns at boot when it is.

## 8. Testing

- `npm test` runs the pure logic: `decide`, `fee`, `errors`.
- `node scripts/e2e-ui.js` is the full Telegram surface against a throwaway Postgres in Docker — every button, both questions, the private-key timer, three sells of one token, the retry queue from first failure to dev alert, the bot used from a group, and a user Telegram refuses to deliver to (muted once, buys still run, un-muted when they write). Telegram and the chain reads are stubbed; everything else is the real bot. It cleans up its own rows.
- `RPC_URL=http://localhost:8545 node scripts/e2e-chain.js` runs a real swap against an anvil fork of mainnet, with a real Uniswap quote. It sends the same calldata twice — once with the API's `gasLimit` and once with `executor.gasFor`'s — and asserts the first reverts and the second lands the tokens and the fee. Both commands are in `README.md`.
- Handler tests by hand: stub the Telegram transport and push fake updates.

```js
require("telegraf").Telegram.prototype.callApi = async function (method, payload) { calls.push({ method, payload }); return { message_id: 1 }; };
const { bot } = require("./src/index.js");
bot.botInfo = { id: 1, is_bot: true, first_name: "x", username: "x" };
await bot.handleUpdate({ update_id: 1, callback_query: { id: "1", from, chat_instance: "ci", message: { message_id: 1, chat, date: 0, text: "" }, data: "CREATE_WALLET" } });
await bot.handleUpdate({ update_id: 2, message: { message_id: 2, from, chat, date: 0, text: "0.01", entities: [] } });
```

  Telegraf creates a new `Telegram` client per update, so patch the prototype, not `bot.telegram`.
- Watcher tests: replace `alchemy.getTokenBalances` with a function returning controlled `[{ token, amount }]` and call `watcher.checkAddress(bot, telegramId, watchedWalletRow)` directly; assert on recorded messages and on `positions` / `trades` rows.
- On-chain tests: a throwaway wallet with testnet ETH, wrap to WETH, transfer out and back; `watcher.resumeWatchers(bot)` after setting `watcher_state.enabled = true` in SQL exercises the real WSS path. Testnet blocks are produced on demand, so block numbers only advance with transactions.
- Use a dedicated Neon branch for tests and delete the rows you created.

## 9. Where to change things

| Want to | Touch |
| --- | --- |
| The trigger rule or threshold | `decide.js`, `config.SELL_THRESHOLD`, the test |
| What a buy does (size, route) | `executor.attemptOnce`, `services/uniswap.js` |
| How often a buy retries, or how long it waits | `config.MAX_BUY_ATTEMPTS` / `RETRY_BACKOFF_MS`; which failures qualify is `errors.js` and `test/errors.test.js` |
| Where failures get reported | `config.adminChatId` (`ADMIN_CHAT_ID`) and `services/alerts.js` |
| How much the bot logs, or the level of one line | `LOG_LEVEL` and `src/log.js`; the line itself is `log.debug/info/warn/error` at the call site |
| What counts as "cannot be messaged" | `ui.UNREACHABLE`, and `wallet.markUnreachable` / `wallet.rememberChat` for the two ends of it |
| The fee rate, or turning the fee off | `config.FEE_BIPS` and `TREASURY_ADDRESS`; the logic is `fee.js` and `test/fee.test.js` |
| A new button | `ui.menu()` and an `action(...)` in `index.js`; typed input goes through `ask()` and `conversations.awaiting` |
| How a screen looks, what deletes itself, where the panel sits | `ui.js`; `config.MENU_BUMP_MS` for how long the chat must be quiet first |
| Message wording | the handler or `watcher.js` / `executor.js` where it is sent; HTML parse mode, escape user-controlled text with `ui.esc()` |
| A new table or column | `schema.sql` with `if not exists`; there is no migration tool |
| Anything about the wallet encryption key | `services/crypto.js`; the boot guard is `index.js` `assertMasterKeyOpensWallets` and `wallet.checkMasterKey`, tested in `test/master-key.test.js`. Check a key against a database with `scripts/keycheck.js` before deploying it |
| Another chain | `config.js` only, but use a separate database per chain (`tokens` is keyed by address only) |
