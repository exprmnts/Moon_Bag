# Roadmap v2 — after the Robinhood Chain MVP

Written 2026-09-04 at the end of the port. `ROADMAP.md` (the MVP) is done; this is what comes next, ranked by impact. Nothing here is started. The three at the top are the game changers; the rest make them hold up under real money.

## Where the product is

Today: an alert bot that rebuys. It watches wallets, and when one sells 5% or more of a token it buys 0.005 ETH of that token into the bot wallet and never sells. It only works on tokens that already graduated from the Pons curve to Uniswap. Twelve buttons, a new menu on every tap.

After this list: the moonbag keeper for Robinhood Chain. From the first minute of a launch, every sell keeps a slice; the slice is held to the user's targets and shown as a portfolio; one live screen in Telegram runs it all.

## Guardrails first (ship before item 1; all small)

1. Cap buy retries at three per sell, then one "paused, top up and press Start" message. Today a failed buy keeps its baseline and retries every check.
2. Check the bot wallet holds buy amount plus gas before quoting; skip with a clear reason.
3. Neon: move to the Launch plan, or make the poll database-free so the free compute can sleep (cache the wallet list in memory, write `last_poll_at` only when something changed).
4. Cap watched wallets per user (five) and put an uptime check on `/health`.

## Ranked

### 1. The sell side: targets and the kept slice — ~2 weeks

Why: it is the promise on the site ("you cannot sell it all until your targets are hit") and the only reason to hold $MOON. The bot buys and stops today.

- Per token: a target ladder (e.g. sell 50% at 2×, 25% at 5×) and a kept percentage the bot can never sell. Only Export Key reaches it.
- Price in ETH via the Uniswap quote API, polled per held token, cached ~60 s.
- Selling needs an ERC-20 approval to Permit2 and a token-in swap; buying never did.
- A holdings table for the bot wallet's own positions, separate from watched wallets.
- Alerts at each rung with Sell now / Hold buttons.

Needs: the mainnet swap proven; the price layer (shared with item 4). Risk: approvals, thin pools.

### 2. Buy on the Pons curve, before graduation — ~1 week plus contract research

Why: new tokens trade on the Pons v2 bonding curve until they graduate into a locked Uniswap v4 pool. The Trading API very likely cannot route a curve token, so the bot says "Buy failed" exactly when a moonbag is worth keeping.

- First, ten minutes: `node scripts/spike-quote.js <un-graduated Pons token>`. If it routes, this item disappears.
- If not: a curve adapter. Read the Pons v2 factory and hook, buy with ETH through the curve's own function, detect graduation, switch to the Uniswap route.
- Pairs: Pons v2 launches against ETH, USDG and tokenized stocks.

Risk: Pons contracts may change (Uniswap Labs acquired PONS in September 2026).

### 3. One live screen, and alerts you can act on — 2 to 3 days

Why: every tap sends a fresh twelve-button menu; the chat is a wall and the state is nowhere. Trading bots feel like apps because one message edits itself in place. The sell alert is the moment users look, and it has no buttons.

- `/start` creates the wallet and shows one dashboard (address, ETH, status, buy amount, wallets watched). Every button edits that message; Back returns to it.
- Six rows: Balance | Deposit; Watch: Add | Remove | List; Buy amount; Positions; one Start-or-Stop toggle; Settings (Export Key, Help).
- Buy-amount presets; force-reply prompts with Cancel; paste-to-watch (any 0x address in chat asks "Watch this wallet?").
- Alerts with buttons: View on Blockscout, Mute this token, Buy more.
- Slash commands registered in BotFather (`/watch`, `/unwatch`, `/amount`, `/status`, `/positions`). Buttons and commands both.

Needs nothing new; the handlers exist.

### 4. A value-aware brain — 3 to 4 days

Why: the rule is balance-only. A 5% move in a dust token triggers a 0.005 ETH buy, and a $2 sell looks like a $2,000 one.

- Price every token in ETH through the quote API, cached.
- Minimum position value before a sell counts.
- Size the buy from what was sold (a percentage of the sold value, capped) instead of one fixed number.
- ETH value in every message; a digest for "Buy detected" noise on busy wallets.

Needs the price layer from item 1.

### 5. Onboarding onto the chain — 2 to 3 days

Why: the biggest drop-off is getting ETH onto Robinhood Chain, not the bot.

- First-run checklist on the dashboard with live ticks: fund, add a wallet, start.
- Bridge deep link with the bot address prefilled; QR for Robinhood Wallet.
- "Your wallet is funded" the moment the first ETH lands (subscribe the bot wallet on the existing WebSocket).
- Offer to watch the user's own trading wallet at signup.

### 6. Make the site's promises true, or delete them — 2 to 4 days

Why: the FAQ promised a 1% fee, early access for $MOON holders and subscriptions. The fee now exists (2026-09-05) and the site says what it really does. The gate and subscriptions still do not exist. This is the monetization and the trust question.

- $MOON gate: balance check at `/start` against a threshold; clear "hold X $MOON to use the bot" message.
- ~~1% fee carved out of each buy to a treasury address~~ **Done, 2026-09-05.** 1% of every buy, taken in the token bought, paid to `TREASURY_ADDRESS` inside the swap via the Trading API's `integratorFees`. There is no sell side, so there is no sell fee. See `FEE-PLAN.md`.
- Or rewrite the FAQ to what is real. Owner's decision.

### 7. The moonbag portfolio, then the Mini App — 2 days text; Mini App 4+ weeks, later

Why: users need to see what the bot kept and what it is worth; that screen is what they post.

- "My Moonbags": every kept position from `trades` with current ETH value, change since bought, target progress.
- Later, a Telegram Mini App for the same data with charts and a target-ladder editor, opened from the dashboard. Not before there is a portfolio worth a chart.

Needs items 1 and 4.

## Sequence

| Week | Ship | Why this order |
| --- | --- | --- |
| 1 | Guardrails · item 3 · the ten-minute Pons quote test | Cheap; decides whether item 2 is needed |
| 2–3 | Item 1 with the price layer built for item 4 | The core loop |
| 3–4 | Item 2 if the quote test failed | Makes the loop fire on launches |
| 4 | Items 4 and 5 | Proportional buys; a funded first session |
| 5 | Item 6 | Gate and fee once the loop is trusted |
| 6 | Item 7, text version | Something to post |

## Explicitly not on this list

Fees to a treasury beyond item 6, subscriptions, Privy or other server wallets, Alchemy Address Activity webhooks, TypeScript, Drizzle migrations, a second replica, gas sponsorship, a second chain. Revisit after item 7.
