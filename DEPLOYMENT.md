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
| `PORT` | host | `/health` and keep-alive. Railway injects its own; the bot reads whatever is set. |

Nothing else is configurable by environment. Buy amount default (0.005 ETH), the 5% threshold, 1% slippage and the 60 s poll are constants in `bot/src/config.js`.

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

Testnet facts: chain id 46630, RPC `https://rpc.testnet.chain.robinhood.com`, explorer `https://explorer.testnet.chain.robinhood.com`, faucet `https://faucet.testnet.chain.robinhood.com` (needs a browser). Gas is about 0.01 gwei, so 0.0001 ETH covers roughly 180 transfers. The WETH wrapper with `deposit()` is `0x33e4191705c386532ba27cbf171db86919200b94`. Uniswap does not exist on testnet: testnet proves everything except the swap.

### Manual test loop (testnet)

Two wallets you control: A (watched) and B (anywhere). Wrap a little ETH to WETH in A. In Telegram: `/start` → Create Wallet → send a little testnet ETH to that address (Enable Moonbags refuses a wallet with 0 ETH) → Add Trading Wallet (A) → Enable Moonbags. Send ≥5% of A's WETH to B: expect "Sell detected" then "Would buy WETH for 0.005 ETH (dry run)" within seconds. Send some back: expect "Buy detected". Restart the bot: Trading Wallets still shows Moonbags Enabled and nothing re-triggers.

### Automated testing

`npm test` covers the pure rule. Everything else is verified with harnesses that stub `Telegram.prototype.callApi` and push fake updates through `bot.handleUpdate` against a real Neon dev branch and Alchemy testnet. `src/index.js` exports `{ bot }` and only boots when run directly, so a harness can `require` it. See `bot/ARCHITECTURE.md` §8 for the pattern.

## 3. Pre-launch checklist (mainnet)

Do these in order. The first three are the ones people forget.

- [ ] **Empty database for mainnet.** Never point mainnet at a branch that has testnet data. Baselines from testnet tokens read as 100% sells on mainnet and fire buys on the first poll. Create the Neon `main` branch (or a new project) and use its pooled string. The schema creates itself at boot.
- [ ] **Rotate any secret that was ever pasted into a chat or ticket.** BotFather `/revoke`, Neon password reset. Put new values straight into Railway and `.env`.
- [ ] **Back up `MASTER_ENCRYPTION_KEY` offline.** Pick one for production and never change it: it decrypts every user's wallet. Losing it loses every wallet the bot holds.
- [ ] Alchemy app has Robinhood Chain **Mainnet** enabled (check with `CHAIN=mainnet node scripts/spike-ws.js "" 10`).
- [ ] `node scripts/spike-quote.js` returns `/swap 200` with your Uniswap key.
- [ ] No other bot process is running anywhere (laptop, another host). Telegram returns 409 conflicts otherwise.
- [ ] BotFather polish: `/setdescription`, `/setabouttext`, `/setcommands` (`start`, `help`), `/setuserpic` from the brand kit.
- [ ] Decide the FAQ on the site: it still mentions a 1% fee, holder access and subscriptions, none of which exist in the bot.

## 4. Railway (bot)

1. https://railway.com/new → Deploy from GitHub → `exprmnts/Moon_Bag`, branch `main`.
2. Service settings: **root directory `bot`** (set this in the dashboard; it is the one thing `railway.json` cannot set), region **US East** (Neon is in `us-east-2`), and **App Sleeping / Serverless off**: the bot has no inbound traffic and would be put to sleep. Builder (Dockerfile), health check path (`/health`, 30 s timeout), one replica and restart-on-failure come from `bot/railway.json` and are applied automatically.
3. Variables: the eight from §1. `CHAIN=mainnet`, `DRY_RUN=true` for the first observed run.
4. Deploy. Logs must show, in order: `[boot] schema ok; chain=mainnet`, `[http] listening`, `[boot] @mooonbagbot is polling`, `[watcher] resumed N watcher(s)`.
5. Open `<service-url>/health`: expect `{"ok":true,"chain":"mainnet",...}`.
6. In Telegram: `/start`, Create Wallet. This is a **new** wallet in the new database; fund this address.
7. Add a trading wallet that trades Pons tokens, Enable Moonbags, wait for a real sell: expect "Sell detected" and "Would buy".
8. Flip `DRY_RUN=false` in Railway (redeploys). Set buy amount to 0.001, fund the bot wallet with ~0.01 ETH, sell 10% of a graduated Pons token from the watched wallet: expect "Auto-buy complete" with a Blockscout link and a `confirmed` row in `trades`.
9. Restart the deployment once. Trading Wallets must still show Moonbags Enabled without pressing Enable again.

Rollback: Railway → Deployments → redeploy the previous one. The schema is additive (`create table if not exists`), so older code runs against a newer database.

## 5. Vercel (site)

Already configured: project `moonbagbot`, root directory `moon-bag`, auto-deploys on push to `main`, env `NEXT_PUBLIC_BOT_URL=https://t.me/mooonbagbot` (production and preview). Fallbacks in `moon-bag/app/site.js`.

Before pushing site changes: `npm run lint && npm run build` in `moon-bag/`, then look at 390 px and 1440 px. The page must never scroll horizontally, and every slide must fit the screen (see `CLAUDE.md`).

## 6. Operating it

- **Health:** `/health` returns `{ ok, chain, chainId, dryRun, watchers, wss, addresses }`. `wss:false` means the socket died; the 60 s poll keeps working and rebuilds the socket on its next tick.
- **Logs to know:** `[watcher] transfer touching <addr> at block N` (event path fired), `[executor] <key> sent <hash>` (swap sent), `[executor] <key> failed: <reason>`, `[watcher] WSS error, relying on the poll`.
- **Costs:** Alchemy free tier (30M CU/month) covers a few dozen watched wallets; check the usage graph after day one. Neon free plan compute runs out mid-month because the poll keeps the database awake every minute: use the Launch plan or make the poll database-free (see `ROADMAP-V2.md`). Railway Hobby is enough.
- **Known behaviours (by design, decide before scale):** a failed buy keeps its baseline and retries on every check, so an unfunded wallet gets a message a minute until funded or stopped; fresh Pons tokens still on the bonding curve return "Buy failed" (no Uniswap route) until the curve adapter exists; there is no minimum position value, so dust tokens trigger buys too; the high-amount warning fires above 1 ETH.
- **Secrets:** never log or paste them. `bot/.env` is git-ignored. The Alchemy key is embedded in the RPC/WSS URLs and never leaves the server.

## 7. Release procedure

1. Branch from `main`, change, `npm test` (bot) or `npm run lint && npm run build` (site).
2. Push the branch, merge to `main`. Vercel deploys the site on its own. Railway deploys the bot from `main` on its own if auto-deploy is on for the service; otherwise trigger it in the dashboard.
3. Watch the Railway logs for the four boot lines and hit `/health`.
4. Commit `bot/package-lock.json` only when dependencies changed; the Dockerfile runs `npm ci`, so the lockfile must match `package.json`.
