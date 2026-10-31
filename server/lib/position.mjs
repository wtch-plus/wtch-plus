// One trader's position in one coin, from the chain: every buy, sell and transfer of that coin by that wallet.
// Source: the wallet's token account for the mint (its address is fixed for wallet + mint + token program, so a
// closed and reopened account keeps the old history). Each transaction gives the token change, the token balance
// right after it and the SOL paid or received. A round ends when the balance drops to ~0 (a full exit); the next
// buy starts a new round, and "building since" is the first buy of the current round.
import { createHash } from 'node:crypto';
import { b58decode, b58encode } from './base58.mjs';
import { SOL, STABLE } from './chain.mjs';

export const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGqPvYzF6YqWx7v2iDp8x', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

// ── addresses ──────────────────────────────────────────────
const P = 2n ** 255n - 19n;
const pow = (b, e) => {
  let r = 1n;
  b %= P;
  for (; e > 0n; e >>= 1n, b = (b * b) % P) if (e & 1n) r = (r * b) % P;
  return r;
};
const D = (((-121665n * pow(121666n, P - 2n)) % P) + P) % P;
/** True when 32 bytes decode to an ed25519 point (a PDA must not). */
function onCurve(bytes) {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P;
  const v = (D * y2 + 1n) % P;
  const x2 = (u * pow(v, P - 2n)) % P;
  if (x2 === 0n) return (bytes[31] & 0x80) === 0;
  return pow(x2, (P - 1n) / 2n) === 1n;
}
function pda(seeds, program) {
  const prog = b58decode(program);
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash('sha256');
    for (const s of seeds) h.update(s);
    h.update(Buffer.from([bump]));
    h.update(prog);
    h.update('ProgramDerivedAddress');
    const out = h.digest();
    if (!onCurve(out)) return b58encode(out);
  }
  throw new Error('no PDA');
}
/** The associated token account of `owner` for `mint` under one token program. */
export const ata = (owner, mint, program) => pda([b58decode(owner), b58decode(program), b58decode(mint)], ATA_PROGRAM);

// ── one transaction → one leg ──────────────────────────────
/**
 * A getTransaction (jsonParsed) result → { sig, slot, t, tok, bal, val, accts, prog } for wallet `w` and coin `mint`,
 * or null. tok: tokens in (+) or out (−); bal: the wallet's token balance right after; val: SOL in (+) or out (−),
 * stablecoins counted at `solUsd`; accts: the wallet's token accounts for the mint in this tx; prog: their program.
 * When other coins move the same way in the same tx (a route that leaves dust of another coin, or two buys in one),
 * the SOL is split using their value at `prices` (mint → USD now), see below.
 */
export function toLeg(tx, sig, w, mint, solUsd, prices = new Map()) {
  if (!tx?.meta || tx.meta.err) return null;
  const keys = (tx.transaction?.message?.accountKeys || []).map((k) => (typeof k === 'string' ? k : k.pubkey));
  const i = keys.indexOf(w);
  const native = i >= 0 ? (tx.meta.postBalances[i] - tx.meta.preBalances[i]) / 1e9 : 0;
  const delta = new Map();
  const accts = new Set();
  let bal = 0;
  let prog = null;
  for (const b of tx.meta.preTokenBalances || [])
    if (b.owner === w) {
      delta.set(b.mint, (delta.get(b.mint) || 0) - (b.uiTokenAmount?.uiAmount || 0));
      if (b.mint === mint) accts.add(keys[b.accountIndex]);
    }
  for (const b of tx.meta.postTokenBalances || [])
    if (b.owner === w) {
      delta.set(b.mint, (delta.get(b.mint) || 0) + (b.uiTokenAmount?.uiAmount || 0));
      if (b.mint === mint) {
        bal += b.uiTokenAmount?.uiAmount || 0;
        accts.add(keys[b.accountIndex]);
        prog ??= b.programId ?? null;
      }
    }
  const tok = delta.get(mint) || 0;
  if (!tok) return null;
  let val = native + (delta.get(SOL) || 0);
  // paid or received in USDC/USDT: counted in SOL at `solUsd`; without that price the leg can't be valued (`usd`)
  const usd = [...STABLE].some((s) => delta.get(s));
  for (const s of STABLE) if (delta.get(s) && solUsd) val += delta.get(s) / solUsd;
  const others = [...delta].filter(([m, d]) => m !== mint && m !== SOL && !STABLE.has(m) && d && Math.sign(d) === Math.sign(tok));
  if (others.length && solUsd && val) {
    // the coin really traded is the biggest token amount (memecoins count in millions; route dust of a wrapped coin
    // in fractions): it gets the SOL minus the dust's value now; the dust gets only its own value now
    const usd = Math.abs(val * solUsd);
    const main = others.every(([, d]) => Math.abs(d) <= Math.abs(tok));
    const share = main ? 1 - others.reduce((s, [m, d]) => s + Math.abs(d) * (prices.get(m) || 0), 0) / usd : (Math.abs(tok) * (prices.get(mint) || 0)) / usd;
    val *= Math.min(1, Math.max(0, share));
  }
  return { sig, slot: tx.slot || 0, t: (tx.blockTime || 0) * 1000, tok, bal, val: Math.round(val * 1e6) / 1e6, accts: [...accts].filter(Boolean), prog, usd };
}

// ── legs → position ────────────────────────────────────────
const NOISE = 0.0005; // SOL: below this a token move is a transfer, not a trade
export const kindOf = (l) => (l.tok > 0 ? (l.val < -NOISE ? 'buy' : 'in') : l.val > NOISE ? 'sell' : 'out');
const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 1e4) / 1e4;

/**
 * Chronological order. Bots put dozens of trades in one slot, so inside a slot each next leg is the one whose
 * balance before it (bal − tok) matches the balance after the previous leg.
 */
export function order(legsIn) {
  const bySlot = new Map();
  for (const l of legsIn) bySlot.set(l.slot || l.t, [...(bySlot.get(l.slot || l.t) ?? []), l]);
  const gap = (a, b) => Math.abs(a - b) / Math.max(1, Math.abs(a), Math.abs(b));
  // one slot: try each leg first, chain the rest greedily by balance, keep the chain with the smallest mismatch
  const chain = (group, prev) => {
    let best = null;
    for (let s = 0; s < group.length; s++) {
      const rest = group.filter((_, i) => i !== s);
      const out = [group[s]];
      // with nothing before the slot, a history most likely starts from an empty balance
      let cost = gap(group[s].bal - group[s].tok, prev ?? 0) * (prev == null ? 0.5 : 1);
      while (rest.length) {
        const cur = out[out.length - 1].bal;
        let k = 0;
        for (let i = 1; i < rest.length; i++) if (gap(rest[i].bal - rest[i].tok, cur) < gap(rest[k].bal - rest[k].tok, cur)) k = i;
        cost += gap(rest[k].bal - rest[k].tok, cur);
        out.push(rest.splice(k, 1)[0]);
      }
      if (!best || cost < best.cost) best = { cost, out };
    }
    return best.out;
  };
  const out = [];
  for (const k of [...bySlot.keys()].sort((a, b) => a - b)) {
    const group = bySlot.get(k);
    out.push(...(group.length > 1 ? chain(group.length > 60 ? group.slice(0, 60) : group, out.length ? out[out.length - 1].bal : null).concat(group.slice(60)) : group));
  }
  return out;
}

/**
 * Legs (any order) → rounds and the current position. `priceSol`: the coin's price in SOL for the open bag
 * (the fill price of the trade the alert is about, or the market price now).
 * A round closes when the balance falls to 0.1% of its peak or less (dust left after a full sell counts as out).
 */
export function build(legsIn, priceSol) {
  const legs = order(legsIn);
  const rounds = [];
  let cur = null;
  let partial = false;
  for (const l of legs) {
    const kind = kindOf(l);
    const before = Math.max(0, l.bal - l.tok);
    if (!cur) {
      cur = { start: l.t, firstBuy: null, spent: 0, got: 0, moved: 0, bought: 0, recv: 0, sold: 0, basis: 0, peak: 0, bal: 0, buys: 0, sells: 0, ins: 0, outs: 0 };
      // tokens were already there before the first leg we can see: the start of this round is older
      if (before > 1e-9) {
        partial = true;
        cur.peak = before;
        cur.recv += before;
        cur.partialStart = true;
      }
    }
    if (kind === 'buy') {
      cur.buys++;
      cur.spent += -l.val;
      cur.bought += l.tok;
      cur.basis += -l.val;
      cur.firstBuy ??= l.t;
    } else if (kind === 'in') {
      cur.ins++;
      cur.recv += l.tok;
    } else {
      const share = before > 0 ? Math.min(1, -l.tok / before) : 1;
      const cost = cur.basis * share;
      cur.basis -= cost;
      if (kind === 'sell') {
        cur.sells++;
        cur.got += l.val;
        cur.sold += -l.tok;
      } else {
        // tokens sent to another wallet leave at their cost: no profit or loss on them
        cur.outs++;
        cur.moved += cost;
      }
    }
    cur.peak = Math.max(cur.peak, l.bal);
    cur.bal = l.bal;
    if (l.tok < 0 && l.bal <= cur.peak * 1e-3) {
      rounds.push({ ...cur, end: l.t, pnl: cur.got + cur.moved - cur.spent });
      cur = null;
    }
  }
  // tokens that came in by transfer (a DCA or limit order, another wallet, history older than we read) have no
  // visible cost: when they are more than a quarter of what was bought, PnL for the round is unknown
  const known = (x) => x.recv <= 0.25 * x.bought;
  const base = (x) => ({
    start: x.firstBuy ?? x.start,
    buys: x.buys,
    sells: x.sells,
    transfersIn: x.ins,
    transfersOut: x.outs,
    spentSol: r2(x.spent),
    gotSol: r2(x.got),
    avgBuySol: x.bought ? x.spent / x.bought : null,
  });
  const closed = rounds.map((x) => ({
    ...base(x),
    end: x.end,
    costKnown: known(x),
    pnlSol: known(x) ? r2(x.pnl) : null,
    pnlPct: known(x) && x.spent ? Math.round((x.pnl / x.spent) * 100) : null,
  }));
  let open = null;
  if (cur && cur.bal > 0) {
    const value = priceSol ? cur.bal * priceSol : null;
    const pnl = value == null || !known(cur) ? null : cur.got + cur.moved + value - cur.spent;
    open = {
      ...base(cur),
      tokens: cur.bal,
      valueSol: value == null ? null : r4(value),
      costKnown: known(cur),
      partialStart: Boolean(cur.partialStart),
      realizedSol: known(cur) ? r2(cur.got + cur.moved - (cur.spent - cur.basis)) : null,
      unrealizedSol: value == null || !known(cur) ? null : r2(value - cur.basis),
      pnlSol: pnl == null ? null : r2(pnl),
      pnlPct: pnl == null || !cur.spent ? null : Math.round((pnl / cur.spent) * 100),
    };
  }
  const allKnown = closed.every((x) => x.costKnown);
  const earlier = allKnown ? r2(closed.reduce((s, x) => s + x.pnlSol, 0)) : null;
  return {
    open,
    rounds: closed,
    reentry: open && closed.length ? { rounds: closed.length, lastExit: closed[closed.length - 1].end, earlierPnlSol: earlier } : null,
    allTimePnlSol: !allKnown || (open && open.pnlSol == null) || (!open && !closed.length) ? null : r2((earlier ?? 0) + (open?.pnlSol ?? 0)),
    partial,
    legs: legs.map((l) => ({ t: l.t, kind: kindOf(l), sol: r4(Math.abs(l.val)), tok: l.tok, bal: l.bal, sig: l.sig })),
  };
}
