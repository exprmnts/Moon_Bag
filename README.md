# Moonbag

A Telegram bot on Robinhood Chain that makes sure you always keep a moonbag. It watches wallets you name; when one of them sells 5% or more of a token, the bot buys that token with a fixed amount of ETH into a separate bot wallet that it never sells from.

- Bot: [@mooonbagbot](https://t.me/mooonbagbot)
- Site: https://moonbagbot.vercel.app

## Repository

| Folder | What | Stack | Deploys to |
| --- | --- | --- | --- |
| `bot/` | The Telegram bot | Node 22, Telegraf 4, viem, Postgres (`pg`), Uniswap Trading API | Railway (Dockerfile) |
| `moon-bag/` | The pitch-deck website | Next.js 14, Tailwind, `motion` | Vercel, from `main` |

## Start here

1. `DEPLOYMENT.md` — how to run locally, what accounts and variables you need, the pre-launch checklist, and the Railway and Vercel steps.
2. `bot/ARCHITECTURE.md` — how the bot works: the rule, the data flow, the tables, concurrency, failure modes, and how to test it.
3. `ROADMAP.md` — the MVP plan that was executed (Solana → Robinhood Chain). Its decisions are settled.
4. `ROADMAP-V2.md` — what to build next, ranked, with effort and dependencies.
5. `CLAUDE.md` — working rules for the repo (also useful for humans).

## Quick start

```bash
# bot (testnet, dry run)
cd bot && cp .env.example .env   # fill in the values, see DEPLOYMENT.md
npm install && npm test && npm run dev
curl localhost:3000/health

# site
cd moon-bag && npm install && npm run dev -- -p 3001
```

Only one bot process may run at a time, anywhere: Telegram long-polling and the WebSocket subscription both assume a single instance.
