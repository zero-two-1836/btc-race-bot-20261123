[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/zero-two-1836/btc-race-bot-20261123/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/zero-two-1836/btc-race-bot-20261123/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

# One-Shot Dip Buyer — cbBTC/USDC 24h race bot

A trading bot for the make.fun BTC race: it trades Coinbase Wrapped BTC
(cbBTC) against USDC on 1-minute bars under the `agent-fun/bars-replay/v1`
protocol, starting from 1,000 USDC of paper money, long only.

The bot is a single self-contained file, `main.ts`, with no dependencies
beyond the Node 22 standard library. It reads newline-delimited JSON
(`hello`, then one `batch` per minute, then `done`) on stdin and answers
each batch with exactly one `reply` line on stdout, echoing the batch's
`seq`. It uses no network, no wall clock and no randomness, so two runs
over the same bars produce byte-identical orders.

## Strategy

The bot makes **at most one round trip in the whole 24 hours**.

- **Entry.** When the close is at least **1.2% below the highest high of
  the last 480 bars** (eight hours) and **Wilder RSI(14) ≤ 45**, it buys
  with the full cash balance. Per the protocol the order fills at the
  next bar's open, paying the 4 bps fee, 2 bps modelled slippage and
  constant-product price impact.
- **Take profit** at **+1.5%** over the actual fill price.
- **Stop loss** at **−1.25%** under the fill price. Once an exit level
  fires, the sell is re-sent every bar until the position is flat.
- **No trailing stop.** If neither level is touched, the position is
  held to the end of the window, where the replay flattens it at the
  last close.

## Why one trade, and why these levels

A full-size round trip costs roughly 26–37 bps in fees, slippage and
impact, while a typical 1-minute move is only a few bps — frequent
trading pays the toll far more often than the market pays the trader.
The one trade worth paying for is a deep, washed-out dip.

The exit geometry follows the same logic. Over the hours a qualifying
dip takes to resolve, ordinary noise swings about 1%, so a −0.5% stop
would be clipped by meaningless noise and a 1% trailing stop would hand
back most of a genuine bounce before it fills. The stop sits at −1.25%,
outside the noise band, there is no trail, and the fixed +1.5% target
decides when a bounce has paid enough to cover costs and bank a gain.

## Running it

The grader runs the bot as:

```
node /bot/main.ts
```

speaking the bars-replay protocol on stdio. To score it on the
competition's published dev window, use the kit's local grader:

```
node cli/makefun.mjs grade-local --kit <kit> --bot <this repo> --driver process
```
