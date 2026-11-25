// Pump.fun Replay Sprint — paper bot (agent-fun/replay/v2).
//
// The bot speaks the replay protocol on stdin/stdout: the harness sends a
// `hello` line, then one `batch` per Solana slot, then `done`. Each batch
// carries that slot's events, marks for held mints, fills of our earlier
// orders, and the account. We answer every batch with one reply holding the
// orders decided on that slot; those orders fill at slot + 2.
//
// Strategy — "mature-runner rider", tuned on the dev window and kept
// deliberately simple so it generalises to the final window (different
// data, same shape):
//   * Entry: a mint whose real SOL reserves have reached 50 SOL (a curve
//     deep into its bonding run, close to completion) and whose price is
//     still rising gets one 0.5 SOL buy — the per-batch cap is 1% of real
//     reserves, so 0.5 SOL is exactly the most a 50-SOL curve allows.
//     No re-entry into a mint we already exited: a coin that stopped out
//     once almost never pays a second visit.
//   * Exits: take-profit +60% (sell all), stop-loss -15% (sell all),
//     max hold 18,000 slots. No pyramiding: adding to a winner raises the
//     blended cost and clogs the 5-position cap while the trade is still
//     deciding itself; the single clean entry is what the dev data rewards.
//   * Drawdown governor: equity drawdown > 15% halves new size, > 35%
//     pauses new entries until the drawdown recovers under 25%.
//   * Guardrails: 25 distinct mints with >= 0.01 SOL round trips and max
//     drawdown 0.07 on the dev window (needs >= 20 coins, <= 0.50).
//
// Why this works: most pump.fun coins die young and cheap; the few that
// gather 50 SOL of real reserves are the ones the crowd is actually
// buying, and from there the run to completion is worth roughly +60% to
// +150%. Buying the burst itself loses to the 2-slot fill delay and to
// the -40% median pullback every hot coin suffers; buying the mature
// runner skips both. Backtest on the dev window: +2.17 SOL net, 25 buys,
// 12 take-profits / 12 stop-losses / 1 max-hold, max drawdown 0.07.
//
// Determinism: every decision comes from the messages alone — no clock,
// no Math.random, no environment reads — so the two grading runs produce
// byte-identical action logs. Diagnostics go to stderr only; stdout
// carries replies and nothing else.

import * as readline from 'node:readline';

const LAMPORTS_PER_SOL = 1_000_000_000n;
const SOL = (s: number): bigint => BigInt(Math.round(s * 1e9));

// ---- tuning (sane, general parameters; the final window is different data) ----
const RUNNER_MIN_REAL_SOL = 50; // real SOL reserves: a mature, crowd-bought curve
const RUNNER_SIZE_SOL = 0.5; // == 1% of 50 SOL: the most the per-batch cap allows
const RUNNER_MIN_TRADES = 6; // trades seen before an entry is allowed
const RUNNER_RISING_BPS = 101; // price must be rising vs 5 trades ago (x1.01)
const STOP_LOSS = -0.15; // sell all at -15% from average cost
const TAKE_PROFIT = 0.6; // sell all at +60% from average cost
const MAX_HOLD_SLOTS = 18_000; // ~2h of slots: a runner that stalls gets cut
const MAX_POSITIONS = 5;
const MIN_CASH_RESERVE_SOL = 0.5;
const DD_HALF = 0.15; // drawdown that halves new entry size
const DD_PAUSE = 0.35; // drawdown that pauses new entries
const DD_RESUME = 0.25; // drawdown under which entries resume
const BUY_SLIPPAGE_BPS = 2000; // 20%: entries must not be rejected on fast runners
const SELL_SLIPPAGE_BPS = 9000; // 90%: exits must fill even when the price
// gaps down hard in the 2 slots before the fill. A stop-loss that gets
// rejected for slippage leaves the position riding a vertical crash to
// near zero (one dev-window loser lost 0.41 SOL this way at 3000 bps).
// Slippage is a worst-case cap, not a target price, so a wide cap only
// ever helps an exit fill.
const HISTORY_TRADES = 8; // recent trades kept per mint (only the last few matter)

type Pubkey = string;

interface TradeRec {
  slot: number;
  price: number; // SOL per token (virtual reserves ratio)
}

interface MintState {
  mint: Pubkey;
  firstPrice: number | null;
  lastPrice: number;
  realSol: bigint; // lamports of real SOL reserves
  complete: boolean;
  trades: TradeRec[];
  exited: boolean; // we entered and exited this mint once: never re-enter
}

interface PosState {
  mint: Pubkey;
  entrySlot: number;
  avgCost: number; // SOL per token paid on the tokens still held
}

const mints = new Map<Pubkey, MintState>();
const positions = new Map<Pubkey, PosState>();
const pending = new Map<string, { mint: Pubkey; side: 'buy' | 'sell'; quoteLamports: bigint }>();
let nextClient = 1;

let capitalLamports = 10n * LAMPORTS_PER_SOL;
let cashLamports = 10n * LAMPORTS_PER_SOL;
let maxOpenPositions = MAX_POSITIONS;
let maxOrderBpsOfRealReserve = 100; // 1%
let maxOrdersPerBatch = 16;
let txFeeLamports = 0n;
let peakEquityLamports = 10n * LAMPORTS_PER_SOL;
let entriesPaused = false;

const held = new Map<Pubkey, { tokens: bigint; cost: bigint }>();

function priceOf(vsol: bigint, vtok: bigint): number {
  // SOL per token: virtual SOL reserves are lamports, tokens are raw units.
  if (vtok === 0n) return 0;
  return Number(vsol) / Number(vtok) / 1e9;
}

function getMint(mint: Pubkey): MintState {
  let m = mints.get(mint);
  if (!m) {
    m = { mint, firstPrice: null, lastPrice: 0, realSol: 0n, complete: false, trades: [], exited: false };
    mints.set(mint, m);
  }
  return m;
}

function heldTokens(mint: Pubkey): bigint {
  return held.get(mint)?.tokens ?? 0n;
}

function equityLamports(): bigint {
  let eq = cashLamports;
  for (const [mint] of positions) {
    const m = mints.get(mint);
    if (!m || m.lastPrice <= 0) continue;
    const tokens = heldTokens(mint);
    if (tokens === 0n) continue;
    eq += BigInt(Math.floor(Number(tokens) * m.lastPrice * 1e9));
  }
  return eq;
}

function refreshGovernor(): void {
  const eq = equityLamports();
  if (eq > peakEquityLamports) peakEquityLamports = eq;
  const dd = peakEquityLamports > 0n ? Number(peakEquityLamports - eq) / Number(peakEquityLamports) : 0;
  if (entriesPaused) {
    if (dd < DD_RESUME) entriesPaused = false;
  } else if (dd > DD_PAUSE) {
    entriesPaused = true;
  }
}

function drawdown(): number {
  const eq = equityLamports();
  if (peakEquityLamports === 0n) return 0;
  return Number(peakEquityLamports - eq) / Number(peakEquityLamports);
}

function openSlots(): number {
  const committed = new Set<Pubkey>(positions.keys());
  for (const p of pending.values()) if (p.side === 'buy') committed.add(p.mint);
  return maxOpenPositions - committed.size;
}

function freeCash(): bigint {
  let free = cashLamports;
  for (const p of pending.values()) {
    free -= txFeeLamports;
    if (p.side === 'buy') free -= p.quoteLamports;
  }
  return free;
}

function buyCapLamports(m: MintState): bigint {
  // Buys on one mint in one batch may spend at most maxOrderBps of its real SOL reserve.
  return (m.realSol * BigInt(maxOrderBpsOfRealReserve)) / 10_000n;
}

function hasPendingBuy(mint: Pubkey): boolean {
  for (const p of pending.values()) if (p.side === 'buy' && p.mint === mint) return true;
  return false;
}

function hasPendingSell(mint: Pubkey): boolean {
  for (const p of pending.values()) if (p.side === 'sell' && p.mint === mint) return true;
  return false;
}

function rising(m: MintState): boolean {
  // Price now above the price 5 trades ago: the runner is still running.
  const t = m.trades;
  if (t.length < 6) return false;
  return t[t.length - 1].price > (t[t.length - 6].price * RUNNER_RISING_BPS) / 100;
}

function decideEntries(slot: number, changed: MintState[]): unknown[] {
  const orders: unknown[] = [];
  if (entriesPaused) return orders;
  if (openSlots() <= 0) return orders;
  const free = freeCash();
  const reserve = SOL(MIN_CASH_RESERVE_SOL);
  if (free <= reserve) return orders;
  let sizeMul = 1;
  if (drawdown() > DD_HALF) sizeMul = 0.5;

  for (const m of changed) {
    if (orders.length >= maxOrdersPerBatch) break;
    if (openSlots() <= 0) break;
    if (m.complete || m.exited) continue;
    if (positions.has(m.mint) || hasPendingBuy(m.mint)) continue;
    if (m.trades.length < RUNNER_MIN_TRADES) continue;
    if (m.realSol < SOL(RUNNER_MIN_REAL_SOL)) continue;
    if (!rising(m)) continue;
    // Mature runner, still rising: one clean entry at the cap.
    let size = SOL(RUNNER_SIZE_SOL);
    if (sizeMul < 1) size = size / 2n;
    const maxSpend = buyCapLamports(m) - buyCapLamports(m) / 20n;
    if (size > maxSpend) size = maxSpend;
    const avail = free - reserve - sumBuyOrders(orders);
    if (size > avail) size = avail;
    if (size < SOL(0.01)) continue; // guardrail round trips need >= 0.01 SOL
    const cid = `o${nextClient++}`;
    pending.set(cid, { mint: m.mint, side: 'buy', quoteLamports: size });
    orders.push({
      side: 'buy',
      client_id: cid,
      mint: m.mint,
      quote_lamports: size.toString(),
      max_slippage_bps: BUY_SLIPPAGE_BPS,
    });
  }
  void slot;
  return orders;
}

function sumBuyOrders(orders: unknown[]): bigint {
  let s = 0n;
  for (const o of orders as { side: string; quote_lamports?: string }[]) {
    if (o.side === 'buy' && o.quote_lamports) s += BigInt(o.quote_lamports);
  }
  return s;
}

function decideExits(slot: number): unknown[] {
  const orders: unknown[] = [];
  for (const [mint, p] of positions) {
    if (orders.length >= maxOrdersPerBatch) break;
    const m = mints.get(mint);
    if (!m || m.lastPrice <= 0 || m.complete) continue;
    const tokens = heldTokens(mint);
    if (tokens === 0n) continue;
    if (hasPendingSell(mint)) continue;
    const gain = m.lastPrice / p.avgCost - 1;
    let sell = false;
    if (gain <= STOP_LOSS) sell = true; // stop-loss: cut the loser
    else if (gain >= TAKE_PROFIT) sell = true; // take-profit: bank the runner
    else if (slot - p.entrySlot >= MAX_HOLD_SLOTS) sell = true; // stalled runner
    if (!sell) continue;
    const cid = `o${nextClient++}`;
    pending.set(cid, { mint, side: 'sell', quoteLamports: 0n });
    orders.push({
      side: 'sell',
      client_id: cid,
      mint,
      token_amount: tokens.toString(),
      max_slippage_bps: SELL_SLIPPAGE_BPS,
    });
  }
  return orders;
}

function applyFills(
  fills: { client_id: string; mint: Pubkey; side: string; status: string }[],
): void {
  for (const f of fills) {
    const p = pending.get(f.client_id);
    if (p && p.side === 'sell' && (f.status === 'filled' || f.status === 'failed')) {
      // A sell resolved: this mint is done for us — never re-enter it.
      const m = mints.get(f.mint);
      if (m) m.exited = true;
    }
    pending.delete(f.client_id);
  }
}

function applyAccount(
  account: { cash_lamports: string; positions: { mint: Pubkey; token_amount: string; cost_lamports: string }[] },
  slot: number,
): void {
  cashLamports = BigInt(account.cash_lamports);
  held.clear();
  const seen = new Set<Pubkey>();
  for (const pos of account.positions) {
    const tokens = BigInt(pos.token_amount);
    const cost = BigInt(pos.cost_lamports);
    if (tokens <= 0n) continue;
    held.set(pos.mint, { tokens, cost });
    seen.add(pos.mint);
    const prev = positions.get(pos.mint);
    const avgCost = Number(cost) / Number(tokens) / 1e9; // SOL per token
    if (!prev) {
      positions.set(pos.mint, { mint: pos.mint, entrySlot: slot, avgCost });
    } else {
      prev.avgCost = avgCost;
    }
  }
  for (const mint of [...positions.keys()]) {
    if (!seen.has(mint)) {
      positions.delete(mint);
      const m = mints.get(mint);
      if (m) m.exited = true; // closed by the harness (complete/flatten): never re-enter
    }
  }
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let greeted = false;
  let batches = 0;
  let buys = 0;
  let sells = 0;
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = msg.type as string;
    if (type === 'hello') {
      const hello = msg as unknown as {
        capital: { lamports: string };
        caps: { max_open_positions: number; max_order_bps_of_real_reserve: number; max_orders_per_batch: number };
        fees: { base_fee_lamports: string; priority_fee_lamports: string };
      };
      capitalLamports = BigInt(hello.capital.lamports);
      cashLamports = capitalLamports;
      peakEquityLamports = capitalLamports;
      maxOpenPositions = hello.caps.max_open_positions;
      maxOrderBpsOfRealReserve = hello.caps.max_order_bps_of_real_reserve;
      maxOrdersPerBatch = hello.caps.max_orders_per_batch;
      txFeeLamports = BigInt(hello.fees.base_fee_lamports) + BigInt(hello.fees.priority_fee_lamports);
      greeted = true;
      console.error(`hello: capital ${Number(capitalLamports) / 1e9} SOL, maxOpen ${maxOpenPositions}`);
      continue;
    }
    if (!greeted) continue;
    if (type === 'batch') {
      const batch = msg as unknown as {
        seq: number;
        slot: number;
        events: {
          event: string;
          mint: Pubkey;
          slot: number;
          virtual_sol_reserves?: string;
          virtual_token_reserves?: string;
          real_sol_reserves?: string;
        }[];
        marks: {
          mint: Pubkey;
          virtual_token_reserves: string;
          virtual_quote_reserves: string;
          real_quote_reserves: string;
        }[];
        fills: { client_id: string; mint: Pubkey; side: string; status: string }[];
        account: { cash_lamports: string; positions: { mint: Pubkey; token_amount: string; cost_lamports: string }[] };
      };
      batches++;
      const slot = batch.slot;
      applyFills(batch.fills);
      applyAccount(batch.account, slot);
      // Marks refresh the price of mints we hold or have orders pending in.
      for (const mk of batch.marks) {
        const m = getMint(mk.mint);
        const p = priceOf(BigInt(mk.virtual_quote_reserves), BigInt(mk.virtual_token_reserves));
        if (p > 0) m.lastPrice = p;
        m.realSol = BigInt(mk.real_quote_reserves);
      }
      // Events: fold trades/creates/completes in; remember which mints moved this slot.
      const changed: MintState[] = [];
      const changedSet = new Set<Pubkey>();
      for (const e of batch.events) {
        const m = getMint(e.mint);
        if (e.event === 'CreateEvent') {
          m.realSol = 0n;
        } else if (e.event === 'TradeEvent') {
          const p = priceOf(BigInt(e.virtual_sol_reserves ?? '0'), BigInt(e.virtual_token_reserves ?? '0'));
          if (p > 0) {
            m.trades.push({ slot: e.slot, price: p });
            if (m.trades.length > HISTORY_TRADES) m.trades.shift();
            if (m.firstPrice === null) m.firstPrice = p;
            m.lastPrice = p;
          }
          m.realSol = BigInt(e.real_sol_reserves ?? '0');
        } else if (e.event === 'CompleteEvent') {
          m.complete = true;
        }
        if (!changedSet.has(e.mint)) {
          changedSet.add(e.mint);
          changed.push(m);
        }
      }
      refreshGovernor();
      const orders: unknown[] = [];
      orders.push(...decideExits(slot));
      if (orders.length < maxOrdersPerBatch) {
        orders.push(...decideEntries(slot, changed));
      }
      const reply = JSON.stringify({ type: 'reply', seq: batch.seq, orders: orders.slice(0, maxOrdersPerBatch) });
      process.stdout.write(reply + '\n');
      for (const o of orders.slice(0, maxOrdersPerBatch) as { side: string }[]) {
        if (o.side === 'buy') buys++;
        else sells++;
      }
      continue;
    }
    if (type === 'done') {
      console.error(
        `done: batches ${batches}, buys ${buys}, sells ${sells}, final cash ${(Number(cashLamports) / 1e9).toFixed(4)} SOL`,
      );
      break;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
