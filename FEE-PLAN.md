# Fee plan — 1% of every buy, taken in the token

Written 2026-09-05. Supersedes the "no fees" decision in `ROADMAP.md` and the fee half of `ROADMAP-V2.md` item 6, by the owner's decision.

## Status: BUILT (2026-09-05, branch `fee-in-token`)

The owner read the ETH-vs-token research in §0, chose the **token** fee anyway, and gave the treasury address. §1 to §9 describe what was built and are current; §0 is kept as the record of the decision, including the case for ETH that was not taken.

| | |
| --- | --- |
| Treasury | `0x37752B52C917E07181Fc36D0D5167159a0103d20` (in `bot/.env` as `TREASURY_ADDRESS`) |
| Rate | `FEE_BIPS = 100` (1%), on every buy, in the token bought |
| Proven | Real mainnet `/quote` returns two outputs, 9900 bps to the buyer and 100 bps to the treasury tagged `INTEGRATOR`, and `/swap` builds the calldata. Nothing sent. |
| Tests | `npm test` 15 pass, including a real mainnet quote parsed by `splitOutputs` and a tampered quote refused |
| Site | Slide 5 Revenue and FAQ item 2 rewritten, lint and build clean, no overflow at 390 / 1000×540 / 1440 |
| Not done | The one real mainnet buy (needs ~0.01 ETH in a bot wallet and `DRY_RUN=false`), and `TREASURY_ADDRESS` in the Railway variables |

**Open question for the owner:** the treasury address supplied is the same wallet recorded in earlier sessions as the owner's watched MetaMask trading wallet. It is not in the dev database's watch list today, so nothing is broken. If it is ever watched again, every fee payment will read as "Buy detected" on that wallet and raise its baselines, and fee income will be mixed in with personal trading. The bot warns about this at boot but does not refuse. A fresh address used only as the treasury avoids it.

## 0. ETH or the token? Research and recommendation (2026-09-05)

The owner asked which is better for Moonbag and for users: taking the 1% in ETH or in the token bought. Short answer: **at the moment of the trade they are worth the same to the user; the difference is entirely on our side, and it favours ETH today.** Take the fee in ETH now; revisit tokens once the bot can sell (ROADMAP-V2 item 1), because that is when a token treasury becomes manageable.

### What the market does

| Who | Fee | Taken in |
| --- | --- | --- |
| Maestro, BONKbot, Trojan, BullX, GMGN, Sigma | 1% flat per trade | the native coin (SOL / ETH) |
| Banana Gun | 0.5% manual buys, 1% sniper | ETH |
| Uniswap Labs interface (0.15%, ended Dec 2025) and most aggregator affiliate fees | small % | the **output token** |

Telegram bots, which are the product users will compare Moonbag to, all take native. Output-token fees are the norm only where the integrator is a router and has no wallet of its own. Both are understood by users; "1% fee" is what they read either way.

### For users: a wash

Spending 0.005 ETH and receiving 99% of the tokens (token fee) is the same as swapping 0.00495 ETH and receiving 100% of the tokens (ETH fee carved from the buy). Same ETH leaves, same tokens arrive. Two second-order effects, both small: a token fee scales with actual execution (slightly kinder under bad slippage); an ETH fee is fixed. The one thing users would notice later is a treasury that sells into tokens they still hold, which only a token fee creates.

### For Moonbag: why ETH wins today

- **The fee per buy is tiny.** At the 0.005 ETH default it is 0.00005 ETH. In ETH that pools into one growing balance that pays Railway, Alchemy and Neon. In tokens it is the same value fragmented into hundreds of dust positions, each needing a human to sell it, many with no pool left to sell into.
- **Base rates.** CoinGecko's study of 18.7M pump.fun launches (Jan 2024 to Jun 2026): 4.55% still traded after 90 days, 68.7% had their last trade on launch day. Moonbag only buys graduated tokens, which do better than raw launches, but the trigger is "an experienced wallet just sold 5% or more", so the basket leans toward tokens being exited. Break-even against simply holding ETH, if the rest of the basket falls 90%: about one 100× per 100 tokens. Nobody has that hit rate on an unselected basket.
- **Tax asymmetry (India, Section 115BBH; check with a CA).** Gains on virtual digital assets are taxed at 30% flat, and a loss on one token cannot be set off against the gain on another. A treasury of 100 tokens where 99 die and 1 does 10× pays 30% on the winner and gets nothing back for the 99. An ETH treasury has one asset and one gain. This alone turns the tail bet from "asymmetric upside" into "taxed upside, untaxed downside".
- **Conflict of interest.** Selling treasury tokens means dumping on users' moonbags, sometimes as a top holder. ETH has no such moment.
- **Restricted tokens.** Robinhood Chain carries tokenized stocks and permissioned pools; a fee paid in a transfer-restricted token can revert the whole swap. ETH cannot.
- **Bookkeeping.** Every token fee is income at its value on receipt, then a separate disposal later. Hundreds of them.

### What the token side has going for it

- Cheapest to build: Uniswap's `integratorFees` does it atomically in the swap (§2). ETH needs one extra transfer per buy.
- The story: "we hold the same moonbags you do" is real alignment and matches the deck's "1% of the moonbag" line.
- The tail: one 1000× pays for everything. This is the product's thesis. But users choose their moonbags with conviction; the treasury would get everything anyone's watched wallet ever sold, unselected.

### The 1000× question, money only (owner asked to ignore tax and law)

The owner's question: most tokens die, but if one does 1000×, does the token fee make more money than the ETH fee? The answer is arithmetic. In ETH terms:

> value of the token fee ÷ value of the ETH fee = the volume-weighted average multiple of the bot's buys, from the price the bot paid to the price the treasury sells at.

Above 1.0 the token fee made more; below it, less. So the question is "what is the average multiple of everything the bot buys", not "can one token do 1000×". One 1000× is worth 1000 slices; whether that beats ETH depends on how many other slices it has to carry.

**The base rate, on this chain.** Bitquery measured every Pons coin that graduated to Uniswap between 3 Aug and 3 Sep 2026 (207,893 launched, 3,228 graduated, 2,339 with enough trading data), opening-hour price vs 3 Sep price:

| Outcome after graduation | Coins | Share |
| --- | --- | --- |
| down more than 90% | 753 | 32% |
| down 75 to 90% | 930 | 40% |
| down 50 to 75% | 328 | 14% |
| down under 50% | 130 | 6% |
| up, under 3× | 114 | 5% |
| up more than 3× | 84 | 3.6% |
| best of all (microduck) | 1 | 267× |

Median coin: 85% below its opening hour. Fewer than one in ten above it. The best coin in a month of 200,000 launches did 267×, not 1000×.

**What that basket is worth.** Buy every one of those 2,339 coins equally in its opening hour and value it on 3 Sep: about **0.76×** the ETH spent, with 15% of that value sitting in microduck alone. That is the most generous possible entry: the bot enters later, when a watched wallet sells, so on the winners part of the run is already gone.

**The owner's scenario, 1,000 buys at 0.005 ETH (5 ETH volume, 0.05 ETH of fees):**

| Fee taken as | Worth |
| --- | --- |
| ETH | 0.0500 ETH, fixed |
| tokens, Pons-like basket, no 1000× | 0.0382 ETH |
| tokens + one 1000× per 100 buys, sold at the top | 0.538 ETH |
| tokens + one 1000× per 1,000 buys, sold at the top | 0.088 ETH |
| tokens + one 1000× per 1,000 buys, realized at 30% of peak | 0.053 ETH |
| tokens + one 1000× per 3,000 buys, sold at the top | 0.055 ETH |
| tokens + one 1000× per 10,000 buys, sold at the top | 0.043 ETH |

Break-even: one 1000× (measured from the bot's entry, not from launch) per ~4,000 buys if sold at the exact top, per ~1,300 buys if the treasury realizes 30% of the peak, which is what selling on the way down looks like (FARTCOIN and TRUMP sit 93 to 95% below their peaks). Pons' first month produced zero 1000× from the opening hour, let alone from a later sell.

**Two things that cut against the token fee that are easy to miss.** A wallet dumping a dying token in 5% tranches triggers a buy per tranche, so the basket is overweight tokens being distributed. And a "1000×" in the headlines is a peak; the treasury has to sell into it.

**What the token fee genuinely buys.** Coverage: the treasury automatically owns a slice of every winner any user ever rebuys, without picking. Unlimited upside on any one token. Those are real, and they are what a jackpot ticket offers.

### Recommendation

> **Decision (2026-09-05): the owner chose the token fee**, having read the case below. Built as described in §1 to §9. The recommendation that follows is kept as the record of the argument, not as a pending question.

**Fee in ETH, carved out of the buy amount** (the user's configured 0.005 ETH is exactly what leaves the wallet: 0.00495 swapped, 0.00005 to the treasury). Keep the alignment story with a policy rather than a mechanism: the treasury can buy $MOON or chosen moonbags with part of its ETH on its own terms. On money alone the ETH fee is expected to be worth more; the token fee wins only if the bot's buys average better than 1× in ETH terms, which needs roughly one 1000×-from-entry per thousand buys, and the chain's own first month shows nothing near that. If the owner wants the jackpot exposure anyway, the honest way is a **split** (for example 0.5% in ETH via the transfer and 0.5% in the token via `integratorFees`): guaranteed opex plus a slice of every winner, at the cost of building both paths. Move fully to token fees only when ROADMAP-V2 item 1 (the sell side) exists, because then the bot can run target ladders for the treasury the way it will for users.

### If ETH: what changes in this plan

§1 to §9 below describe the token mechanism (kept for the revisit). The ETH variant differs like this:

| Area | Token (below) | ETH |
| --- | --- | --- |
| Mechanism | `integratorFees` in `/quote`; one transaction | swap `buy − fee` ETH, then a plain ETH transfer of `fee` to the treasury; two transactions, swap first so a failed buy never pays a fee. Gas on Robinhood Chain is ~0.01 gwei, so the transfer costs nothing measurable. |
| `uniswap.js` | add the fee field, `splitOutputs` | unchanged |
| `executor.js` | persist fee outputs, parse receipt logs | after the swap receipt: `sendTransaction({ to: treasury, value: fee })`, record the hash; on failure mark `fee_status = 'pending'` and retry from the poll (cap three), user is never messaged about our retry |
| `trades` columns | `fee_bips, fee_recipient, fee_amount, tokens_out` | `fee_bips, fee_recipient, fee_wei, fee_tx_hash, fee_status` |
| `watcher.js` | unchanged | `pollOnce` also retries pending fee transfers |
| Balance guard | buy + gas | buy + gas (fee is inside the buy amount) |
| Messages | "You received 990,000 DOGE … fee 10,000 DOGE" | "Purchased DOGE for 0.00495 ETH (0.005 incl. 1% Moonbag fee)" |
| Site copy | slide 5 and FAQ reworded to tokens | slide 5 line 1 becomes "1% fee on every buy"; FAQ "1% of the ETH on every buy, sent to the Moonbag treasury"; line 2 decision unchanged |
| Treasury wallet | must handle hundreds of tokens | any address; ETH only |
| Proof | mainnet buy shows two token Transfers | mainnet buy shows the swap and a 0.00005 ETH transfer to the treasury |
| Effort | ~half a day | ~one day (the retry path) |

## 1. The decision

On every buy the bot makes, 1% of the tokens bought go to a Moonbag treasury wallet. The user still spends their full ETH buy amount; they receive 99% of the tokens and the treasury receives 1%. Nothing is taken in ETH, nothing is taken on the way out, and there is no sell side: the bot never sells, and the only way out of the bot wallet is Export Key.

Why tokens and not ETH: the fee is a position in every token the bot ever buys. A user's moonbag that runs 100× runs 100× for the treasury too.

## 2. How it works (the mechanism)

**The fee is taken inside the swap itself, by Uniswap, in the same transaction as the buy.** No second transaction, no treasury key on the server, no retry loop.

The Uniswap Trading API `/quote` request accepts an `integratorFees` field (live since March 2026; key-based fees were sunset in May 2026, so nothing has to be arranged with Uniswap):

```json
"integratorFees": [{ "bips": 100, "recipient": "<TREASURY_ADDRESS>" }]
```

- `bips` is basis points: 100 = 1%. The API allows more than 0 and at most 500 (5%). Exactly one entry.
- For an `EXACT_INPUT` swap the fee comes out of the **output token** and is sent to `recipient`.
- The `/quote` response reports it in `quote.aggregatedOutputs[]`: one entry for the user's tokens, one with `"fee": "INTEGRATOR"` for the treasury. Each has `amount`, `minAmount`, `bps`, `recipient`.
- `/swap` encodes the fee payment into the calldata. The user's bot wallet signs one transaction; the router pays 99% to the wallet and 1% to the treasury. If the swap reverts, neither happens.
- Native ETH input never routes through UniswapX (Uniswap's own FAQ), so the existing CLASSIC `/quote` → `/swap` → `sendTransaction` path is unchanged.
- Integer bips need no extra header. (Fractional bips would need `x-universal-router-version: 2.1.1`; we do not use them.)

Fallback only if the API refuses `integratorFees` on chain 4663 (unlikely, the field is chain-agnostic): a second ERC-20 `transfer` from the bot wallet to the treasury after the receipt, with a `fee_status` column and a retry in the poll. About one extra day. Not planned.

## 3. What changes, file by file

### Bot (`bot/`)

| File | Change |
| --- | --- |
| `src/config.js` | New env `TREASURY_ADDRESS` (validated with viem `isAddress`, stored checksummed). New constant `FEE_BIPS: 100`. `feeEnabled = Boolean(treasury) && FEE_BIPS > 0`. **Boot fails on `CHAIN=mainnet` without a treasury** so a forgotten Railway variable cannot silently run fee-free. Testnet tolerates it missing. |
| `src/services/uniswap.js` | `quote()` adds `integratorFees` when `config.feeEnabled`. New pure helper `splitOutputs(quoteResponse)` → `{ userAmount, feeAmount, feeBips, feeRecipient }` read from `aggregatedOutputs` (falls back to `quote.output.amount` with a zero fee when the array is absent). It **throws if the fee entry's recipient is not our treasury or its bps is not `FEE_BIPS`**, so the bot can never sign a swap that pays the wrong address. |
| `src/executor.js` | After `/quote`: persist `fee_bips`, `fee_recipient`, `fee_amount`, `tokens_out` on the `trades` row. After the receipt: parse the token's `Transfer` logs (to the bot wallet, to the treasury) for the actual amounts and overwrite the quoted ones. Messages: the dry-run line and the confirmation line gain the fee (see §5). |
| `schema.sql` | `alter table trades add column if not exists` × 4: `fee_bips int`, `fee_recipient text`, `fee_amount numeric`, `tokens_out numeric` (raw token units, bigint in code). Idempotent, runs at boot; no migration tool. |
| `src/index.js` | Help text gains the fee line; Set Buy Amount hint mentions the fee; `/health` adds `feeBips` and `treasury`. |
| `src/watcher.js` | No change. ("Sell detected … buying your moonbag for X ETH" stays true.) |
| `scripts/spike-quote.js` | Add `integratorFees` and print `aggregatedOutputs` and `quote.output.amount`, nothing sent. This is the first proof; pass = `/swap 200` and an `INTEGRATOR` output whose recipient is the treasury and whose amount is ~1% of the total. |
| `test/fee.test.js` | Unit test for `splitOutputs`: normal quote, missing array, wrong recipient (throws), wrong bps (throws). Same `node:test` style as `decide.test.js`. |
| `.env.example` | `TREASURY_ADDRESS=` with a comment. |

### Site (`moon-bag/`)

| File | Now | Proposed |
| --- | --- | --- |
| `app/components/slides.js` slide 5, Revenue line 1 | "1% transaction fee on all trades" | "1% fee on every buy, taken in the token" |
| `app/components/slides.js` slide 5, Revenue line 2 | "1% of the moonbag when you profit" | **Owner's decision** (§6). The bot cannot collect this: it never sells. Delete it, or keep it as a stated future. |
| `app/components/FAQ.js` item 2 | "Are there fees?" → "1% of tokens from all trades." | "1% of the tokens on every buy, sent to the Moonbag treasury. The bot never sells, so nothing is taken on the way out." |

`CLAUDE.md` says slide copy is verbatim from the deck except slide 4. Changing slide 5 and FAQ item 2 needs the owner's permission; this plan is that permission, and the rule in `CLAUDE.md` gets a note saying so. Both files are type only, no colour, so the design rules are untouched. After the edit: `npm run lint && npm run build`, then look at 390 px, 1000×540 and 1440 px (slide 5 must still fit the screen).

Not touched (still untrue on the site, out of scope here): "Early access, hold 1% $MOON", and the FAQ lines on subscriptions and holder access.

### Docs

| File | Change |
| --- | --- |
| `DEPLOYMENT.md` | §1: add the `TREASURY_ADDRESS` row; the "nothing else is configurable" sentence lists `FEE_BIPS` as a constant. §3: replace the "decide the FAQ" item with "treasury set on Railway; first real buy shows 1% at the treasury on Blockscout". §4: "the eight variables" becomes nine; step 8 expects two `Transfer` logs. §6: the `[executor] fee` log line. |
| `bot/ARCHITECTURE.md` | §3 `executor.buy` flow (quote with fee → split outputs → swap → receipt → parse logs); §4 `trades` columns; §7 config; §9 "what a buy does" row. |
| `bot/README.md` | First paragraph: "It never sells" gains "1% of every buy, in tokens, goes to the treasury." Deploy section lists the new variable. |
| `ROADMAP-V2.md` | Item 6: the fee bullet points here and is marked done once shipped; gate and subscriptions stay open. |
| `CLAUDE.md` | Status line; the verbatim-copy rule records the slide 5 / FAQ change. |

### Railway

Add `TREASURY_ADDRESS` to the service variables **before** the first `DRY_RUN=false` deploy. With the boot check above, a mainnet deploy without it stops at `[boot]` with a clear error instead of trading fee-free.

## 4. Data

`trades` after the change (new columns in bold):

| Column | Meaning |
| --- | --- |
| `sell_key`, `telegram_id`, `token`, `eth_in_wei`, `buy_tx_hash`, `status`, `error`, `created_at` | unchanged |
| **`fee_bips`** | 100 (what was requested; kept per row so a later change of the constant does not rewrite history) |
| **`fee_recipient`** | the treasury address the fee went to |
| **`fee_amount`** | raw token units to the treasury; quoted first, actual from the receipt once confirmed |
| **`tokens_out`** | raw token units to the user; same rule |

Revenue to date is then one query: `select token, sum(fee_amount) from trades where status = 'confirmed' group by token`. A Telegram or CLI report on top of that is a later item, not this one.

## 5. Messages (Telegram)

| Where | Now | After |
| --- | --- | --- |
| Dry run | 🧪 Would buy **DOGE** for 0.005 ETH (dry run) | 🧪 Would buy **DOGE** for 0.005 ETH (dry run). 1% of the tokens would go to the Moonbag treasury. |
| Confirmed | ✅ Auto-buy complete! Purchased **DOGE** for 0.005 ETH. View on Blockscout | ✅ Auto-buy complete! You received **990,000 DOGE** for 0.005 ETH. Moonbag fee: 10,000 DOGE (1%). View on Blockscout |
| Help, Important Notes | (nothing about fees) | • A 1% fee is taken in tokens on every buy: you spend your full ETH amount, 99% of the tokens land in your wallet, 1% goes to the Moonbag treasury. No fee on anything else; the bot never sells. |
| Set Buy Amount hint | This is how much ETH I'll spend on each moonbag! | This is how much ETH I'll spend on each moonbag. 1% of the tokens bought is the Moonbag fee. |
| `/health` | `{ ok, chain, chainId, dryRun, watchers, wss, addresses }` | + `feeBips`, `treasury` |

Amounts come from the receipt's `Transfer` logs, so they are what actually moved, not the quote. Optional, for trust: show the treasury address in Help so anyone can verify on Blockscout.

## 6. What I need from you

**Done:** the treasury address is supplied and wired into `bot/.env`; the rate is 100 bips; the copy is written and shipped to the branch.

**Still needed from the owner:**

1. `TREASURY_ADDRESS=0x37752B52C917E07181Fc36D0D5167159a0103d20` added to the **Railway** service variables. Mainnet refuses to boot without it, so a deploy will fail loudly rather than trade fee-free.
2. About 0.01 mainnet ETH in a bot wallet for the one real buy that proves the fee on-chain (`DEPLOYMENT.md` §4 step 8).
3. A decision on whether to keep using the watched MetaMask wallet as the treasury, or switch to a fresh address (see the Status block).
4. Merge `fee-in-token` to `main` when happy: that deploys the site on Vercel and the bot on Railway.

The original ask, for the record:

1. **A treasury wallet address.** Create a fresh wallet in a hardware wallet, Robinhood Wallet, or MetaMask with Robinhood Chain added. It will hold hundreds of small tokens over time, so pick something you can see and sell from. Give me only the public `0x…` address. Its private key never goes in `.env`, the database, the repo, or a chat. A Safe multisig can replace it later by changing one variable.
2. **Put it in two places:** `TREASURY_ADDRESS=0x…` in `bot/.env` (laptop) and in the Railway service variables.
3. **Confirm 100 bips (1%).** The API caps it at 500. It applies to every buy, which is every trade the bot makes.
4. **Copy decisions:**
   - slide 5 line 2, "1% of the moonbag when you profit": delete, or keep as a future promise?
   - the exact wording for slide 5 line 1 and the FAQ answer (proposals in §3);
   - whether to show the treasury address in the bot's Help.
5. **Mainnet ETH for the proof buy:** about 0.01 ETH in the bot wallet on Robinhood Chain. This is the same mainnet swap test that is already pending in `DEPLOYMENT.md` §3; it now proves the fee too.

Nothing is needed from Uniswap. The fee is set per request; there is no account manager step and no key-side fee to remove.

## 7. Verification, in order

Results as of 2026-09-05 are in the Status block; steps 1 to 4 and 6 passed, step 5 is the only one left.

1. `npm test`: the new `fee.test.js` plus the existing rule test.
2. `node scripts/spike-quote.js` on mainnet with the treasury in `.env`: `/quote` 200 with an `INTEGRATOR` output to the treasury at ~1%, `/swap` 200. Nothing sent. This is the go/no-go for the mechanism.
3. Harness (the `ARCHITECTURE.md` §8 pattern) on testnet with `DRY_RUN=true`: the dry-run message carries the fee line; `trades` row has `fee_bips` = 100.
4. Boot check: `CHAIN=mainnet` without `TREASURY_ADDRESS` refuses to start; with it, `/health` shows `feeBips: 100` and the treasury.
5. The real buy on Railway (`DRY_RUN=false`, buy amount 0.001): Blockscout shows two `Transfer` logs of the token, 99% to the bot wallet and 1% to the treasury; the `trades` row has `fee_amount` and `tokens_out` from the receipt; the Telegram message shows both numbers.
6. Site: lint, build, three widths.

Testnet cannot prove the fee: Uniswap does not exist there. Step 2 is the earliest real proof and step 5 the final one.

## 8. Risks and edge cases

- **Tokens that block transfers to some addresses** (blacklists, max-wallet rules): the whole swap reverts, the user sees "Buy failed", nothing is half-done. Same behaviour as any revert today.
- **Fee-on-transfer tokens:** the router computes the portion on what actually comes out; the receipt logs are the truth and that is what we record.
- **Slippage:** the 1% tolerance applies to the user's minimum; the fee output has its own `minAmount`. No change to the constant.
- **Wrong recipient:** `splitOutputs` refuses any quote whose fee entry is not our treasury at our bips, before anything is signed.
- **Rounding:** the API works in raw units, so a 1% share of a tiny amount is a tiny integer, never a fraction; a zero fee entry is fine.
- **Trust:** the fee is visible on-chain in every buy. Disclosing it in Help and the FAQ, and optionally naming the treasury address, is the difference between a fee and a surprise.
- **Operations:** the treasury accumulates positions that only a human sells. Decide who holds that wallet.

## 9. Order of work

Steps 1 to 8 are done on branch `fee-in-token`. Step 9 is what remains.

1. Branch `fee-in-token` from `main`.
2. `config.js`, `.env.example`, `schema.sql`.
3. `uniswap.js` (`integratorFees`, `splitOutputs`) and `test/fee.test.js`.
4. `executor.js` (persist, receipt logs, messages).
5. `index.js` copy and `/health`.
6. `scripts/spike-quote.js`, run it on mainnet (needs `UNISWAP_API_KEY` and `TREASURY_ADDRESS` in `.env`).
7. Site copy, lint, build, three widths.
8. Docs (§3).
9. Push, merge to `main`, add the Railway variable, deploy with `DRY_RUN=true`, then the real buy.

Bot work is a few hours; site and docs under an hour; the real-money proof is gated on the treasury address and the mainnet ETH.
