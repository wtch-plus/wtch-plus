// A trader's position in one coin: the full bag, when the current round of buying started (after any full exit),
// every buy and sell on a price chart, and PnL on the coin including the latest trade.
//   GET /api/pos/:wallet/:mint          the position now (market price from DexScreener)
//   GET /api/pos/:wallet/:mint?sig=...  as of that trade, priced at its own fill (what a buy alert shows)
// History comes from the wallet's token accounts for the mint (server/lib/position.mjs), kept in sqlite: the first
// read takes up to MAX_SIGS transactions per account, later reads only the new ones. Every tracked trade warms the cache.
import { httpError } from '../lib/http.mjs';
import { createChain } from '../lib/chain.mjs';
import { SOL_MINT, dexToken, getJson, jupPrices, solUsd, swr, tokenMarket } from '../lib/market.mjs';
import { TOKEN_PROGRAMS, ata, build, kindOf, order, toLeg } from '../lib/position.mjs';
import { bus } from '../lib/bus.mjs';
import { heliusKey } from './wallets.mjs';

const ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_SIGS = 300;
const FRESH_MS = 15_000;
const TX = { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GeckoTerminal candle sizes, smallest first: the chart takes the first one that fits the span in ≤ 180 candles
const FRAMES = [
  ['minute', 1, 60e3, '1m'],
  ['minute', 5, 300e3, '5m'],
  ['minute', 15, 900e3, '15m'],
  ['hour', 1, 3600e3, '1h'],
  ['hour', 4, 14400e3, '4h'],
  ['hour', 12, 43200e3, '12h'],
  ['day', 1, 86400e3, '1d'],
];

export default async function positions(ctx) {
  const { db, log } = ctx;
  const chain = createChain({ key: heliusKey(ctx.cfg), log });
  db.migrate('positions', [
    `CREATE TABLE pos_legs (w TEXT NOT NULL, mint TEXT NOT NULL, sig TEXT NOT NULL, slot INTEGER NOT NULL, t INTEGER NOT NULL,
       tok REAL NOT NULL, bal REAL NOT NULL, val REAL NOT NULL, PRIMARY KEY (w, mint, sig))`,
    `CREATE TABLE pos_sync (w TEXT NOT NULL, mint TEXT NOT NULL, prog TEXT, newest TEXT, complete INTEGER NOT NULL DEFAULT 1,
       t INTEGER NOT NULL, PRIMARY KEY (w, mint))`,
    // every token account of the wallet for the mint that ever held it (ATAs, bot-made accounts, closed ones)
    `CREATE TABLE pos_accts (w TEXT NOT NULL, mint TEXT NOT NULL, acct TEXT NOT NULL, newest TEXT, complete INTEGER NOT NULL DEFAULT 1,
       PRIMARY KEY (w, mint, acct))`,
    // the first release stored USDC-paid buys as free transfers when SOL/USD was missing: read everything again
    'DELETE FROM pos_legs',
    'DELETE FROM pos_accts',
    'DELETE FROM pos_sync',
  ]);

  // one sync at a time (Helius counts every call against its per-second limit); same pair → same promise
  let chainQ = Promise.resolve();
  const inflight = new Map();
  function sync(w, mint, force = false) {
    const k = `${w}:${mint}`;
    if (inflight.has(k)) return inflight.get(k);
    const p = (chainQ = chainQ.then(() => syncNow(w, mint, force)).catch((e) => log('pos.sync.fail', { w: w.slice(0, 6), e: String(e.message || e).slice(0, 80) })));
    inflight.set(k, p);
    return p.finally(() => inflight.delete(k));
  }
  // SOL/USD: Jupiter (shared cache), else DexScreener's SOL pairs (Jupiter answers 429 right after a restart)
  const solDex = swr(async () => (await dexToken(SOL_MINT, { timeoutMs: 6000 })).priceUsd ?? null, { ttlMs: 60_000, name: 'pos.sol' });
  const solPrice = async () => (await solUsd().catch(() => null)) ?? (await solDex.get().catch(() => null)) ?? null;

  /** Parse transactions and keep their legs; returns the token accounts and program they show, and how many failed. */
  async function parse(w, mint, sigs) {
    const found = { accts: new Set(), prog: null, failed: 0 };
    if (!sigs.length) return found;
    const txs = await chain.rpcBatch('getTransaction', sigs.map((s) => [s, TX]), 60);
    found.failed = txs.filter((tx) => !tx).length;
    const su = await solPrice();
    // prices of every coin the wallet moved in these txs, to split SOL when a tx moved more than one
    const mints = new Set([mint]);
    for (const tx of txs) for (const b of tx?.meta?.postTokenBalances || []) if (b.owner === w) mints.add(b.mint);
    const prices = mints.size > 1 ? await jupPrices([mint, ...[...mints].filter((m) => m !== mint)].slice(0, 50)).catch(() => new Map()) : new Map();
    for (let i = 0; i < sigs.length; i++) {
      const l = toLeg(txs[i], sigs[i], w, mint, su, prices);
      if (!l) continue;
      if (l.usd && !su) {
        found.failed++;
        continue;
      }
      for (const a of l.accts) found.accts.add(a);
      found.prog ??= l.prog;
      db.run('INSERT OR IGNORE INTO pos_legs (w, mint, sig, slot, t, tok, bal, val) VALUES (?,?,?,?,?,?,?,?)', w, mint, l.sig, l.slot, l.t, l.tok, l.bal, l.val);
    }
    return found;
  }
  /**
   * New signatures of one account since the last sync. The first sync pages back until MAX_SIGS successful ones or
   * 6 pages: sniping bots leave hundreds of failed transactions on an account, which don't count.
   */
  async function sigsOf(acct, newest) {
    const out = [];
    let before;
    for (let pages = 1; ; pages++) {
      const page = await chain.rpc('getSignaturesForAddress', [acct, { limit: 1000, ...(newest ? { until: newest } : {}), ...(before ? { before } : {}) }]);
      out.push(...page);
      const ok = out.filter((s) => !s.err).length;
      if (page.length < 1000 || newest || ok >= MAX_SIGS || pages >= 6) return { sigs: out, complete: !(page.length === 1000 && !newest) };
      before = page[page.length - 1].signature;
    }
  }
  async function syncNow(w, mint, force) {
    const row = db.get('SELECT * FROM pos_sync WHERE w = ? AND mint = ?', w, mint);
    if (row && !force && Date.now() - row.t < FRESH_MS) return;
    const accts = new Map(db.all('SELECT acct, newest, complete FROM pos_accts WHERE w = ? AND mint = ?', w, mint).map((r) => [r.acct, r]));
    const first = !accts.size;
    const add = (a) => a && !accts.has(a) && accts.set(a, { acct: a, newest: null, complete: 1 });
    let prog = row?.prog ?? null;
    // where the coin can sit: the ATA of its program (both until it is known), any open account for it, and on the
    // first sync the accounts in trades wtch+ already recorded (bots open a fresh account per round and close it)
    for (const p of prog ? [prog] : TOKEN_PROGRAMS) add(ata(w, mint, p));
    const open = await chain.rpc('getTokenAccountsByOwner', [w, { mint }, { encoding: 'jsonParsed' }]).catch(() => null);
    for (const a of open?.value || []) add(a.pubkey);
    if (first) {
      const known = db.all('SELECT sig FROM trades WHERE w = ? AND mint = ? ORDER BY t DESC LIMIT 20', w, mint).map((r) => r.sig);
      const f = await parse(w, mint, known);
      f.accts.forEach(add);
      prog ??= f.prog;
    }
    let newestAll = row?.newest ?? null;
    for (const a of accts.values()) {
      const { sigs, complete } = await sigsOf(a.acct, a.newest);
      if (!sigs.length) continue;
      const have = new Set(db.all('SELECT sig FROM pos_legs WHERE w = ? AND mint = ?', w, mint).map((r) => r.sig));
      const todo = sigs.filter((s) => !s.err && !have.has(s.signature)).map((s) => s.signature);
      const f = await parse(w, mint, todo.slice(0, MAX_SIGS));
      prog ??= f.prog;
      // a transaction the RPC did not return (rate limit) is read again next time: the account keeps its old mark
      if (f.failed) {
        log('pos.sync.partial', { w: w.slice(0, 6), failed: f.failed });
        continue;
      }
      a.newest = sigs[0].signature;
      a.complete = complete && todo.length <= MAX_SIGS ? a.complete : 0;
      newestAll = a.newest;
    }
    for (const a of accts.values())
      db.run(
        'INSERT INTO pos_accts (w, mint, acct, newest, complete) VALUES (?,?,?,?,?) ON CONFLICT (w, mint, acct) DO UPDATE SET newest = excluded.newest, complete = excluded.complete',
        w,
        mint,
        a.acct,
        a.newest,
        a.complete,
      );
    const complete = [...accts.values()].every((a) => a.complete) ? 1 : 0;
    db.run(
      'INSERT INTO pos_sync (w, mint, prog, newest, complete, t) VALUES (?,?,?,?,?,?) ON CONFLICT (w, mint) DO UPDATE SET prog = excluded.prog, newest = excluded.newest, complete = excluded.complete, t = excluded.t',
      w,
      mint,
      prog,
      newestAll,
      complete,
      Date.now(),
    );
  }

  // market: price + market cap from DexScreener → GeckoTerminal → Jupiter (30 s; a coin still on the pump.fun curve
  // has no DexScreener pair yet), GeckoTerminal pool (1 h) and candles (2 min, ≤ 12 calls a minute)
  const dex = swr((mint) => tokenMarket(mint, { timeoutMs: 6000 }), { ttlMs: 30_000, name: 'pos.market' });
  const pools = swr(async (mint) => (await getJson(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools?page=1`, { timeoutMs: 6000 }))?.data?.[0]?.attributes?.address ?? null, {
    ttlMs: 3600_000,
    name: 'pos.pool',
  });
  let gtCalls = [];
  const candles = swr(
    async (key) => {
      const [mint, fi, n] = key.split('|');
      gtCalls = gtCalls.filter((t) => Date.now() - t < 60_000);
      if (gtCalls.length >= 12) return null;
      gtCalls.push(Date.now(), Date.now());
      const pool = await pools.get(mint);
      if (!pool) return null;
      const [tf, agg] = FRAMES[fi];
      const j = await getJson(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/${tf}?aggregate=${agg}&limit=${n}&currency=usd&token=${mint}`, { timeoutMs: 8000 });
      return (j?.data?.attributes?.ohlcv_list || []).map((c) => [c[0] * 1000, c[4]]).reverse();
    },
    { ttlMs: 120_000, name: 'pos.candles' },
  );
  async function chart(mint, from) {
    const span = Math.max(Date.now() - from, 30 * 60e3);
    const fi = FRAMES.findIndex((f) => span / f[2] <= 180);
    const i = fi < 0 ? FRAMES.length - 1 : fi;
    const n = Math.min(1000, Math.ceil(span / FRAMES[i][2]) + 6);
    const pts = await candles.get(`${mint}|${i}|${n}`).catch(() => null);
    return pts?.length > 2 ? { tf: FRAMES[i][3], pts } : null;
  }

  const walletOf = (w) => new Promise((res) => bus.emit('wallet?', w, res));
  // the wallet's total: SOL + each holding capped at its pools' liquidity (a fake "BTC" priced at $6M with no pool
  // counts as nothing), DexScreener in one call per wallet, 60 s
  const liquidity = swr(
    async (mints) => {
      const out = new Map();
      const pairs = await getJson(`https://api.dexscreener.com/tokens/v1/solana/${mints}`, { timeoutMs: 6000 });
      for (const p of Array.isArray(pairs) ? pairs : []) {
        const m = p?.baseToken?.address;
        if (m) out.set(m, (out.get(m) || 0) + (Number(p.liquidity?.usd) || 0));
      }
      return out;
    },
    { ttlMs: 60_000, name: 'pos.liq' },
  );
  async function portfolio(wv, su) {
    if (!wv || !su) return null;
    const bags = (wv.bags || []).slice(0, 30);
    const liq = bags.length ? await liquidity.get(bags.map((b) => b.mint).join(',')).catch(() => null) : new Map();
    const tokensUsd = Math.round(bags.reduce((s, b) => s + Math.min(b.usd, liq?.get(b.mint) ?? b.usd), 0));
    return { sol: wv.sol, tokensUsd, totalUsd: Math.round(wv.sol * su + tokensUsd) };
  }
  const price = (l) => Math.abs(l.val / l.tok);
  const resyncAt = new Map();
  /** True when some leg's balance before it differs from the balance after the leg before it (or, with the whole
   * history read, the first leg does not start from an empty balance). */
  const gap = (legs, complete) =>
    legs.some((l, i) => {
      if (!i && !complete) return false;
      const before = l.bal - l.tok;
      const prev = i ? legs[i - 1].bal : 0;
      return Math.abs(before - prev) > 1e-6 * Math.max(1, Math.abs(prev), Math.abs(before));
    });

  /** The position as JSON (see the header). `sig`: as of that trade, at its fill price. */
  async function position(w, mint, { sig } = {}) {
    await sync(w, mint, Boolean(sig));
    const legsOf = () => db.all('SELECT sig, slot, t, tok, bal, val FROM pos_legs WHERE w = ? AND mint = ?', w, mint);
    let legs = legsOf();
    // the RPC can lag a few seconds behind the trade the alert is about
    for (let i = 0; sig && i < 3 && !legs.some((l) => l.sig === sig); i++) {
      await sleep(2500);
      await sync(w, mint, true);
      legs = legsOf();
    }
    let ordered = order(legs);
    // a break in the balance chain means a transaction was missed: read the whole history again (≤ once per 10 min)
    const k = `${w}:${mint}`;
    const done = db.get('SELECT complete FROM pos_sync WHERE w = ? AND mint = ?', w, mint)?.complete === 1;
    if (gap(ordered, done) && Date.now() - (resyncAt.get(k) ?? 0) > 600_000) {
      resyncAt.set(k, Date.now());
      log('pos.resync', { w: w.slice(0, 6), mint: mint.slice(0, 6) });
      db.run('UPDATE pos_accts SET newest = NULL WHERE w = ? AND mint = ?', w, mint);
      await sync(w, mint, true);
      legs = legsOf();
      ordered = order(legs);
    }
    const sync0 = db.get('SELECT complete FROM pos_sync WHERE w = ? AND mint = ?', w, mint);
    const [m, su, wv] = await Promise.all([dex.get(mint).catch(() => null), solPrice(), walletOf(w)]);
    let cut = ordered;
    let priceSol = null;
    // where the price for the open bag comes from: this trade's fill, the market now, or the last trade's fill
    let priceFrom = null;
    const at = sig ? ordered.findIndex((l) => l.sig === sig) : -1;
    if (at >= 0) {
      cut = ordered.slice(0, at + 1);
      priceSol = price(ordered[at]);
      priceFrom = 'this trade';
    }
    if (!priceSol && m?.priceUsd && su) {
      priceSol = m.priceUsd / su;
      priceFrom = 'market';
    }
    if (!priceSol) {
      const last = [...ordered].reverse().find((l) => kindOf(l) === 'buy' || kindOf(l) === 'sell');
      if (last) {
        priceSol = price(last);
        priceFrom = 'last trade';
      }
    }
    const p = build(cut, priceSol);
    // pump.fun coins always have 1B supply, so their market cap is known even before a DexScreener listing
    const supply = m?.mcapUsd && m?.priceUsd ? m.mcapUsd / m.priceUsd : mint.endsWith('pump') ? 1e9 : null;
    const usd = (sol) => (sol == null || !su ? null : Math.round(sol * su));
    const mcapAt = (pSol) => (pSol && su && supply ? Math.round(pSol * su * supply) : null);
    const o = p.open;
    const pf = await portfolio(wv, su);
    const portfolioUsd = pf?.totalUsd ?? null;
    const bagUsd = o ? usd(o.valueSol) : null;
    const first = cut.find((l) => kindOf(l) === 'buy') ?? cut[0];
    const ch = first ? await chart(mint, first.t - 0.08 * (Date.now() - first.t)).catch(() => null) : null;
    return {
      w,
      name: wv?.name ?? null,
      mint,
      sym: m?.symbol || null,
      sig: at >= 0 ? sig : null,
      at: Date.now(),
      found: legs.length > 0,
      priceSol,
      priceFrom,
      priceUsd: priceSol && su ? priceSol * su : null,
      mcapUsd: mcapAt(priceSol),
      bag: o ? { tokens: o.tokens, valueSol: o.valueSol, valueUsd: bagUsd, shareOfPortfolio: portfolioUsd && bagUsd ? Math.min(1, bagUsd / Math.max(portfolioUsd, bagUsd)) : null } : null,
      portfolio: pf,
      building: o
        ? { since: o.start, buys: o.buys, sells: o.sells, spentSol: o.spentSol, gotSol: o.gotSol, avgEntryMcapUsd: mcapAt(o.avgBuySol), transfersIn: o.transfersIn, transfersOut: o.transfersOut }
        : null,
      // costKnown false: a large part of the bag came in by transfer, so its cost (and PnL) is not on chain
      pnl: o ? { sol: o.pnlSol, pct: o.pnlPct, usd: usd(o.pnlSol), realizedSol: o.realizedSol, unrealizedSol: o.unrealizedSol, costKnown: o.costKnown } : null,
      reentry: p.reentry,
      rounds: p.rounds.slice(-10),
      allTimePnlSol: p.allTimePnlSol,
      // the current round began with tokens already there (older history not read): "since" means "since at least"
      partial: Boolean(o?.partialStart),
      // older rounds may be missing (an account with more history than wtch+ reads)
      historyCut: p.partial || sync0?.complete === 0,
      chart: ch ? { ...ch, marks: p.legs.filter((l) => l.kind === 'buy' || l.kind === 'sell').map((l) => ({ t: l.t, side: l.kind, sol: l.sol })) } : null,
      legs: p.legs.slice(-60),
    };
  }

  // every tracked trade warms the cache, so the alert for it reads only the new transactions
  bus.on('trade', (ev) => void sync(ev.w, ev.mint));
  bus.on('position?', (w, mint, opts, cb) => position(w, mint, opts).then(cb, () => cb(null)));

  const limit = ctx.rate(20);
  ctx.route('GET', '/api/pos/:addr/:mint', async (req, _res, { params, ip }) => {
    if (!/^(::1|127\.|::ffff:127\.)/.test(ip)) limit(ip);
    if (!ADDR.test(params.addr) || !ADDR.test(params.mint)) throw httpError(400, 'address');
    const sig = new URL(req.url, 'http://x').searchParams.get('sig');
    if (sig && !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) throw httpError(400, 'sig');
    return position(params.addr, params.mint, { sig });
  });
  ctx.health('positions', () => ({ ok: true, pairs: db.get('SELECT COUNT(*) AS n FROM pos_sync')?.n ?? 0 }));
}
