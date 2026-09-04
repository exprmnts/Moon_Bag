# Moonbag MVP roadmap — Solana → Robinhood Chain

## Status (2026-09-04, end of build session)

Done, on branch `robinhood-mvp` merged to `main`: Phase 0 (rename, deps, both spikes pass), Phase 1 (Neon ledger, wallet, `decide()` + test), Phase 2 (all twelve buttons, conversation state in Postgres, `${value}` bug fixed), Phase 3 (WSS + 60 s poll watcher, per-wallet lock, resume on boot, `scripts/smoke.js`), Phase 4 (Trading API executor with `trades` dedupe, in-flight guard and `DRY_RUN`), Phase 5 (site header link + FAQ pill, verified at 390/1440), Phase 6 prep (node:22 Dockerfile with `/health`, README, CLAUDE.md).

Verified: unit test; a harness driving every handler through Telegraf against Neon `dev` + Alchemy testnet (35 checks); a live testnet loop with real transfers (sell 10% → "Sell detected" + dry-run buy in ~4 s after the block, buy-back → "Buy detected", 2% ignored, second sell re-triggers, restart resumes); the same loop against the running bot and the owner's real Telegram account; mainnet `/quote` + `/swap` return 200 (nothing sent).

Remaining (owner): mainnet swap test (`CHAIN=mainnet`, `DRY_RUN=false`, buy 0.001, ~0.02 ETH), Railway service, rotate the bot token and Neon password, then observe.

Known behaviours to decide on before launch: a failed buy keeps its baseline and retries on every check (a message a minute while the wallet is unfunded); the high-amount warning fires above 1 ETH; there is no minimum position value, so dust tokens trigger buys too.

Written 2026-09-04 for the next Claude Code session. Read this whole file, then `CLAUDE.md`, then `tg bot/src/*` once, then start at Phase 0. Do not widen scope. The owner (Nikhil) has **5 hours** and wants a working MVP on Railway tonight.

## What we are building

The existing Telegram bot, feature for feature, on Robinhood Chain instead of Solana, with three implementation fixes:

1. Firebase Firestore → Neon Postgres (plain `pg`, idempotent `schema.sql` run at boot, no ORM, no migration tool).
2. 10-second balance polling → WebSocket Transfer events trigger the existing check immediately; a 60-second poll stays as the backstop; watchers resume on boot.
3. Private key never sent as a message → **Export Key** button with a confirmation.

Same rule as today: a token in a watched wallet whose balance drops ≥5% from its baseline is a sell; one buy of the user's fixed ETH amount follows; new tokens and balance increases raise the baseline; the bot never sells. Eleven buttons, same words with Solana terms swapped, plus Export Key.

**Not in scope tonight** (do not build, do not scaffold): fees, $MOON gate, targets/selling, subscriptions, Privy, Alchemy webhooks, TypeScript, Drizzle, tests beyond one file, hood.fun curve adapter, dark patterns of any kind.

## Decisions already made (do not reopen)

| Topic | Decision |
| --- | --- |
| Chain | Robinhood Chain. Mainnet chain id **4663**, testnet **46630**. ETH is gas. ~100 ms blocks. |
| Users | None. Fresh database. No Firestore export. Firebase code is deleted. |
| Default buy amount | **0.005 ETH**, one constant `DEFAULT_BUY_ETH` in `src/config.js`. |
| Keys | Per-user EVM key, AES-256-GCM with the existing `services/crypto.js`, master key only in env. Export Key button. |
| Bot framework | Telegraf 4 (already installed), JavaScript, CommonJS, Node 22. Long-polling. One replica. |
| Chain library | `viem` (latest 2.x). No ethers. |
| RPC / data | Alchemy: HTTPS + WSS on `robinhood-mainnet` / `robinhood-testnet`; `alchemy_getTokenBalances` for balances; ERC-20 `symbol()`/`decimals()` reads for metadata (cached in `tokens` table). |
| Swap | Uniswap Trading API `https://trade-api.gateway.uniswap.org/v1` (`x-api-key`): `POST /quote` then `POST /swap` (CLASSIC). **Mainnet only** — the API and Uniswap contracts are not on testnet 46630. `DRY_RUN=true` logs "would buy" instead. |
| Explorer links | `https://robinhoodchain.blockscout.com/tx/<hash>` (testnet: `https://explorer.testnet.chain.robinhood.com/tx/<hash>`). |
| Folder | Rename `tg bot/` → `bot/` (the space breaks tooling). Update `CLAUDE.md` paths. **Confirmed.** |
| Bot token | No token exists in the repo. Owner creates a new bot with @BotFather (or supplies an existing token) and puts it in `bot/.env`. |
| Sequence | Develop and dry-run on **testnet** first; the final swap test and the deployed bot run on **mainnet** (owner has mainnet ETH on Robinhood Chain). |
| Website link | Both: pill button on the last slide and a small "Telegram ↗" link in the header. **Confirmed.** |
| Website | Keep Next 14 deck. Add the bot link (Phase 5). Deploys itself on push to `main`. |
| Hosting | Railway service from `bot/` with the Dockerfile (bump to `node:22-alpine`). Neon for Postgres. |

Reference addresses (mainnet 4663): WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`, Uniswap V3 Factory `0x1f7d7550b1b028f7571e69a784071f0205fd2efa`, SwapRouter02 `0xcaf681a66d020601342297493863e78c959e5cb2`, QuoterV2 `0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7`, UniversalRouter `0x8876789976decbfcbbbe364623c63652db8c0904`, Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3`. Pons factory `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` (only needed for logos; not used tonight). Testnet WETH `0x7943e237c7F95DA44E0301572D358911207852Fa`. Native ETH for the Trading API is `0x0000000000000000000000000000000000000000`.

## Environment variables (`bot/.env`, and Railway)

```
TELEGRAM_BOT_TOKEN=            # BotFather
DATABASE_URL=                  # Neon pooled connection string
MASTER_ENCRYPTION_KEY=         # 32+ random chars; generate with: openssl rand -hex 32
ALCHEMY_API_KEY=               # one Alchemy app with Robinhood Chain mainnet + testnet enabled
UNISWAP_API_KEY=               # developers.uniswap.org dashboard (mainnet swaps only)
CHAIN=testnet                  # testnet | mainnet  (selects RPC/WSS/explorer/chain id)
DRY_RUN=true                   # true = never send a swap, just message "would buy"
PORT=3000                      # keep-alive + /health
```

Derived in `src/config.js`, never in env: chain id, `https://robinhood-{mainnet|testnet}.g.alchemy.com/v2/<key>`, `wss://…`, explorer base, `DEFAULT_BUY_ETH = 0.005`, `SELL_THRESHOLD = 0.05`, `SLIPPAGE = 1` (%), `POLL_MS = 60_000`.

Never print or log secrets. Never paste a token into the chat; the owner puts values into `bot/.env` and Railway himself.

## Where every value comes from, in priority order

Put values into `tg bot/.env` (it is git-ignored; the rename carries it to `bot/.env`). Never paste them into the chat. Claude generates `MASTER_ENCRYPTION_KEY` itself.

**Priority 1 — needed to start coding (Phases 0–3, testnet):**

| Value | Where | Notes |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | https://t.me/BotFather → `/newbot` | Also note the `@username`; it goes on the website. |
| `DATABASE_URL` | https://console.neon.tech → New project `moonbag` → Branches → create `dev` → Connect → copy the **pooled** string | The `main` branch string is for Railway later. |
| `ALCHEMY_API_KEY` | https://dashboard.alchemy.com → Apps → Create app → enable **Robinhood Chain Mainnet** and **Robinhood Chain Testnet** → API key | RPC/WSS URLs are derived from the key: `https://robinhood-testnet.g.alchemy.com/v2/<key>`, `wss://…`, same for `robinhood-mainnet`. Public fallback: `https://rpc.testnet.chain.robinhood.com`, `https://rpc.mainnet.chain.robinhood.com`. |
| `MASTER_ENCRYPTION_KEY` | Generated in-session with `openssl rand -hex 32` | Nothing to fetch. |
| Testnet ETH | https://faucet.testnet.chain.robinhood.com into a wallet you control (add the network to MetaMask: chain id 46630, RPC above, explorer https://explorer.testnet.chain.robinhood.com) | Needed for the Phase 3 manual test, not for coding. |

**Priority 2 — needed for the buy path and the mainnet test (Phase 4):**

| Value | Where | Notes |
| --- | --- | --- |
| `UNISWAP_API_KEY` | https://developers.uniswap.org/dashboard → create an API key | Also lets Phase 0's quote spike run early if available. |
| Mainnet ETH | Already held by the owner on Robinhood Chain | ~0.02 ETH: 0.01 into the bot wallet, the rest for the watched wallet's test sells. |

**Priority 3 — deploy (Phase 6):**

| Value | Where | Notes |
| --- | --- | --- |
| Railway project | https://railway.com/new → Deploy from GitHub → `exprmnts/Moon_Bag`, root directory `bot`, Dockerfile build | Variables tab takes the same `.env` values plus `CHAIN=mainnet`, `DRY_RUN=false`. Optional CLI: `npm i -g @railway/cli && railway login`. |
| Neon `main` string | Same Neon project, `main` branch, pooled | For Railway only. |
| `NEXT_PUBLIC_BOT_URL` | Already set on Vercel: `https://t.me/mooonbagbot` | Done. |

## Owner prerequisites (must exist before Phase 1; Claude cannot create these)

Status at hand-off (2026-09-04 evening): `tg bot/.env` is filled and **verified**: Telegram token works (bot is **@mooonbagbot**, three o's), Alchemy key answers on both networks and `alchemy_getTokenBalances` works on testnet, Neon `DATABASE_URL` connects (database `neondb`, empty), `MASTER_ENCRYPTION_KEY` generated. `NEXT_PUBLIC_BOT_URL=https://t.me/mooonbagbot` is already set on Vercel (production and preview). `UNISWAP_API_KEY` is set and **verified**: a mainnet `/quote` for 0.001 ETH → PONS returned a CLASSIC v3 route (gas ≈ $0.26). Owner has claimed testnet ETH; ask for that wallet's 0x address at the start of Phase 3. **Everything needed for the build is in place.** The token and DB password were pasted into a chat once; rotate both after launch (BotFather `/revoke`, Neon password reset) and update `.env` and Railway.

- [ ] Telegram bot token from @BotFather (new bot or the existing one) and its `@username` for the website link. **Owner is providing the token (into `.env`) and the `@username`.**
- [ ] Alchemy account + app with Robinhood Chain mainnet and testnet enabled → API key. **Owner is providing it (into `.env`).**
- [ ] Uniswap Trading API key from the developers.uniswap.org dashboard.
- [ ] Neon project `moonbag` with branches `main` (Railway) and `dev` (laptop) → two pooled connection strings.
- [ ] Railway project (dashboard is fine; the CLI is not installed).
- [ ] A wallet the owner controls with **testnet ETH** from `faucet.testnet.chain.robinhood.com` (for Phase 3) and, for Phase 4, **~0.02 mainnet ETH on Robinhood Chain** (bridge via portal.arbitrum.io or Relay/Across, or Robinhood Wallet). Without mainnet ETH the night ends at dry-run.
- [ ] Vercel env `NEXT_PUBLIC_BOT_URL=https://t.me/<username>` on project `moonbagbot`. **Claude sets this in Phase 5 from the `@username` the owner gives; the owner does not need to touch Vercel.**

## Schema (`bot/schema.sql`, run at boot with `CREATE TABLE IF NOT EXISTS`)

```sql
users            (telegram_id text primary key, address text not null, key_iv text, key_ct text, key_tag text,
                  buy_amount_wei numeric not null, created_at timestamptz default now())
watched_wallets  (id serial primary key, telegram_id text references users, address text not null,
                  added_at timestamptz default now(), unique (telegram_id, address))
positions        (watched_wallet_id int references watched_wallets on delete cascade, token text,
                  baseline_amount numeric not null, updated_at timestamptz default now(),
                  primary key (watched_wallet_id, token))
watcher_state    (telegram_id text primary key references users, enabled boolean not null default false,
                  last_poll_at timestamptz)
trades           (sell_key text primary key, telegram_id text, token text, eth_in_wei numeric,
                  buy_tx_hash text, status text not null, error text, created_at timestamptz default now())
tokens           (address text primary key, symbol text, decimals int, updated_at timestamptz default now())
conversations    (telegram_id text primary key, awaiting text, updated_at timestamptz default now())
```

Amounts are raw token units (bigint as numeric). The decision uses ratios, so units only need to be consistent. `sell_key` = `<watched address>:<token>:<block number>` from the event or poll that detected the sell; a second insert for the same key means "already handled".

## File layout after the port (`bot/`)

```
Dockerfile  Procfile  package.json  schema.sql  .env.example  README.md
src/config.js            chain constants, env parsing, DEFAULT_BUY_ETH, thresholds
src/index.js             Telegraf handlers (all eleven + Export Key), keep-alive http, /health, boot: ensureSchema, resumeWatchers
src/wallet.js            create/get user, set buy amount, add/remove watched wallet, decrypt key (viem privateKeyToAccount)
src/watcher.js           decide(), checkAddress(), start/stop, WSS Transfer subscription, 60 s poll, resumeWatchers
src/executor.js          buy(): trades insert (dedupe) → quote → swap → sign → send → receipt → message; DRY_RUN branch
src/services/db.js       pg Pool, ensureSchema(), tiny query helpers
src/services/crypto.js   unchanged from today
src/services/alchemy.js  http/ws viem clients, getEthBalance, getTokenBalances, getTokenMeta (cached)
src/services/uniswap.js  quote(), swapCalldata() against the Trading API
scripts/spike-quote.js   Phase 0: quote a Pons token on mainnet
scripts/smoke.js         Phase 3: drive one full check for a given telegram_id from the CLI
test/decide.test.js      node:test, the only unit test
```

Delete: `services/firebase.js`, `services/jupiter.js`, `services/moralis.js`, `vercel.json`, `vercel-build.js`, `.vercelignore`, `DEPLOYMENT.md` (replace with a short README section). Drop deps `firebase`, `@solana/web3.js`, `bs58`, `axios`. Add `viem`, `pg`. Keep `telegraf`, `dotenv`, `nodemon` (dev).

## Phases (time boxes add up to ~4.5 h; keep 30 min slack)

### Phase 0 — Spike (30 min)
1. Rename `tg bot/` → `bot/`. Commit.
2. `npm i viem pg && npm rm firebase @solana/web3.js bs58 axios`. Node engine `>=22`. Dockerfile `node:22-alpine`.
3. `scripts/spike-quote.js`: **the quote half already passed on 2026-09-04** with this exact body — keep it as the reference request:
   ```json
   POST https://trade-api.gateway.uniswap.org/v1/quote   header x-api-key: <UNISWAP_API_KEY>
   { "tokenIn": "0x0000000000000000000000000000000000000000", "tokenOut": "0x39dBED3a2bd333467115dE45665cC57F813C4571",
     "tokenInChainId": 4663, "tokenOutChainId": 4663, "amount": "1000000000000000", "type": "EXACT_INPUT",
     "swapper": "<bot wallet address>", "slippageTolerance": 1, "routingPreference": "BEST_PRICE" }
   ```
   (`routingPreference` accepts only `BEST_PRICE` or `FASTEST`; the response has `routing: "CLASSIC"` and `quote.output.amount`.) In the script, also POST `/swap` with `{ "quote": <the whole quote object>, "simulateTransaction": false }` and print the returned `swap` fields (`to`, `value`, `data`, `chainId`). **Pass = /swap returns 200.** Do not send anything.
4. `scripts/spike-ws.js`: open a viem WebSocket client on testnet, `watchEvent` for ERC-20 `Transfer` with `args: { from: [<owner testnet wallet>] }`; owner sends any testnet ERC-20 (or wraps ETH to WETH and transfers it) and the script prints the log. **Pass = one log printed within seconds.**
5. Check `alchemy_getTokenBalances` answers on testnet for the same wallet (curl). If it does not, fall back to tracking balances via `balanceOf` reads for tokens seen in events; note it in this file.

Acceptance: both spike scripts pass. Any failure here is reported to the owner before continuing.

### Phase 1 — Ledger and wallet (45 min)
- `services/db.js`: `Pool` from `DATABASE_URL`, `ensureSchema()` reads `schema.sql`.
- `wallet.js`: `createUserWalletIfMissing` → viem `generatePrivateKey()`, address, encrypt with `crypto.js`, insert with `buy_amount_wei = parseEther(DEFAULT_BUY_ETH)`; `getUser`, `setBuyAmount(eth)`, `addWatchAddress` (viem `isAddress`, lowercase, unique), `removeWatchAddress`, `listWatchAddresses`, `getAccount(telegramId)` → `privateKeyToAccount`.
- `conversations` helpers: `setAwaiting(id, 'buy_amount'|'add_address'|null)`, `getAwaiting(id)`.

Acceptance: a throwaway script creates a user, adds and removes a watch address, round-trips the key. Rows visible in Neon.

### Phase 2 — Handlers (60 min)
Port `index.js` one action at a time, same button labels with Solana words swapped (SOL → ETH, Solscan → Blockscout, "Solana wallet address" → "wallet address (0x…)"):
- `/start`, `/help`, `HELP`: same copy, chain words swapped.
- `CREATE_WALLET`: reply with the address only, plus "Fund it: bridge ETH from Ethereum/Arbitrum/Base (portal.arbitrum.io, Relay) or send from Robinhood Wallet. Use Export Key to back up your key."
- `EXPORT_KEY` (new button, bottom of the keyboard): first tap replies with a warning and a `CONFIRM_EXPORT` button; the confirm tap replies with the key in `<code>` and the advice to delete the message.
- `SHOW_ADDRESS`, `CHECK_BALANCE` (ETH via `getBalance`, tokens via `getTokenBalances`, names via `getTokenMeta`, top 10), `SHOW_POSITIONS` (top 6 per watched wallet), `SHOW_WATCH` (status from `watcher_state.enabled`), `ADD_WATCH_ADDR`, `REMOVE_WATCH_ADDR` + `REMOVE_<addr>`, `SET_BUY_AMOUNT`, `START_WATCH`, `STOP_WATCH`, `BACK_TO_MAIN`.
- `bot.on('text')` reads `conversations.awaiting` instead of in-memory sets; clears it after handling; fix the `${value}` template bug; a user can only be awaiting one thing.
- Boot order: `ensureSchema()` → `bot.launch()` → `resumeWatchers(bot)` → http server with `/health` returning `{ ok, chain, watchers }`.

Acceptance: every button works on testnet against the Neon `dev` branch, restart the process, Watch Addresses still correct.

### Phase 3 — Watcher (60 min)
- `decide(baseline, current)` pure function: returns `{ kind: 'new' | 'up' | 'sell' | 'none', dropPct }`, identical thresholds to today. `test/decide.test.js` covers the four cases. Run with `node --test`.
- `checkAddress(bot, telegramId, watchedWallet)`: fetch balances → for each token apply `decide` against `positions` → messages identical to today's ("Buy detected", "Sell detected") → on `sell` call `executor.buy(...)` → update baselines. Baseline for a sell is updated only after `buy` returns (confirmed or dry-run), not on failure.
- `startWatcher(bot, telegramId)`: refuse if ETH balance is 0 (same message as today); set `watcher_state.enabled = true`; run `checkAddress` for each watched wallet now; register the user in the in-process `watchers` map.
- One process-wide WSS subscription (viem `watchEvent`, Transfer ABI) for `from ∈ watched` and one for `to ∈ watched`; rebuilt whenever the set of watched addresses changes (add/remove/start/stop). On a log, run `checkAddress` for that watched wallet (debounce 2 s per wallet). On WSS error, log and rely on the poll; reconnect on the next rebuild.
- `setInterval(POLL_MS)` runs `checkAddress` for every enabled user; updates `watcher_state.last_poll_at`.
- `resumeWatchers(bot)`: at boot, for every `watcher_state.enabled = true`, call the in-memory registration without the balance check.
- `stopWatcher`: remove from the map, set `enabled = false`, rebuild subscriptions.
- `scripts/smoke.js <telegram_id>`: runs one `checkAddress` pass and prints decisions.

Acceptance on testnet: owner transfers ≥5% of a test token out of the watched wallet → "Sell detected" arrives within seconds → with `DRY_RUN=true` the bot replies "Would buy <token> for 0.005 ETH (dry run)" → baseline resets → a second transfer triggers again. Kill and restart the process: watcher resumes without pressing Start.

### Phase 4 — Executor (45 min)
- `services/uniswap.js`: `quote({ tokenOut, amountWei, swapper })` and `swap(quote)` per the spike; slippage 1; both throw with the API's error text.
- `executor.buy(bot, telegramId, token, sellKey)`: insert `trades(sell_key, status='pending')` — on conflict do nothing and return `{ skipped: true }`; if `DRY_RUN` mark `dry_run` and message; else quote → swap → `walletClient.sendTransaction({ to, value, data })` with the user's account → `waitForTransactionReceipt` → mark `confirmed` with hash → message with Blockscout link. On error mark `failed` with the message and tell the user, same wording as today's "Buy failed".
- Sends go through the Alchemy HTTPS RPC for the selected chain.

Acceptance on mainnet (`CHAIN=mainnet`, `DRY_RUN=false`, owner's 0.02 ETH): bot wallet funded with ~0.01 ETH, buy amount set to 0.001, owner sells 10% of a Pons token from the watched wallet → bot buys → Blockscout link opens → `trades` row confirmed. Then set `DRY_RUN` back per the owner's choice.

### Phase 5 — Website link (15 min)
- `moon-bag/app/site.js`: `export const BOT_URL = process.env.NEXT_PUBLIC_BOT_URL ?? "https://t.me/mooonbagbot"`.
- Last slide (`Faq` in `slides.js`): after the FAQ list, a centred `PillButton`-styled `<a href={BOT_URL}>` reading `Open Moonbag Bot →`, mono kicker above it not needed. Use an `<a>` (new tab) styled with the same classes as `PillButton`, `data-cursor`.
- Header (`Deck.js`): a small mono link top-left, `Telegram ↗`, `pointer-events-auto`, same `.t-label` size as the counter. No logo (owner's rule).
- Lint, build, push to `main` → Vercel deploys. Check the live page at 390 px and 1440 px.

### Phase 6 — Deploy (30 min)
- Railway: new service from the repo, root directory `bot`, Dockerfile build, variables from the list (`CHAIN=mainnet` or `testnet` per the owner, `DRY_RUN` per the owner), one replica, health check `/health`, public networking on (only for `/health`).
- Neon `main` branch for Railway; `dev` for the laptop.
- Verify: `/health` 200; `/start` in Telegram; Start Watching; restart the Railway deployment; Watch Addresses still Active and a smoke event still triggers.
- Update `CLAUDE.md` (paths, env, how to run) and `bot/README.md` (10 lines: run, env, deploy).

## How to run and test (for the owner, and for the next session)

```bash
cd bot
cp .env.example .env            # fill in the values yourself
npm install
npm run dev                     # nodemon --env-file=.env src/index.js
node --test                     # the one unit test
node scripts/spike-quote.js     # needs UNISWAP_API_KEY, mainnet only
node scripts/smoke.js <telegram_id>
```

Manual test loop on testnet: two wallets you control, A (watched) and B (anywhere). Wrap a little testnet ETH to WETH in A (or use any testnet ERC-20). In Telegram: Create Wallet → Add Watch Address (A) → Start Watching. Send ≥5% of A's WETH to B. Expect "Sell detected" then the dry-run buy message. Send some back to A: expect "Buy detected". Restart the bot: expect no re-triggers and Active status intact.

Mainnet test: same loop with `CHAIN=mainnet`, `DRY_RUN=false`, a Pons token in A, buy amount 0.001 ETH, bot wallet funded with 0.01 ETH.

## Things to keep in mind

- Uniswap's Trading API and contracts exist only on mainnet 4663. Testnet proves everything except the swap; the swap is proven on mainnet with cents of gas and 0.001 ETH buys.
- Buying with native ETH needs no approval. Selling would; we do not sell.
- Alchemy free tier: WSS subscriptions are cheap; `alchemy_getTokenBalances` every 60 s per watched wallet is fine for a handful of users.
- One replica only: Telegram long-polling and the WSS subscription both assume a single process.
- `DRY_RUN` is a real branch in `executor.buy`, not a log level. Default it to `true` in `.env.example`.
- Keep amounts as `bigint` (viem) and store as `numeric`; never `Number()` a wei value.
- Token metadata reads can fail for weird tokens; fall back to the address, as today.
- The `${value} SOL` bug in the high-amount warning exists today; fix while porting.
- Do not add settings, fees, gates or a second chain. If a step tempts you to, write it in "Later" below instead.
- Commit after each phase on branch `robinhood-mvp`; merge to `main` at the end (that deploys the site; Railway deploys from its own branch setting).

## Tools available to the next session

`vercel` (logged in), `gh` (logged in), `docker`, `ngrok`, `cloudflared`, Node 22, npm registry reachable. Railway and Neon CLIs are not installed; use their dashboards (owner) or `npm i -g @railway/cli neonctl` if wanted. The Chrome MCP can drive dashboards the owner is logged into if he asks. Chrome 152 headless hangs; use Playwright's headless shell for screenshots (see the brand-kit `render.sh`).

## Later (explicitly not tonight)

Fees to a treasury, $MOON holder gate, target ladders and selling, subscriptions, Privy server wallets, Alchemy Address Activity webhooks, hood.fun curve adapter, TypeScript, Drizzle migrations, a second replica, gas sponsorship.

Suggested after the test session (priority order):
1. Cap retries at three per sell, then one "paused, top up and press Start" message.
2. Check the bot wallet holds buy amount + gas before quoting; skip with a clear message.
3. The sell side (the site's promise): per token, a target multiple and a moonbag percentage; hold until the target, sell the rest, keep the percentage. Needs price data (Trading API quote) and ERC-20 approvals.
4. Minimum position value in ETH so dust tokens do not trigger buys.
5. "My Moonbags" button listing what the bot bought, from `trades`, with Blockscout links.
6. Bridge link with the bot address prefilled in the Create Wallet message.
7. Detect "watching your own bot wallet" at add time and say so.
8. Watch-only mode: alerts without buying.
