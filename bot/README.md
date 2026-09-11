# Moonbag bot

Telegram bot on Robinhood Chain. It watches wallets you name; when a token in one of them drops 5% or more from its baseline, it buys that token with your bot wallet's fixed ETH amount (default 0.005 ETH) through the Uniswap Trading API. It never sells.

1% of every buy is the Moonbag fee, taken **in the token bought**, not in ETH: the user spends their full ETH amount, 99% of the tokens land in their wallet and 1% goes to `TREASURY_ADDRESS` in the same swap transaction. Mainnet will not boot without a treasury address.

A buy that fails for a transient reason is retried in the background up to five times; the user sees one message that changes rather than one per attempt. Failures a retry cannot fix go to `ADMIN_CHAT_ID`.

The logs are meant to be readable: at the default `LOG_LEVEL=info` a buy that works prints two lines and a quiet minute prints nothing. Set `LOG_LEVEL=debug` when you need every trigger, every duplicate sell and the gas arithmetic.

## Run

```bash
cp .env.example .env            # fill in the values (see ../ROADMAP.md for where each comes from)
npm install
npm run dev                     # nodemon, testnet + DRY_RUN=true by default
npm test                        # pure logic: decide(), fee(), errors()
node scripts/spike-quote.js     # Uniswap quote + swap build on mainnet (nothing sent)
node scripts/spike-ws.js [addr] # WSS Transfer subscription check
node scripts/smoke.js <telegram_id>   # one check pass for a user, decisions printed
curl localhost:3000/health
```

End-to-end, with a throwaway Postgres and a local fork (no real money, no real Telegram):

```bash
docker run -d --name moonbag-test-pg -e POSTGRES_PASSWORD=moonbag \
  -e POSTGRES_USER=moonbag -e POSTGRES_DB=moonbag -p 55432:5432 postgres:16-alpine
node scripts/e2e-ui.js          # every button, every prompt, the retry queue

anvil --fork-url https://robinhood-mainnet.g.alchemy.com/v2/$ALCHEMY_API_KEY \
      --chain-id 4663 --port 8545 --silent &
RPC_URL=http://localhost:8545 node scripts/e2e-chain.js   # a real swap against forked state
```

`CHAIN=testnet` proves everything except the swap (Uniswap only exists on mainnet 4663). `DRY_RUN=false` with `CHAIN=mainnet` sends real swaps.

## Layout

| File | Role |
| --- | --- |
| `src/config.js` | env parsing, chain constants, `DEFAULT_BUY_ETH`, thresholds, retry, gas and log settings |
| `src/log.js` | `LOG_LEVEL`: what reaches the console, and at which level |
| `src/index.js` | Telegraf handlers, boot (`ensureSchema` → launch → `resumeWatchers` + retry worker), `/health` |
| `src/ui.js` | keyboards, screens, force-reply questions, message deletion — everything the chat looks like |
| `src/wallet.js` | users, AES-256-GCM key storage, buy amount, watched wallets, conversation slot |
| `src/decide.js` | the pure new / up / sell / none rule |
| `src/errors.js` | pure: what a failure means, whether to retry it, and what to tell the user |
| `src/fee.js` | the 1% fee, pure: build `integratorFees`, verify the quote pays the treasury, read the receipt |
| `src/watcher.js` | WSS Transfer subscriptions + 60 s poll → `checkAddress` → `executor.buy` |
| `src/executor.js` | `trades` row per sell (dedupe), dry run, quote → gas estimate → send → receipt, retry scheduling |
| `src/retry.js` | the worker that runs due attempts every 10 s |
| `src/services/` | `db` (pg Pool, `schema.sql` at boot), `crypto`, `alchemy` (viem clients, balances, token metadata), `uniswap`, `alerts` |

## Deploy (Railway)

New service from GitHub `exprmnts/Moon_Bag`, root directory `bot`, Dockerfile build, one replica, health check path `/health`. Variables: everything in `.env.example` with the Neon `main` branch string, `CHAIN=mainnet`, `DRY_RUN=false` (or `true` to observe first), and `TREASURY_ADDRESS` (mainnet refuses to boot without it). Only one instance may run at a time: Telegram long-polling and the WSS subscription both assume a single process.
