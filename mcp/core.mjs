// fmt+ MCP core, shared by the remote endpoint (server/routes/mcp.mjs → https://mcp.fmt.plus) and the stdio
// package (mcp/index.mjs, which ships a copy as mcp/core.mjs). Read-only: no keys, no signing.
// `get(path)` reads the fmt+ API (/w/<addr>, /events, /board, /signals, /digest, /pos/<addr>/<mint>) and returns parsed JSON.
export const VERSION = '0.3.0';
const ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const wallet = { type: 'object', properties: { wallet: { type: 'string', description: 'Solana wallet address' } }, required: ['wallet'] };

export const TOOLS = [
  { name: 'whats_important', description: 'The biggest recent swaps of a wallet, ranked by SOL size.', inputSchema: wallet },
  { name: 'pnl', description: 'SOL in, SOL out and net over the wallet’s recent swaps.', inputSchema: wallet },
  { name: 'bags', description: 'Token holdings of a wallet with USD value, biggest first.', inputSchema: wallet },
  { name: 'style', description: 'Trading style: flipper or holder, typical buy size, swaps per hour.', inputSchema: wallet },
  { name: 'trades', description: 'The last swaps of a wallet: side, SOL, token, time, tx.', inputSchema: wallet },
  { name: 'live', description: 'Latest swaps across top Solana wallets fmt+ watches, with an importance score 0-100.', inputSchema: { type: 'object', properties: { min_sol: { type: 'number', description: 'Only swaps of this size and up' } } } },
  { name: 'top_wallets', description: 'Top wallets fmt+ watches: balance, swaps and SOL moved in 24h.', inputSchema: { type: 'object', properties: {} } },
  { name: 'wallet_stats', description: 'Win rate, tokens closed, buys and sells over the wallet’s recent swaps.', inputSchema: wallet },
  { name: 'coins_up', description: 'Coins up 50% or more in 1 hour that tracked wallets traded in the last 24h, with CA, market cap and who traded.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'position',
    description:
      'One wallet in one coin: the full bag (tokens, SOL, USD, share of the wallet), when the current round of buying started (after any full exit), buys and sells, PnL on the coin now and in earlier rounds.',
    inputSchema: { type: 'object', properties: { wallet: { type: 'string', description: 'Solana wallet address' }, mint: { type: 'string', description: 'The coin (CA / mint address)' } }, required: ['wallet', 'mint'] },
  },
  { name: 'digest', description: 'The last hour across tracked wallets: trades, buys, sells, SOL moved, the biggest trade and coins up 50%.', inputSchema: { type: 'object', properties: {} } },
];

const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const tok = (s) => '$' + (s.sym || s.mint.slice(0, 4));
const day = (t) => new Date(t).toISOString().replace(/^\d{4}-(\d\d)-(\d\d)T(\d\d:\d\d).*/, (_, m, d, hm) => `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${+d} ${hm} UTC`);
const signed = (x) => `${x > 0 ? '+' : ''}${x}`;
const big = (x) => (x >= 1e9 ? `${(x / 1e9).toFixed(2)}B` : x >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(1)}k` : `${Math.round(x * 1e4) / 1e4}`);
const usd = (x) => (x == null ? '?' : x >= 1e6 ? `$${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `$${Math.round(x / 1e3)}k` : `$${x}`);

export async function run(name, a, get) {
  a = a || {};
  if (['whats_important', 'pnl', 'bags', 'style', 'trades', 'wallet_stats'].includes(name)) {
    if (!ADDR.test(a.wallet || '')) throw new Error('wallet must be a Solana address');
    const v = await get(`/w/${a.wallet}`);
    const who = v.name || a.wallet.slice(0, 4) + '…' + a.wallet.slice(-4);
    const link = `\nhttps://fmt.plus/w/${a.wallet}`;
    switch (name) {
      case 'whats_important':
        return `${who}: ${v.sol} SOL\n` + v.swaps.slice().sort((x, y) => y.sol - x.sol).slice(0, 5).map((s) => `- ${s.side} ${s.sol} SOL ${tok(s)} · ${ago(s.t)} · ${s.mint}`).join('\n') + link;
      case 'pnl':
        return `${who} over last ${v.swaps.length} swaps: in ${v.flow.in} SOL, out ${v.flow.out} SOL, net ${v.flow.net} SOL. Holds ${v.sol} SOL + $${v.bagsUsd} in tokens.` + link;
      case 'bags':
        return (v.bags.length ? `${who} bags:\n` + v.bags.map((b) => `- $${b.sym} $${b.usd} · ${b.mint}`).join('\n') : `${who} holds ${v.sol} SOL and no priced tokens.`) + link;
      case 'style':
        return `${who} is a ${v.style.kind}: typical buy ${v.style.size} SOL, ${v.style.perHour} swaps/hour.` + link;
      case 'trades':
        return (v.swaps.slice(0, 15).map((s) => `- ${s.side} ${s.sol} SOL ${tok(s)} · ${ago(s.t)} · CA ${s.mint} · tx ${s.sig}`).join('\n') || 'No recent swaps.') + link;
      case 'wallet_stats':
        return (
          `${who} over last ${v.count} swaps: ${v.buys} buys, ${v.sells} sells, ${v.tokens} tokens, ${v.closed} closed (bought and sold), ` +
          (v.winRate == null ? 'win rate n/a (no closed tokens).' : `win rate ${Math.round(v.winRate * 100)}% (${v.wins} of ${v.closed} closed for more SOL than they cost).`) +
          link
        );
    }
  }
  if (name === 'live') {
    const { events } = await get('/events');
    const min = Number(a.min_sol) || 0;
    return events.filter((e) => e.sol >= min).slice(0, 25).map((e) => `- [${e.score}] ${e.name} ${e.side} ${e.sol} SOL ${tok(e)} · ${ago(e.t)} · ${e.w}`).join('\n') || 'No swaps yet.';
  }
  if (name === 'top_wallets') {
    const { board } = await get('/board');
    return board.map((b) => `- ${b.name} ${b.w}: ${b.sol ?? '?'} SOL, ${b.trades} swaps / ${b.volume} SOL moved 24h`).join('\n');
  }
  if (name === 'position') {
    if (!ADDR.test(a.wallet || '') || !ADDR.test(a.mint || '')) throw new Error('wallet and mint must be Solana addresses');
    const p = await get(`/pos/${a.wallet}/${a.mint}`);
    const who = p.name || a.wallet.slice(0, 4) + '…' + a.wallet.slice(-4);
    const coin = '$' + (p.sym || a.mint.slice(0, 4));
    if (!p.found) return `${who} has no trades in ${coin} on record.\nCA ${a.mint}`;
    const out = [`${who} in ${coin}`];
    if (p.bag) {
      const pct = p.bag.shareOfPortfolio == null ? null : p.bag.shareOfPortfolio * 100;
      const share = pct == null ? '' : `, ${pct < 1 ? 'under 1' : Math.round(pct)}% of the wallet`;
      out.push(`Bag: ${big(p.bag.tokens)} ${coin} = ${Math.round(p.bag.valueSol * 100) / 100} SOL (${usd(p.bag.valueUsd)})${share}.`);
      const b = p.building;
      out.push(
        `Building ${p.reentry ? 'again since' : p.partial ? 'since at least' : 'since'} ${day(b.since)}: ${b.buys} buy${b.buys === 1 ? '' : 's'}, ${b.sells} sell${b.sells === 1 ? '' : 's'}, ${b.spentSol} SOL in, ${b.gotSol} SOL out` +
          (b.avgEntryMcapUsd ? `, average entry at ${usd(b.avgEntryMcapUsd)} market cap.` : '.'),
      );
      if (p.pnl && !p.pnl.costKnown) out.push(`PnL on the coin: unknown, ${p.building.transfersIn} transfers in brought tokens with no visible cost (DCA, limit orders or another wallet).`);
      const when = p.priceFrom === 'market' ? 'now' : p.priceFrom === 'last trade' ? 'at the last trade price' : 'at this trade';
      if (p.pnl?.sol != null) out.push(`PnL on the coin ${when}: ${signed(p.pnl.sol)} SOL${p.pnl.pct == null ? '' : ` (${signed(p.pnl.pct)}%)`}, ${signed(p.pnl.realizedSol)} realized, ${signed(p.pnl.unrealizedSol)} unrealized.`);
    } else out.push('No bag now: the last round ended in a full exit.');
    if (p.rounds.length) {
      const last = p.rounds[p.rounds.length - 1];
      const earlier = p.reentry?.earlierPnlSol ?? (p.rounds.every((r) => r.pnlSol != null) ? Math.round(p.rounds.reduce((s, r) => s + r.pnlSol, 0) * 100) / 100 : null);
      out.push(`Earlier rounds: ${p.historyCut ? 'at least ' : ''}${p.reentry?.rounds ?? p.rounds.length} closed, last full exit ${day(last.end)}${earlier == null ? '.' : `, ${signed(earlier)} SOL.`}`);
    }
    if (p.allTimePnlSol != null) out.push(`All-time PnL on ${coin}: ${signed(p.allTimePnlSol)} SOL.`);
    out.push(...p.legs.filter((l) => l.kind === 'buy' || l.kind === 'sell').slice(-10).map((l) => `- ${day(l.t)} ${l.kind} ${l.sol} SOL · tx ${l.sig}`));
    out.push(`CA ${a.mint}`, `https://fmt.plus/w/${a.wallet}`);
    return out.join('\n');
  }
  if (name === 'coins_up') {
    const { signals } = await get('/signals');
    return (
      signals
        .slice(0, 15)
        .map((s) => `- ${tok(s)} +${Math.round(s.change1h)}% in 1h · mcap ${usd(s.mcapUsd)} · liq ${usd(s.liqUsd)} · ${ago(s.t)} · traded by ${s.wallets.map((w) => w.name).join(', ') || '?'} · CA ${s.mint} · https://dexscreener.com/solana/${s.mint}`)
        .join('\n') || 'Right now no coin that tracked wallets traded is up 50% or more in 1 hour.'
    );
  }
  if (name === 'digest') {
    const d = await get('/digest');
    const top = d.topTrade ? `\nBiggest trade: ${d.topTrade.name} ${d.topTrade.side} ${d.topTrade.sol} SOL ${tok(d.topTrade)} · CA ${d.topTrade.mint}` : '';
    const up = d.signals.length ? `\nUp 50%+ in 1h: ${d.signals.map((s) => `${tok(s)} +${Math.round(s.change1h)}% (${s.mint})`).join(', ')}` : '';
    return `Last hour: ${d.trades} trades (${d.buys} buys, ${d.sells} sells), ${d.sol} SOL moved.` + top + up;
  }
  throw new Error(`unknown tool ${name}`);
}

/** One JSON-RPC message → the reply, or null for a notification. */
export async function handle(msg, get) {
  const { id, method, params } = msg || {};
  if (id === undefined || id === null) return null;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  try {
    if (method === 'initialize')
      return ok({
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fmt-plus', title: 'fmt+', version: VERSION },
        instructions: 'Read-only Solana trench intel. Start with digest() or coins_up() for the market, whats_important(wallet) for one wallet, position(wallet, mint) for one wallet in one coin.',
      });
    if (method === 'tools/list') return ok({ tools: TOOLS });
    if (method === 'ping') return ok({});
    if (method === 'tools/call') {
      try {
        return ok({ content: [{ type: 'text', text: await run(params?.name, params?.arguments, get) }] });
      } catch (e) {
        return ok({ content: [{ type: 'text', text: String(e.message || e) }], isError: true });
      }
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } };
  } catch (e) {
    return { jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message || e) } };
  }
}
