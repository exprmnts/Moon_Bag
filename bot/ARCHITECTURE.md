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
| `new` | "Buy detected (new token)" | set to current | no |
| `up` | "Buy detected" with the increase | raised to current | no |
| `sell` | "Sell detected" with the drop % | moved to current **only after** the buy settles | yes, `executor.buy` |
| `none` | nothing | unchanged | no |

The bot never sells. The bought tokens sit in the user's bot wallet; the only way out is Export Key.

## 2. Files

```
src/config.js          env parsing + chain constants (viem chain objects, Alchemy URLs, explorer, thresholds)
src/index.js           Telegraf handlers (12 buttons: wallet, trading wallets, buy amount, Enable/Disable Moonbags, Export Key; plus text input), boot, /health. Exports { bot }; boots only when run directly.
src/wallet.js          users, encrypted keys, buy amount, watched wallets, the one-slot conversation state
src/decide.js          the rule above
src/fee.js             the 1% fee, pure: integratorFees() for the quote, splitOutputs() to verify it, amountsFromReceipt() to read what actually moved
src/watcher.js         WSS Transfer subscriptions, 60 s poll, checkAddress, start/stop/resume
src/executor.js        buy(): trades row → quote → swap → send → receipt → message; DRY_RUN branch
src/services/db.js     pg Pool, ensureSchema() runs ../schema.sql at boot, query helpers
src/services/crypto.js AES-256-GCM with a key derived from MASTER_ENCRYPTION_KEY
src/services/alchemy.js viem clients (http + ws), getEthBalance, getTokenBalances (alchemy_getTokenBalances), getTokenMeta (cached)
src/services/uniswap.js Trading API: quote() and swap()
schema.sql             idempotent DDL
scripts/               spike-quote, spike-ws, smoke (see DEPLOYMENT.md)
test/decide.test.js    node:test
```

## 3. Data flow

**A button tap** → Telegram update → `index.js` handler → `wallet.js` reads/writes Postgres → reply with the main keyboard. Handlers that need typed input (buy amount, address) write `conversations.awaiting` and the next text message is routed by that value. A user can be awaiting one thing at a time; invalid input keeps them waiting, valid input clears it.

**A transfer on chain** → Alchemy WSS delivers an ERC-20 `Transfer` log whose `from` or `to` is a watched address → `watcher.onLogs` debounces 2 s per address → `checkWatchedAddress` runs `checkAddress` for every enabled user watching that address.

**Every 60 s** → `pollOnce` runs `checkAddress` for every watched wallet of every enabled user, stamps `watcher_state.last_poll_at`, and rebuilds the WSS subscription if it had errored.

**`checkAddress`** → `alchemy.getTokenBalances(address)` (all ERC-20s with non-zero balance) and the wallet's rows in `positions` → union of tokens → `decide` per token → messages, baseline updates, and `executor.buy` on a sell.

**`executor.buy`** → insert `trades(sell_key, status='pending')`, skip if it exists or if a pending buy for the same token is younger than 3 minutes → if `DRY_RUN`, mark `dry_run` and message "Would buy" → else `uniswap.quote` (native ETH in, token out, 1% slippage, **1% fee to the treasury**) → `fee.splitOutputs` verifies the quote pays exactly `FEE_BIPS` to `TREASURY_ADDRESS` and **throws before anything is signed** if it does not → `uniswap.swap` → `walletClient.sendTransaction({ to, value, data, gas })` with the user's decrypted key → `waitForTransactionReceipt` → `fee.amountsFromReceipt` reads the token's `Transfer` logs for what actually moved → mark `confirmed`, store `fee_amount` and `tokens_out`, and message the amounts with a Blockscout link. Any error marks `failed` and messages "Buy failed: <reason>". `buy` never throws.

**The fee.** 1% of every buy is taken from the token bought and paid to the treasury **inside the same swap transaction**, using the Uniswap Trading API's `integratorFees` field (`[{ bips, recipient }]` on `/quote`, encoded into the `/swap` calldata). There is no second transaction, the bot never holds the treasury's key, and a reverted swap pays no fee. The quote reports it in `quote.aggregatedOutputs[]`: one entry for the bot wallet, one tagged `fee: "INTEGRATOR"` for the treasury. Native-ETH input never routes through UniswapX, so this stays on the CLASSIC path. `fee.js` is pure and covered by `test/fee.test.js`; it fails closed, so a quote missing `aggregatedOutputs`, paying the wrong address, or carrying the wrong rate aborts the buy.

## 4. Tables (`schema.sql`)

| Table | Row is | Notes |
| --- | --- | --- |
| `users` | one Telegram user | `address` is the bot wallet; `key_iv/key_ct/key_tag` the AES-GCM parts; `buy_amount_wei` numeric |
| `watched_wallets` | one (user, address) pair | addresses stored lowercase; unique per user |
| `positions` | one (watched wallet, token) baseline | `baseline_amount` raw units as numeric; cascades on wallet delete |
| `watcher_state` | one per user | `enabled` is the source of truth for resume-on-boot; `last_poll_at` |
| `trades` | one buy attempt | `sell_key = <watched>:<token>:<block>`; `status` pending / dry_run / confirmed / failed; `buy_tx_hash`, `error`; fee columns `fee_bips`, `fee_recipient`, `fee_amount`, `tokens_out` (raw token units, quoted first then overwritten from the receipt) |
| `tokens` | metadata cache | `symbol`, `decimals` from on-chain reads; shared across chains, so never point two chains at one database |
| `conversations` | one per user | `awaiting` = `buy_amount` \| `add_address` \| null |

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
- **`sell_key` dedupe.** The same sell seen twice (same wallet, token, block) inserts once. Real sells are transactions and always advance the block, so distinct sells never collide.
- **In-flight guard.** A `pending` trade for the same user and token younger than 3 minutes means a buy is already on its way (or the process died mid-buy); the new sell is treated as handled.
- **Failed buys keep the baseline**, so the next check retries. This is deliberate and also the source of the "message a minute" behaviour when a wallet is unfunded. See `ROADMAP-V2.md` guardrails.
- **Seeding.** When a watched wallet is added, its current balances are written as baselines silently, so existing holdings are not announced as buys. If seeding fails, the wallet is removed again and the user is told.

## 7. Configuration (`config.js`)

`CHAIN` picks the viem chain object (`robinhood` 4663 or `robinhoodTestnet` 46630, both shipped by viem with multicall3), the Alchemy HTTPS and WSS URLs, the explorer base and the WETH reference. Constants: `DEFAULT_BUY_ETH = 0.005`, `SELL_THRESHOLD = 0.05`, `SLIPPAGE = 1` (%), `POLL_MS = 60000`, `EVENT_DEBOUNCE_MS = 2000`, `HIGH_BUY_WARN_ETH = 1`, `FEE_BIPS = 100` (1%; Uniswap allows at most 500). `DRY_RUN` defaults to true unless the string is exactly `false`.

`TREASURY_ADDRESS` is validated and checksummed at boot; `config.feeEnabled` is true only when it is set. **Mainnet throws at boot without it**, so a forgotten variable can never trade fee-free; testnet tolerates it missing (there is no Uniswap there anyway). The treasury must not also be a watched trading wallet: fee transfers into it read as "Buy detected" and move that wallet's baselines. `index.js` warns at boot when it is.

## 8. Testing

- `npm test` runs `test/decide.test.js`.
- Handler tests: stub the Telegram transport and push fake updates.

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
| What a buy does (size, route) | `executor.buy`, `services/uniswap.js` |
| The fee rate, or turning the fee off | `config.FEE_BIPS` and `TREASURY_ADDRESS`; the logic is `fee.js` and `test/fee.test.js` |
| A new button | `mainKeyboard()` and a `bot.action` in `index.js`; typed input goes through `conversations.awaiting` |
| Message wording | the handler or `watcher.js` / `executor.js` where it is sent; HTML parse mode, escape user-controlled text with `esc()` |
| A new table or column | `schema.sql` with `if not exists`; there is no migration tool |
| Another chain | `config.js` only, but use a separate database per chain (`tokens` is keyed by address only) |
