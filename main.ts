// main.ts — a one-shot dip buyer for the cbBTC/USDC 24-hour race.
//
// It speaks agent-fun/bars-replay/v1 directly: newline-delimited JSON on
// stdin and stdout, one reply per batch, echoing the batch's seq. The wire
// loop below is deliberately small and self-contained; the strategy is the
// rest of the file.
//
// Strategy (every number is a generic threshold, nothing is fitted to a
// particular window):
//
//   Entry — at most ONE round trip in the whole 24 hours. When the close
//   sits at least 1.2% below the highest high of the last 480 bars (eight
//   hours) AND Wilder RSI(14) is at or under 45, spend the full cash
//   balance on cbBTC. The order is decided on that bar's batch and, per
//   the protocol, fills at the next bar's open.
//
//   Exits — take profit at +1.5% over the actual fill price, stop loss at
//   -1.25% under it, checked against each bar's close; once an exit has
//   triggered, the sell is re-sent every bar until the position is flat.
//   No trailing stop. If neither level is touched, the position is held
//   to the end of the window, where the replay flattens it at the last
//   close.
//
// Why so stingy with trades: a full-size round trip costs roughly 26-37
// bps in fees, slippage and price impact, while a typical 1-minute move
// is only a few bps — a bot that trades often pays the toll far more
// often than the market pays it. One carefully chosen dip is the whole
// plan. The exit geometry follows the same arithmetic: over the hours a
// qualifying dip takes to resolve, ordinary noise swings about 1%, so a
// -0.5% stop would be clipped by noise that means nothing, and a 1%
// trailing stop would hand back most of a real bounce before it fills.
// The stop therefore sits at -1.25%, outside the noise band, and there
// is no trailing stop at all: the fixed +1.5% target, not a trail,
// decides when a bounce has paid enough to cover costs and bank a gain.
//
// Determinism: the bot reads no clock, no environment and no randomness.
// Its decisions are a pure function of the bars and fills it is sent, so
// two executions on the same data emit byte-identical replies.

import { createInterface } from 'node:readline';

// ------------------------------------------------------------------ tuning

const SYMBOL = 'CBBTC';

/** Bars in the reference-high window: 480 one-minute bars = 8 hours. */
const DIP_LOOKBACK_BARS = 480;
/** Enter when the close is at least this fraction under the window high. */
const DIP_DEPTH = 0.012;
/** Wilder RSI period and the highest RSI that still counts as washed out. */
const RSI_PERIOD = 14;
const RSI_ENTRY_MAX = 45;
/** Exit levels, as fractions of the buy's fill price. */
const TAKE_PROFIT = 0.015;
const STOP_LOSS = 0.0125;
/**
 * Slippage guards, measured from the latest close the batch carried. A
 * full-size fill pays ~2 bps of modelled slippage plus ~7 bps of impact,
 * so these sit far above the expected fill cost; they exist to refuse a
 * fill only if the next open gaps violently away from the decision.
 */
const BUY_MAX_SLIPPAGE_BPS = 200;
const SELL_MAX_SLIPPAGE_BPS = 300;

// ------------------------------------------------------------- wire shapes
// Only the fields this bot reads are declared; the harness's messages are
// validated by the harness itself before they reach us.

interface BarLike {
  symbol: string;
  o: string;
  h: string;
  l: string;
  c: string;
}

interface FillLike {
  client_id: string;
  symbol: string;
  side: string;
  status: string;
  price: string;
}

interface PositionLike {
  symbol: string;
  qty: string;
  cost_quote_units: string;
}

interface AccountLike {
  cash_quote_units: string;
  positions: PositionLike[];
  equity_quote_units: string;
}

interface BatchLike {
  seq: number;
  bars: BarLike[];
  fills: FillLike[];
  account: AccountLike;
}

interface Order {
  side: 'buy' | 'sell';
  client_id: string;
  symbol: string;
  notional_quote_units?: string;
  qty?: string;
  max_slippage_bps: number;
}

// ------------------------------------------------------------------ state

/** Closes and highs of every CBBTC bar seen, in arrival order. */
const closes: number[] = [];
const highs: number[] = [];

/** Wilder RSI(14) running state over the closes. */
let prevClose: number | null = null;
let changesSeen = 0;
let seedGain = 0;
let seedLoss = 0;
let avgGain = 0;
let avgLoss = 0;
let rsiReady = false;

/** Trading state: one round trip, ever. */
let buyFilled = false; // a buy has filled: the single entry is spent
let entryPrice = 0; // raw price units of the buy fill, once known
let exitArmed = false; // an exit level fired: keep selling until flat
let orderCount = 0;

/** Batches before seq `warmupBars` reject every order; sit them out. */
let warmupBars = 0;

/** The harness's minimum buy size, from hello.fees; 0 until hello lands. */
let minNotional = 0n;

// -------------------------------------------------------------------- RSI

/** Feed one close into the Wilder RSI; returns the RSI once seeded. */
function feedRsi(close: number): number | null {
  if (prevClose === null) {
    prevClose = close;
    return null;
  }
  const change = close - prevClose;
  prevClose = close;
  const gain = change > 0 ? change : 0;
  const loss = change < 0 ? -change : 0;
  changesSeen += 1;
  if (changesSeen <= RSI_PERIOD) {
    seedGain += gain;
    seedLoss += loss;
    if (changesSeen < RSI_PERIOD) return null;
    avgGain = seedGain / RSI_PERIOD;
    avgLoss = seedLoss / RSI_PERIOD;
    rsiReady = true;
  } else {
    // Wilder smoothing: the running average keeps 13/14 of itself.
    avgGain = (avgGain * (RSI_PERIOD - 1) + gain) / RSI_PERIOD;
    avgLoss = (avgLoss * (RSI_PERIOD - 1) + loss) / RSI_PERIOD;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Highest high over the last `n` bars, the current bar included. */
function highestHigh(n: number): number {
  let top = 0;
  const from = Math.max(0, highs.length - n);
  for (let i = from; i < highs.length; i++) {
    if (highs[i] > top) top = highs[i];
  }
  return top;
}

// --------------------------------------------------------------- decisions

function decide(batch: BatchLike): Order[] {
  // Fills first: they report what the orders decided on the previous
  // batch did at this bar's open, and a filled buy fixes the price the
  // exit levels are measured from.
  for (const fill of batch.fills) {
    if (fill.symbol === SYMBOL && fill.side === 'buy' && fill.status === 'filled') {
      buyFilled = true;
      entryPrice = Number(fill.price);
    }
  }

  const bar = batch.bars.find((b) => b.symbol === SYMBOL);
  if (bar === undefined) return []; // a minute with no CBBTC bar: just reply

  const close = Number(bar.c);
  closes.push(close);
  highs.push(Number(bar.h));
  const rsi = feedRsi(close);

  const position = batch.account.positions.find((p) => p.symbol === SYMBOL);
  const heldQty = position === undefined ? 0n : BigInt(position.qty);
  const warmingUp = batch.seq < warmupBars;

  // Holding: watch the exit levels against this close. Once one fires,
  // the exit stays armed and the sell is re-sent on every batch until
  // the account shows the position gone, so a rejected sell (a gap past
  // the slippage guard, a missing bar) never strands the position.
  if (heldQty > 0n) {
    if (entryPrice > 0) {
      if (close >= entryPrice * (1 + TAKE_PROFIT)) exitArmed = true;
      if (close <= entryPrice * (1 - STOP_LOSS)) exitArmed = true;
    }
    if (exitArmed && !warmingUp) {
      orderCount += 1;
      return [
        {
          side: 'sell',
          client_id: `exit-${orderCount}`,
          symbol: SYMBOL,
          qty: position!.qty,
          max_slippage_bps: SELL_MAX_SLIPPAGE_BPS,
        },
      ];
    }
    return [];
  }

  // Flat: the one entry, only if it has never been taken. A buy that was
  // sent but rejected never set buyFilled, so a later bar that still
  // meets the entry conditions may try again — that is still the same
  // single round trip, not a second one.
  if (buyFilled || warmingUp) return [];
  if (BigInt(batch.account.cash_quote_units) < minNotional) return [];
  if (closes.length < DIP_LOOKBACK_BARS || !rsiReady || rsi === null) return [];
  const top = highestHigh(DIP_LOOKBACK_BARS);
  if (top <= 0) return [];
  if (close > top * (1 - DIP_DEPTH)) return []; // not deep enough below the high
  if (rsi > RSI_ENTRY_MAX) return []; // not washed out enough

  orderCount += 1;
  return [
    {
      side: 'buy',
      client_id: `entry-${orderCount}`,
      symbol: SYMBOL,
      notional_quote_units: batch.account.cash_quote_units, // the full balance
      max_slippage_bps: BUY_MAX_SLIPPAGE_BPS,
    },
  ];
}

// -------------------------------------------------------------------- loop

async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === '') continue;
    const msg = JSON.parse(line) as { type: string };
    if (msg.type === 'hello') {
      const hello = msg as { warmup_bars?: number; fees?: { min_notional_quote_units?: string } };
      warmupBars = hello.warmup_bars ?? 0;
      if (hello.fees?.min_notional_quote_units !== undefined) {
        minNotional = BigInt(hello.fees.min_notional_quote_units);
      }
    } else if (msg.type === 'batch') {
      const batch = msg as unknown as BatchLike;
      const orders = decide(batch);
      process.stdout.write(`${JSON.stringify({ type: 'reply', seq: batch.seq, orders })}\n`);
    } else if (msg.type === 'done') {
      break;
    }
  }
}

await main();
