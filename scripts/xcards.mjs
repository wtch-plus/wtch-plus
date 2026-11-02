// X cards for the position update: 1600×900 PNGs from real position snapshots (brand/x-cards/data, saved from
// GET /api/pos and the MCP `position` tool). Rules: no headlines, no small text (≥ 40 px), only facts.
//   node scripts/xcards.mjs  → brand/x-cards/<n>-<name>.png (+ .html next to it)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'brand/x-cards');
const data = (f) => JSON.parse(readFileSync(join(OUT, 'data', f), 'utf8'));
const C = { paper: '#F2F1E8', ink: '#202422', mute: '#6A7167', rule: 'rgba(32,36,34,0.18)', buy: '#0a7a33', sell: '#b0105f', lime: '#D7F542', blue: '#202422' };
const W = 1600;
const H = 900;

// ── formats ────────────────────────────────────────────────
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (t) => {
  const d = new Date(t);
  return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
};
const sol = (x, d = 2) => `${Math.round(x * 10 ** d) / 10 ** d} SOL`;
const signed = (x, unit = ' SOL') => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x)}${unit}`;
const big = (x) => (x >= 1e9 ? `${(x / 1e9).toFixed(2)}B` : x >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(1)}k` : String(x));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

// ── page ───────────────────────────────────────────────────
const fonts = readdirSync(join(ROOT, 'server/assets/fonts'))
  .filter((f) => f.endsWith('.woff2'))
  .map((f) => {
    const fam = f.startsWith('InterTight') ? 'Inter Tight' : f.startsWith('JetBrainsMono') ? 'JetBrains Mono' : 'Instrument Serif';
    const weight = Number(/-(\d{3})\./.exec(f)?.[1] ?? 400);
    return `@font-face{font-family:'${fam}';font-weight:${weight};src:url('file://${join(ROOT, 'server/assets/fonts', f)}') format('woff2')}`;
  })
  .join('\n');
const wordmark = readFileSync(join(ROOT, 'public/wordmark.svg'), 'utf8').replace('<svg ', '<svg class="mark" ');
const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><style>
${fonts}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${W}px;height:${H}px;overflow:hidden}
body{background:${C.paper};color:${C.ink};font-family:'Inter Tight';-webkit-font-smoothing:antialiased}
.card{position:relative;width:${W}px;height:${H}px;padding:72px 80px}
.mono{font-family:'JetBrains Mono';font-variant-numeric:tabular-nums;letter-spacing:-0.02em}
.mark{position:absolute;right:80px;bottom:64px;height:46px;width:auto}
.lbl{font:600 40px/1.1 'Inter Tight';color:${C.mute}}
.val{font:700 72px/1.05 'JetBrains Mono';letter-spacing:-0.03em;font-variant-numeric:tabular-nums}
.row{padding:22px 0;border-top:2px solid ${C.rule}}
.row:first-child{border-top:0;padding-top:0}
.who{font:750 52px/1.1 'Inter Tight';letter-spacing:-0.03em}
</style></head><body><div class="card">${body}${wordmark}</div></body></html>`;

// ── chart: price line + the trader's buys and sells ─────────
function chart({ pts, marks, w, h, upTo = Infinity, ring = null, from = -Infinity }) {
  const P = pts.filter(([t]) => t <= upTo && t >= from);
  const ms = marks.filter((m) => m.t <= upTo);
  const t0 = P[0][0];
  const t1 = Math.max(P[P.length - 1][0], ...ms.map((m) => m.t));
  const lo = Math.min(...P.map((p) => p[1]));
  const hi = Math.max(...P.map((p) => p[1]));
  const log = hi / lo > 6;
  const f = (v) => (log ? Math.log(v) : v);
  const pad = 64;
  const x = (t) => pad + ((t - t0) / (t1 - t0 || 1)) * (w - 2 * pad);
  const y = (v) => pad + (1 - (f(v) - f(lo)) / (f(hi) - f(lo) || 1)) * (h - 2 * pad);
  const at = (t) => {
    let k = 0;
    for (let i = 0; i < P.length; i++) if (Math.abs(P[i][0] - t) < Math.abs(P[k][0] - t)) k = i;
    return P[k][1];
  };
  const line = P.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const area = `${line}L${x(P[P.length - 1][0]).toFixed(1)},${h - pad}L${x(t0).toFixed(1)},${h - pad}Z`;
  const max = Math.max(...ms.map((m) => m.sol));
  const dot = (m) => {
    const r = 12 + 26 * Math.sqrt(m.sol / max);
    const cx = x(m.t);
    const cy = y(at(m.t));
    const c = m.side === 'buy' ? C.buy : C.sell;
    const halo = ring && m.t === ring ? `<circle cx="${cx}" cy="${cy}" r="${r + 14}" fill="none" stroke="${C.lime}" stroke-width="10"/>` : '';
    return `${halo}<circle cx="${cx}" cy="${cy}" r="${r}" fill="${c}" fill-opacity="0.9" stroke="#fff" stroke-width="4"/>`;
  };
  // small dots on top of big ones
  const dots = [...ms].sort((a, b) => b.sol - a.sol).map(dot).join('');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <rect x="0" y="0" width="${w}" height="${h}" rx="28" fill="#fff"/>
    ${[1, 2, 3].map((i) => `<line x1="${pad}" x2="${w - pad}" y1="${pad + (i * (h - 2 * pad)) / 4}" y2="${pad + (i * (h - 2 * pad)) / 4}" stroke="${C.rule}" stroke-width="2"/>`).join('')}
    <path d="${area}" fill="${C.ink}" fill-opacity="0.06"/>
    <path d="${line}" fill="none" stroke="${C.ink}" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
  </svg>`;
}

// ── the cards ──────────────────────────────────────────────
const cards = [];

// 1. a buy alert at a glance: bag, building since, PnL with this buy, the buys so far on the chart
{
  const p = data('fox-housecoin-at-buy.json');
  const now = data('fox-housecoin-now.json');
  const last = p.legs.filter((l) => l.kind === 'buy').pop();
  const pnl = p.pnl;
  const step = now.chart.pts[1][0] - now.chart.pts[0][0];
  cards.push([
    'alert',
    page(`
    <div style="display:grid;grid-template-columns:680px 1fr;gap:48px;height:100%">
      <div>
        <div class="row"><div class="who">${esc(p.name)} bought ${sol(last.sol, 2)} of $${esc(p.sym)}</div></div>
        <div class="row"><div class="lbl">Bag</div><div class="val">${sol(p.bag.valueSol, 1)}</div><div class="lbl" style="color:${C.ink};margin-top:8px">${big(p.bag.tokens)} $${esc(p.sym)}</div></div>
        <div class="row"><div class="lbl">Building since</div><div class="val" style="font-size:56px">${day(p.building.since)}</div></div>
        <div class="row"><div class="lbl">PnL with this buy</div><div class="val" style="font-size:56px;color:${pnl.sol < 0 ? C.sell : C.buy}">${signed(pnl.sol)} · ${signed(pnl.pct, '%')}</div></div>
      </div>
      <div style="padding-bottom:90px">${chart({ pts: now.chart.pts, marks: now.chart.marks, w: 712, h: 660, from: now.chart.marks[0].t - 2 * step, upTo: last.t + 2 * step, ring: last.t })}</div>
    </div>`),
  ]);
}

// 2. how the trader traded the coin: every buy and sell on the price line
{
  const p = data('fox-housecoin-now.json');
  const r = p.rounds[p.rounds.length - 1];
  cards.push([
    'chart',
    page(`
    <div style="display:flex;flex-direction:column;gap:36px;height:100%">
      <div class="who">${esc(p.name)} in $${esc(p.sym)} · ${day(r.start).replace(/, .*/, '')} – ${day(r.end).replace(/, .*/, '')}</div>
      ${chart({ pts: p.chart.pts, marks: p.chart.marks, w: 1440, h: 520, from: p.chart.marks[0].t - 2 * (p.chart.pts[1][0] - p.chart.pts[0][0]) })}
      <div style="display:flex;gap:64px;align-items:center;font:600 46px/1 'Inter Tight'">
        <span><span style="color:${C.buy}">●</span> ${r.buys} buys · <span class="mono">${sol(r.spentSol, 1)}</span></span>
        <span><span style="color:${C.sell}">●</span> ${r.sells} sell · <span class="mono">${sol(r.gotSol, 1)}</span></span>
        <span>PnL <span class="mono" style="color:${r.pnlSol < 0 ? C.sell : C.buy}">${signed(r.pnlSol)}</span></span>
      </div>
    </div>`),
  ]);
}

// 3. re-entry: every full exit closes a round; "building since" starts at the first buy of the new one
{
  const p = data('slingoor-wbtc.json');
  const rs = p.rounds;
  const openStart = p.building.since;
  const t0 = rs[0].start;
  const t1 = Date.parse('2026-10-31T14:30:00Z');
  const w = 1440;
  const x = (t) => ((t - t0) / (t1 - t0)) * w;
  const bars = [
    ...rs.map((r) => `<div style="position:absolute;left:${x(r.start)}px;width:${Math.max(10, x(r.end) - x(r.start))}px;top:0;bottom:0;background:${C.ink};border-radius:10px"></div>`),
    `<div style="position:absolute;left:${x(openStart)}px;width:${x(t1) - x(openStart)}px;top:0;bottom:0;background:${C.lime};border-radius:10px"></div>`,
  ].join('');
  const ticks = rs.map((r) => `<div style="position:absolute;left:${x(r.end) - 2}px;top:-18px;bottom:-18px;width:4px;background:${C.sell}"></div>`).join('');
  cards.push([
    'rounds',
    page(`
    <div style="display:flex;flex-direction:column;gap:56px;height:100%">
      <div class="who">${esc(p.name)} in $${esc(p.sym)} · ${day(t0).replace(/, .*/, '')} – ${day(t1).replace(/, .*/, '')}</div>
      <div style="position:relative;height:230px;margin-top:36px">${bars}${ticks}</div>
      <div style="display:grid;grid-template-columns:440px 1fr;gap:56px;margin-top:28px">
        <div><div class="lbl"><span style="display:inline-block;width:10px;height:40px;vertical-align:-6px;background:${C.sell};margin-right:16px"></span>Full exits</div><div class="val" style="font-size:120px">${p.reentry.rounds}</div></div>
        <div><div class="lbl"><span style="display:inline-block;width:40px;height:40px;vertical-align:-6px;background:${C.lime};border-radius:8px;margin-right:16px"></span>Building again since</div><div class="val" style="font-size:72px;margin-top:24px">${day(openStart)}</div></div>
      </div>
    </div>`),
  ]);
}

// 4. the same data in your AI: the MCP tool and its answer, cut into short lines
{
  const text = readFileSync(join(OUT, 'data/mcp-slingoor-jajaja.txt'), 'utf8');
  const bag = /^Bag: (.*?) \((\$[\d.]+[kM]?)\)/m.exec(text);
  const since = /^Building since (.*?): (\d+) buys, \d+ sells, ([\d.]+) SOL in.*?average entry at (\$[\d.]+[kM]?) market cap/m.exec(text);
  const pnl = /^(PnL on the coin [^:]*): ([+−-][\d.]+ SOL \([+−-]?\d+%\))/m.exec(text);
  const lines = [`Bag: ${bag[1]} (${bag[2]})`, `Building since ${since[1]}`, `${since[2]} buys, ${since[3]} SOL in, entry at ${since[4]} market cap`, `${pnl[1]}: ${pnl[2]}`];
  cards.push([
    'mcp',
    page(`
    <div style="display:flex;flex-direction:column;gap:48px;height:100%">
      <div class="mono" style="font-size:56px;font-weight:700;background:${C.ink};color:${C.paper};padding:22px 32px;border-radius:20px;align-self:flex-start">position(wallet, mint)</div>
      <div style="display:flex;flex-direction:column;gap:26px;font:500 46px/1.25 'JetBrains Mono';letter-spacing:-0.02em">
        <div style="font-weight:700">${esc(text.split('\n')[0])}</div>
        ${lines.map((l) => `<div>${esc(l)}</div>`).join('')}
      </div>
    </div>`),
  ]);
}

// ── render ─────────────────────────────────────────────────
const shell = [
  process.env.CHROME,
  ...['chromium_headless_shell-1223', 'chromium_headless_shell-1217', 'chromium_headless_shell-1208'].map((v) => join(homedir(), 'Library/Caches/ms-playwright', v, 'chrome-headless-shell-mac-arm64/chrome-headless-shell')),
].find((p) => p && existsSync(p));
cards.forEach(([name, html], i) => {
  const base = join(OUT, `${i + 1}-${name}`);
  writeFileSync(`${base}.html`, html);
  if (!shell) return;
  execFileSync(shell, ['--headless', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files', `--window-size=${W},${H}`, '--force-device-scale-factor=2', '--virtual-time-budget=3000', `--screenshot=${base}.png`, `file://${base}.html`], { stdio: 'ignore' });
  console.log(`${base}.png`);
});
if (!shell) console.log('no headless Chrome found: set CHROME=/path/to/chrome; HTML written next to the PNG names');
