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
src/config.js          env parsing + chain constants (viem chain objects, Alchemy URLs, explorer, thresholds, retry and gas settings)
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
src/services/alerts.js notifyDev() → ADMIN_CHAT_ID + the log, deduplicated for 10 minutes per failure
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

Every handler is wrapped in `guard(name, fn)`: nothing thrown reaches Telegraf, the user gets one short line, and the developers get the stack through `alerts`.

## 3. Data flow

**A button tap** → Telegram update → `index.js` handler → `wallet.js` reads/writes Postgres → reply with the main keyboard. Handlers that need typed input (buy amount, address) write `conversations.awaiting` and the next text message is routed by that value. A user can be awaiting one thing at a time; invalid input keeps them waiting, valid input clears it.

**A transfer on chain** → Alchemy WSS delivers an ERC-20 `Transfer` log whose `from` or `to` is a watched address → `watcher.onLogs` debounces 2 s per address → `checkWatchedAddress` runs `checkAddress` for every enabled user watching that address.

**Every 60 s** → `pollOnce` runs `checkAddress` for every watched wallet of every enabled user, stamps `watcher_state.last_poll_at`, and rebuilds the WSS subscription if it had errored.

**`checkAddress`** → `alchemy.getTokenBalances(address)` (all ERC-20s with non-zero balance) and the wallet's rows in `positions` → union of tokens → `decide` per token → messages, baseline updates, and `executor.buy` on a sell.

**`executor.buy`** → insert `trades(sell_key, status='queued')`, skip if the row already exists → run the first attempt.

**One attempt** (`executor.attempt`) → claim the row with a conditional `UPDATE` to `pending` and `attempts + 1`, which is what stops the watcher and the retry worker from running two attempts at once → if `DRY_RUN`, mark `dry_run` and show "Would buy" → else, if the row already carries a transaction hash, **resolve that first** (a lost receipt must never become a second buy) → `uniswap.quote` (native ETH in, token out, 1% slippage, **1% fee to the treasury**) → `fee.splitOutputs` verifies the quote pays exactly `FEE_BIPS` to `TREASURY_ADDRESS` and **throws before anything is signed** if it does not → `uniswap.swap` → `executor.gasFor` estimates the gas locally and sends the larger of that (plus 35%) and the API's own limit → refuse if the wallet cannot cover value plus gas → `sendTransaction` with the user's decrypted key → `waitForTransactionReceipt` → `fee.amountsFromReceipt` reads the token's `Transfer` logs for what actually moved → mark `confirmed`, store `fee_amount` and `tokens_out`, show the amounts with a Blockscout link.

**On failure** → `errors.classify` decides. Retryable and under `MAX_BUY_ATTEMPTS` → status `retrying` with `next_retry_at = now() + backoff`, and the message becomes "Trying again (3/5) in 45s". Otherwise → status `failed`, one plain sentence about why, and `alerts.notifyDev` when it was exhausted or is our fault. `buy` and `attempt` never throw.

**`retry.js`** → every `RETRY_TICK_MS` (10 s), `executor.due()` selects `retrying` rows whose `next_retry_at` has passed and runs each through the same `attempt`. At boot it also calls `reclaimStranded()`, which puts back in the queue any row a crash left `pending`.

**Gas.** The Trading API's `gasLimit` has been measured about 4× too low on Robinhood Chain: transaction `0x62f3d87e…` burned its whole 259 000 limit and reverted, while `eth_estimateGas` on the same call returns ~1 130 000. That single number explains most of the "Buy failed: Transaction reverted" history. Estimating locally also catches a swap that would revert **before** it is sent, which costs nothing instead of the whole gas limit. `scripts/e2e-chain.js` reproduces both halves against an anvil fork.

**The fee.** 1% of every buy is taken from the token bought and paid to the treasury **inside the same swap transaction**, using the Uniswap Trading API's `integratorFees` field (`[{ bips, recipient }]` on `/quote`, encoded into the `/swap` calldata). There is no second transaction, the bot never holds the treasury's key, and a reverted swap pays no fee. The quote reports it in `quote.aggregatedOutputs[]`: one entry for the bot wallet, one tagged `fee: "INTEGRATOR"` for the treasury. Native-ETH input never routes through UniswapX, so this stays on the CLASSIC path. `fee.js` is pure and covered by `test/fee.test.js`; it fails closed, so a quote missing `aggregatedOutputs`, paying the wrong address, or carrying the wrong rate aborts the buy.

## 4. Tables (`schema.sql`)

| Table | Row is | Notes |
| --- | --- | --- |
| `users` | one Telegram user | `address` is the bot wallet; `key_iv/key_ct/key_tag` the AES-GCM parts; `buy_amount_wei` numeric |
| `watched_wallets` | one (user, address) pair | addresses stored lowercase; unique per user |
| `positions` | one (watched wallet, token) baseline | `baseline_amount` raw units as numeric; cascades on wallet delete |
| `watcher_state` | one per user | `enabled` is the source of truth for resume-on-boot; `last_poll_at` |
| `trades` | one sell, and every attempt to buy it back | `sell_key = <telegramId>:<watched>:<token>:<block>:<before>-<after>`; `status` queued / pending / retrying / confirmed / failed / dry_run; `attempts`, `next_retry_at`, `error`, `error_code`; `chat_id` + `status_msg_id` are the message edited in place; fee columns `fee_bips`, `fee_recipient`, `fee_amount`, `tokens_out` (raw token units, quoted first then overwritten from the receipt) |
| `tokens` | metadata cache | `symbol`, `decimals` from on-chain reads; shared across chains, so never point two chains at one database |
| `conversations` | one per user | `awaiting` = `buy_amount` \| `add_address` \| null; `prompt_chat_id` + `prompt_msg_id` are the question currently on screen, so answering it can delete it |

Amounts are `bigint` in code and `numeric` in Postgres. Never `Number()` a wei value. Ratios in `decide` are computed in basis points with bigint.

## 5. Boot and shutdown (`index.js` `main`)

1. `db.ensureSchema()` runs `schema.sql` (all `create ... if not exists`).
2. HTTP server starts; `/health` returns `{ ok, chain, chainId, dryRun, watchers, wss, addresses }`.
3. `bot.launch()` with a callback. The promise only resolves when polling stops, so the callback is where `watcher.resumeWatchers(bot)` runs: it re-registers every `watcher_state.enabled` user without the balance check and builds the WSS subscriptions.
4. `SIGINT`/`SIGTERM`: stop polling, clear timers and subscriptions, close HTTP, end the pool, exit.

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

`ADMIN_CHAT_ID` (optional) is where `services/alerts.js` sends failures a user cannot fix; without it they only reach the log, and the boot says so. `RPC_URL` / `WSS_URL` (optional) override Alchemy and exist only so a test run can point at a local anvil fork.

`TREASURY_ADDRESS` is validated and checksummed at boot; `config.feeEnabled` is true only when it is set. **Mainnet throws at boot without it**, so a forgotten variable can never trade fee-free; testnet tolerates it missing (there is no Uniswap there anyway). The treasury must not also be a watched trading wallet: fee transfers into it read as "Buy detected" and move that wallet's baselines. `index.js` warns at boot when it is.

## 8. Testing

- `npm test` runs the pure logic: `decide`, `fee`, `errors`.
- `node scripts/e2e-ui.js` is the full Telegram surface against a throwaway Postgres in Docker — every button, both questions, the private-key timer, three sells of one token, and the retry queue from first failure to dev alert. Telegram and the chain reads are stubbed; everything else is the real bot. It cleans up its own rows.
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
| The fee rate, or turning the fee off | `config.FEE_BIPS` and `TREASURY_ADDRESS`; the logic is `fee.js` and `test/fee.test.js` |
| A new button | `ui.menu()` and an `action(...)` in `index.js`; typed input goes through `ask()` and `conversations.awaiting` |
| How a screen looks, or what deletes itself | `ui.js` |
| Message wording | the handler or `watcher.js` / `executor.js` where it is sent; HTML parse mode, escape user-controlled text with `ui.esc()` |
| A new table or column | `schema.sql` with `if not exists`; there is no migration tool |
| Another chain | `config.js` only, but use a separate database per chain (`tokens` is keyed by address only) |
