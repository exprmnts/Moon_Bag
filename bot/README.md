# Moonbag bot

Telegram bot on Robinhood Chain. It watches wallets you name; when a token in one of them drops 5% or more from its baseline, it buys that token with your bot wallet's fixed ETH amount (default 0.005 ETH) through the Uniswap Trading API. It never sells.

1% of every buy is the Moonbag fee, taken **in the token bought**, not in ETH: the user spends their full ETH amount, 99% of the tokens land in their wallet and 1% goes to `TREASURY_ADDRESS` in the same swap transaction. Mainnet will not boot without a treasury address.

## Run

```bash
cp .env.example .env            # fill in the values (see ../ROADMAP.md for where each comes from)
npm install
npm run dev                     # nodemon, testnet + DRY_RUN=true by default
npm test                        # decide() unit test
node scripts/spike-quote.js     # Uniswap quote + swap build on mainnet (nothing sent)
node scripts/spike-ws.js [addr] # WSS Transfer subscription check
node scripts/smoke.js <telegram_id>   # one check pass for a user, decisions printed
curl localhost:3000/health
```

`CHAIN=testnet` proves everything except the swap (Uniswap only exists on mainnet 4663). `DRY_RUN=false` with `CHAIN=mainnet` sends real swaps.

## Layout

| File | Role |
| --- | --- |
| `src/config.js` | env parsing, chain constants, `DEFAULT_BUY_ETH`, thresholds |
| `src/index.js` | Telegraf handlers, boot (`ensureSchema` → launch → `resumeWatchers`), `/health` |
| `src/wallet.js` | users, AES-256-GCM key storage, buy amount, watched wallets, conversation slot |
| `src/decide.js` | the pure new / up / sell / none rule |
| `src/fee.js` | the 1% fee, pure: build `integratorFees`, verify the quote pays the treasury, read the receipt |
| `src/watcher.js` | WSS Transfer subscriptions + 60 s poll → `checkAddress` → `executor.buy` |
| `src/executor.js` | `trades` row per sell (dedupe), dry run, quote → swap → send → receipt |
| `src/services/` | `db` (pg Pool, `schema.sql` at boot), `crypto`, `alchemy` (viem clients, balances, token metadata), `uniswap` |

## Deploy (Railway)

New service from GitHub `exprmnts/Moon_Bag`, root directory `bot`, Dockerfile build, one replica, health check path `/health`. Variables: everything in `.env.example` with the Neon `main` branch string, `CHAIN=mainnet`, `DRY_RUN=false` (or `true` to observe first), and `TREASURY_ADDRESS` (mainnet refuses to boot without it). Only one instance may run at a time: Telegram long-polling and the WSS subscription both assume a single process.
