# Deployment guide

For whoever runs, tests or deploys Moonbag. Read `bot/ARCHITECTURE.md` first if you have not seen the code.

There are two deployables: the **bot** (`bot/`, Railway, Dockerfile) and the **site** (`moon-bag/`, Vercel, auto-deploys from `main`). The bot needs five external accounts; the site needs none beyond Vercel.

## 1. Accounts and where each value comes from

| Variable | Where | Notes |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | https://t.me/BotFather → `/newbot` or `/token` | The bot is `@mooonbagbot`. `/revoke` rotates the token. |
| `DATABASE_URL` | https://console.neon.tech → project → branch → Connect → **pooled** string | Use a separate branch (or project) per environment. See §4. |
| `ALCHEMY_API_KEY` | https://dashboard.alchemy.com → app with **Robinhood Chain Mainnet + Testnet** enabled | RPC and WSS URLs are derived from the key in `src/config.js`. |
| `UNISWAP_API_KEY` | https://developers.uniswap.org/dashboard | Mainnet swaps only. Default limit 6 requests/s. |
| `MASTER_ENCRYPTION_KEY` | `openssl rand -hex 32` | Encrypts every user's private key. See §4. |
| `CHAIN` | you | `testnet` (46630) or `mainnet` (4663). Selects RPC, WSS, explorer, chain id. |
| `DRY_RUN` | you | `true` = never send a swap, message "Would buy" instead. A real code branch in `executor.buy`. |
| `TREASURY_ADDRESS` | you | Public address that receives 1% of the tokens on every buy. **Required on mainnet**: the bot refuses to boot without it. Address only, never a private key. Must not be a wallet anyone watches with the bot (see §3). |
| `ADMIN_CHAT_ID` | you | Optional but strongly recommended. The Telegram chat that receives failure alerts. Either your own user id, or a group id — add the bot to the group first, then read the id from `getChat`. **Basic groups have short negative ids** (`-5342855733`); only supergroups and channels start with `-100`. Both are valid; do not "fix" a short one. Anyone in this chat can run `/retry all`. Without it, a buy that gives up after five attempts is only visible in the log. |
| `PORT` | host | `/health` and keep-alive. Railway injects its own; the bot reads whatever is set. |
| `LOG_LEVEL` | you | `debug` \| `info` (default) \| `warn` \| `error` \| `silent`. `info` prints state changes only — two lines per buy, nothing when idle. Use `debug` while diagnosing; it adds every trigger, every duplicate sell and the gas arithmetic. A bad value refuses to boot. |
| `RPC_URL` / `WSS_URL` | — | Optional overrides for the Alchemy endpoints. Only for pointing a local test run at an anvil fork; never set in production. |

Nothing else is configurable by environment. Buy amount default (0.005 ETH), the 5% threshold, 1% slippage, the 60 s poll, the fee rate (`FEE_BIPS = 100`, i.e. 1%), the retry budget (five attempts) and the gas buffer (35%) are constants in `bot/src/config.js`.

## 2. Run locally

```bash
cd bot
cp .env.example .env          # fill in; CHAIN=testnet DRY_RUN=true for development
npm install
npm test                      # decide() unit test
npm run dev                   # nodemon
curl localhost:3000/health    # {"ok":true,"chain":"testnet",...}
```

Useful scripts:

```bash
node scripts/spike-quote.js [tokenOut] [swapper]   # Uniswap /quote + /swap on mainnet, nothing sent
node scripts/spike-ws.js [fromAddress] [seconds]    # prove the WSS Transfer subscription on the selected chain
node scripts/smoke.js <telegram_id>                 # one watcher pass for a user, decisions printed, no messages sent
```

End to end, with no real money and no real Telegram:

```bash
docker run -d --name moonbag-test-pg -e POSTGRES_PASSWORD=moonbag \
  -e POSTGRES_USER=moonbag -e POSTGRES_DB=moonbag -p 55432:5432 postgres:16-alpine
node scripts/e2e-ui.js        # every button, both questions, the key timer, the retry queue

anvil --fork-url https://robinhood-mainnet.g.alchemy.com/v2/$ALCHEMY_API_KEY \
      --chain-id 4663 --port 8545 --silent &
RPC_URL=http://localhost:8545 node scripts/e2e-chain.js   # a real swap against forked mainnet state
```

Testnet facts: chain id 46630, RPC `https://rpc.testnet.chain.robinhood.com`, explorer `https://explorer.testnet.chain.robinhood.com`, faucet `https://faucet.testnet.chain.robinhood.com` (needs a browser). Gas is about 0.01 gwei, so 0.0001 ETH covers roughly 180 transfers. The WETH wrapper with `deposit()` is `0x33e4191705c386532ba27cbf171db86919200b94`. Uniswap does not exist on testnet: testnet proves everything except the swap.

### Manual test loop (testnet)

Two wallets you control: A (watched) and B (anywhere). Wrap a little ETH to WETH in A. In Telegram: `/start` → Create Wallet → send a little testnet ETH to that address (Enable Moonbags refuses a wallet with 0 ETH) → Add Trading Wallet (A) → Enable Moonbags. Send ≥5% of A's WETH to B: expect "Sell detected" then "Would buy WETH for 0.005 ETH (dry run)" within seconds. Send some back: expect "Buy detected". Restart the bot: Trading Wallets still shows Moonbags Enabled and nothing re-triggers.

### Automated testing

`npm test` covers the pure logic (the rule, the fee, error classification); `scripts/e2e-ui.js` and `scripts/e2e-chain.js` cover the rest without touching production. Everything else is verified with harnesses that stub `Telegram.prototype.callApi` and push fake updates through `bot.handleUpdate` against a real Neon dev branch and Alchemy testnet. `src/index.js` exports `{ bot }` and only boots when run directly, so a harness can `require` it. See `bot/ARCHITECTURE.md` §8 for the pattern.

## 3. Pre-launch checklist (mainnet)

Do these in order. The first three are the ones people forget.

- [ ] **Empty database for mainnet.** Never point mainnet at a branch that has testnet data. Baselines from testnet tokens read as 100% sells on mainnet and fire buys on the first poll. Create the Neon `main` branch (or a new project) and use its pooled string. The schema creates itself at boot.
- [ ] **Rotate any secret that was ever pasted into a chat or ticket.** BotFather `/revoke`, Neon password reset. Put new values straight into Railway and `.env`.
- [ ] **Back up `MASTER_ENCRYPTION_KEY` offline.** Pick one for production and never change it: it decrypts every user's wallet. Losing it loses every wallet the bot holds.
- [ ] Alchemy app has Robinhood Chain **Mainnet** enabled (check with `CHAIN=mainnet node scripts/spike-ws.js "" 10`).
- [ ] `node scripts/spike-quote.js` returns `/swap 200` with your Uniswap key.
- [ ] No other bot process is running anywhere (laptop, another host). Telegram returns 409 conflicts otherwise.
- [ ] BotFather polish: `/setdescription`, `/setabouttext`, `/setcommands` (`start`, `help`), `/setuserpic` from the brand kit.
- [ ] **Treasury set and separate.** `TREASURY_ADDRESS` is in the Railway variables (mainnet refuses to boot without it) and is **not** an address any user watches as a trading wallet. If it is, every fee payment shows up as "Buy detected" on that wallet and moves its baselines; the boot log warns about it.
- [ ] `node scripts/spike-quote.js` shows an `INTEGRATOR` output to the treasury at 100 bps before the first real buy.
- [ ] The site still promises holder access and subscriptions, which do not exist in the bot. The fee promise is now true (`ROADMAP-V2.md` item 6).

## 4. Railway (bot)

1. https://railway.com/new → Deploy from GitHub → `exprmnts/Moon_Bag`, branch `main`.
2. Service settings: **root directory `bot`** (set this in the dashboard; it is the one thing `railway.json` cannot set), region **US East** (Neon is in `us-east-2`), and **App Sleeping / Serverless off**: the bot has no inbound traffic and would be put to sleep. Builder (Dockerfile), health check path (`/health`, 30 s timeout), one replica and restart-on-failure come from `bot/railway.json` and are applied automatically.
3. Variables: the nine from §1 (`TREASURY_ADDRESS` included; mainnet will not boot without it). `CHAIN=mainnet`, `DRY_RUN=true` for the first observed run.
4. Deploy. Logs must show, in order: `[boot] schema ok; chain=mainnet`, `[http] listening`, `[boot] @mooonbagbot is polling`, `[watcher] resumed N watcher(s)`.
5. Open `<service-url>/health`: expect `{"ok":true,"chain":"mainnet",...}`.
6. In Telegram: `/start`, Create Wallet. This is a **new** wallet in the new database; fund this address.
7. Add a trading wallet that trades Pons tokens, Enable Moonbags, wait for a real sell: expect "Sell detected" and "Would buy".
8. Flip `DRY_RUN=false` in Railway (redeploys). Set buy amount to 0.001, fund the bot wallet with ~0.01 ETH, sell 10% of a graduated Pons token from the watched wallet: expect "Auto-buy complete" naming the tokens received and the Moonbag fee, a Blockscout link, and a `confirmed` row in `trades` with `fee_amount` and `tokens_out` filled in. On Blockscout the transaction must show **two** transfers of that token: 99% to the bot wallet and 1% to the treasury.
9. Restart the deployment once. Trading Wallets must still show Moonbags Enabled without pressing Enable again.

Rollback: Railway → Deployments → redeploy the previous one. The schema is additive (`create table if not exists`), so older code runs against a newer database.

## 5. Vercel (site)

Already configured: project `moonbagbot`, root directory `moon-bag`, auto-deploys on push to `main`, env `NEXT_PUBLIC_BOT_URL=https://t.me/mooonbagbot` (production and preview). Fallbacks in `moon-bag/app/site.js`.

Before pushing site changes: `npm run lint && npm run build` in `moon-bag/`, then look at 390 px and 1440 px. The page must never scroll horizontally, and every slide must fit the screen (see `CLAUDE.md`).

## 6. Operating it

- **Health:** `/health` returns `{ ok, chain, chainId, dryRun, watchers, wss, addresses }`. `wss:false` means the socket died; the 60 s poll keeps working and rebuilds the socket on its next tick.
- **Logs to know.** At the default `LOG_LEVEL=info`, a buy that works is exactly two lines and an idle bot is silent, so anything else in the log is worth reading:

  ```
  [executor] 990333293 0xcb6f…1e18 buying MOON for 0.005 ETH · gas 1468280 · 0xd26aeda5…9640bf
  [executor] 990333293 0xcb6f…1e18 confirmed 0xd26aeda5…9640bf · +5,137.591536 MOON · fee 51.894866 → treasury
  ```

  Worth reacting to: `[executor] … attempt 3/5 failed [CODE]` (a retry is running), `[ui] <id> cannot be messaged … muted until they write` (see below), `[watcher] WSS error, relying on the poll`, `[alert] …` (anything here also went to `ADMIN_CHAT_ID`). Set `LOG_LEVEL=debug` to get the old per-trigger detail back: every transfer touching a watched wallet, every duplicate sell collapsing into one buy, the full sell key, and the gas arithmetic behind each swap.
- **A user the bot cannot message.** `400: chat not found` or `403: bot can't initiate conversation` means that person has never opened a private chat with the bot. Their buys keep running and keep costing them ETH; they just hear nothing. The bot records it in `users.unreachable_at`, alerts `ADMIN_CHAT_ID` **once**, and stops trying. It clears itself the moment that user sends anything to the bot in the chat they want alerts in. To find them: `select telegram_id, unreachable_at, unreachable_reason from users where unreachable_at is not null;` To stop their buys instead: `update watcher_state set enabled = false where telegram_id = '<id>';` and restart, or have them tap the toggle.
- **Revenue to date:** `select token, sum(fee_amount) from trades where status = 'confirmed' group by token;` Amounts are raw token units; divide by the token's decimals from the `tokens` table.
- **Costs:** Alchemy free tier (30M CU/month) covers a few dozen watched wallets; check the usage graph after day one. Neon free plan compute runs out mid-month because the poll keeps the database awake every minute: use the Launch plan or make the poll database-free (see `ROADMAP-V2.md`). Railway Hobby is enough.
- **Known behaviours (by design, decide before scale):** a failed buy keeps its baseline and retries on every check, so an unfunded wallet gets a message a minute until funded or stopped; fresh Pons tokens still on the bonding curve return "Buy failed" (no Uniswap route) until the curve adapter exists; there is no minimum position value, so dust tokens trigger buys too; the high-amount warning fires above 1 ETH.
- **Secrets:** never log or paste them. `bot/.env` is git-ignored. The Alchemy key is embedded in the RPC/WSS URLs and never leaves the server.

## 7. Release procedure

1. Branch from `main`, change, `npm test` (bot) or `npm run lint && npm run build` (site).
2. Push the branch, merge to `main`. Vercel deploys the site on its own. Railway deploys the bot from `main` on its own if auto-deploy is on for the service; otherwise trigger it in the dashboard.
3. Watch the Railway logs for the four boot lines and hit `/health`.
4. Commit `bot/package-lock.json` only when dependencies changed; the Dockerfile runs `npm ci`, so the lockfile must match `package.json`.
