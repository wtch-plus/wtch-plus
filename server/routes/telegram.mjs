// Telegram bot: the agent's pushes in a chat. Token: env TG_BOT_TOKEN or data/telegram.json (`npm run tg -- <token>`).
//   /start [wallet]  subscribe (all top wallets, or one wallet from the site's deep link)
//   /watch <wallet>  add a wallet        /unwatch <wallet>  remove it
//   /bar <sol>       push only swaps of this size and up (default 10)
//   /list            what this chat watches        /w <wallet>  a wallet card now
//   /stop            unsubscribe
// GET /api/tg  → { on, username } for the site's Connect page.
import { readFileSync } from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { httpError } from '../lib/http.mjs';
import { join } from 'node:path';
import { bus } from '../lib/bus.mjs';
import { WATCH } from './wallets.mjs';
import { alertCard, bigNum, digestCard, linkedCard, menuCard, positionCard, signalCard, walletCard, welcomeCard, winCard } from '../lib/cards.mjs';

const ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const nameOf = new Map(WATCH.map(([n, a]) => [a, n]));
const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

function readToken(cfg) {
  if (cfg.env.TG_BOT_TOKEN) return cfg.env.TG_BOT_TOKEN.trim();
  // one bot token = one poller: a dev server runs the bot only when asked, so it never steals prod's updates
  if (!cfg.prod && cfg.env.TG_DEV !== '1') return '';
  try {
    return JSON.parse(readFileSync(join(cfg.dataDir, 'telegram.json'), 'utf8')).token || '';
  } catch {
    return '';
  }
}

export default async function telegram(ctx) {
  const { db, log, cfg } = ctx;
  db.migrate('telegram', [
    'CREATE TABLE tg_chats (chat INTEGER PRIMARY KEY, bar REAL NOT NULL DEFAULT 10, all_top INTEGER NOT NULL DEFAULT 1, t INTEGER NOT NULL)',
    'CREATE TABLE tg_watch (chat INTEGER NOT NULL, w TEXT NOT NULL, PRIMARY KEY (chat, w))',
    // trades waiting for an hourly / daily digest (agents with cadence other than 'each')
    'CREATE TABLE tg_queue (chat INTEGER NOT NULL, sig TEXT NOT NULL, ev TEXT NOT NULL, t INTEGER NOT NULL, PRIMARY KEY (chat, sig))',
    'CREATE TABLE tg_flush (chat INTEGER PRIMARY KEY, t INTEGER NOT NULL)',
  ]);
  const token = readToken(cfg);
  let me = null;
  let offset = 0;
  let stopped = false;
  let sent = 0;
  const site = cfg.origin || 'https://wtch.plus';

  // the site's "Get Telegram alerts" link needs only the bot's name: a dev server that leaves polling to prod still has it
  let saved = null;
  try {
    saved = JSON.parse(readFileSync(join(cfg.dataDir, 'telegram.json'), 'utf8')).username || null;
  } catch {}
  ctx.route('GET', '/api/tg', () => {
    const username = me?.username ?? saved;
    return { on: Boolean(username), username };
  });
  // ── Mini App API: Telegram signs initData with the bot token, so the chat (= the user id in a private chat) is
  // proven without a separate login. Header: `X-Tg-Init: <initData>`. Valid for 24 h.
  let verifyToken = cfg.env.TG_BOT_TOKEN?.trim() || '';
  if (!verifyToken) {
    try {
      verifyToken = JSON.parse(readFileSync(join(cfg.dataDir, 'telegram.json'), 'utf8')).token || '';
    } catch {}
  }
  function tgUser(req) {
    const raw = String(req.headers['x-tg-init'] || '');
    if (!raw || !verifyToken) throw httpError(401, 'telegram');
    const q = new URLSearchParams(raw);
    const hash = q.get('hash') || '';
    q.delete('hash');
    const check = [...q.entries()].sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
    const secret = createHmac('sha256', 'WebAppData').update(verifyToken).digest();
    const want = createHmac('sha256', secret).update(check).digest();
    const got = Buffer.from(hash, 'hex');
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw httpError(401, 'telegram');
    if (Date.now() / 1000 - Number(q.get('auth_date') || 0) > 86400) throw httpError(401, 'expired');
    const user = JSON.parse(q.get('user') || '{}');
    if (!user.id) throw httpError(401, 'telegram');
    return user;
  }
  const agentFor = (id) => {
    let a = null;
    bus.emit('agent:chat', id, (x) => (a = x));
    return a;
  };
  const miniLimit = ctx.rate(60);
  ctx.route('GET', '/api/tg/agent', (req, _res, { ip }) => {
    miniLimit(ip);
    const u = tgUser(req);
    return { agent: agentFor(u.id), user: { id: u.id, name: u.first_name || u.username || '' } };
  });
  ctx.route('PATCH', '/api/tg/agent', async (req, _res, { ip, body }) => {
    miniLimit(ip);
    const u = tgUser(req);
    let a = null;
    bus.emit('agent:patch', u.id, (await body()) || {}, (x) => (a = x));
    if (!a) throw httpError(404, 'spawn');
    return { agent: a };
  });

  ctx.health('telegram', () => ({ ok: !token || Boolean(me), on: Boolean(token), bot: me?.username ?? null, chats: db.all('SELECT COUNT(*) n FROM tg_chats')[0]?.n ?? 0, sent }));
  if (!token) {
    log('telegram.off', { hint: 'npm run tg -- <token>' });
    return;
  }

  const call = async (method, body, ms = 15000) => {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(ms),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(`${method}: ${j.description}`);
    return j.result;
  };
  const say = (chat, text) =>
    call('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }).catch((e) => {
      if (/blocked|chat not found|deactivated/.test(e.message)) db.run('DELETE FROM tg_chats WHERE chat = ?', chat);
      log('telegram.send.fail', { e: e.message.slice(0, 80) });
    });

  // a card (PNG) with a caption; falls back to the caption as text when cards are off
  const MENU = {
    inline_keyboard: [
      [{ text: 'Biggest trades today', callback_data: 'digest' }, { text: 'My alerts', callback_data: 'list' }],
      [{ text: 'Tune your agent', web_app: { url: `${site}/tg` } }],
      [{ text: 'Open wtch.plus', url: site }],
    ],
  };
  // under every coin alert: copy the CA in one tap (Bot API copy_text), open the chart
  const coinKeys = (mint) => ({
    inline_keyboard: [[{ text: 'Copy CA', copy_text: { text: mint } }, { text: 'Chart', url: `https://dexscreener.com/solana/${mint}` }]],
  });
  async function photo(chat, buf, caption, markup) {
    if (!buf) return call('sendMessage', { chat_id: chat, text: caption, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: markup }).catch(() => undefined);
    const fd = new FormData();
    fd.set('chat_id', String(chat));
    fd.set('caption', caption);
    fd.set('parse_mode', 'HTML');
    if (markup) fd.set('reply_markup', JSON.stringify(markup));
    fd.set('photo', new Blob([buf], { type: 'image/png' }), 'card.png');
    const r = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: fd, signal: AbortSignal.timeout(20000) }).then((x) => x.json()).catch((e) => ({ ok: false, description: String(e) }));
    if (!r.ok) {
      log('telegram.photo.fail', { e: String(r.description).slice(0, 80) });
      return say(chat, caption);
    }
  }
  async function digest(chat) {
    const day = Date.now() - 86400_000;
    const rows = db.all('SELECT w, side, sol, mint, sym, t FROM trades WHERE t > ? ORDER BY sol DESC LIMIT 5', day).map((r) => ({ ...r, name: label(r.w) }));
    if (!rows.length) return say(chat, 'wtch+ recorded zero trades in the last 24 hours.');
    return photo(chat, await digestCard(rows).catch(() => null), `<b>Biggest trades, last 24 hours</b>\n\nTracked wallets: ${WATCH.length}`, MENU);
  }

  const chatRow = (chat) => db.all('SELECT * FROM tg_chats WHERE chat = ?', chat)[0];
  const watched = (chat) => db.all('SELECT w FROM tg_watch WHERE chat = ?', chat).map((r) => r.w);
  const label = (w) => nameOf.get(w) ?? short(w);

  const HELP = [
    '<b>Commands</b>',
    '',
    '/watch &lt;wallet&gt; adds a wallet to your alerts.',
    '/unwatch &lt;wallet&gt; removes a wallet from your alerts.',
    '/bar 1 sets the smallest trade size in SOL that sends an alert.',
    '/list shows the wallets you get alerts for.',
    '/digest shows the biggest trades of the last 24 hours.',
    '/menu shows your agent and its buttons.',
    '/w &lt;wallet&gt; shows the stats of a wallet.',
    '/stop turns off all alerts.',
  ].join('\n');

  // ── captions: a bold headline, then short blocks split by blank lines
  const tick = (x) => `$${esc(x.sym || x.mint.slice(0, 4))}`;
  const tradeCaption = (ev) =>
    [
      `<b>${esc(ev.name)} ${ev.side === 'buy' ? 'bought' : 'sold'} ${ev.sol} SOL</b>`,
      `${ev.side === 'buy' ? 'Buy' : 'Sell'} · ${tick(ev)}`,
      '',
      `<code>${ev.mint}</code>`,
      '',
      `<a href="${site}/w/${ev.w}">Wallet</a>  ·  <a href="https://solscan.io/tx/${ev.sig}">Transaction</a>`,
    ].join('\n');
  // buy with the trader's whole position: one fact per line (server/routes/positions.mjs)
  const when = (t) =>
    `${new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}, ${new Date(t).toISOString().slice(11, 16)} UTC`;
  const day = (t) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const positionCaption = (ev, pos) => {
    const sym = `$${esc(pos.sym || ev.sym || ev.mint.slice(0, 4))}`;
    const b = pos.building;
    const lines = [`<b>${esc(ev.name)} bought ${ev.sol} SOL of ${sym}</b>`, ''];
    if (pos.bag) {
      const pct = pos.bag.shareOfPortfolio == null ? null : pos.bag.shareOfPortfolio * 100;
      const share = pct == null ? '' : `, ${pct < 1 ? 'under 1' : Math.round(pct)}% of the wallet`;
      lines.push(`Bag: ${bigNum(pos.bag.tokens)} ${sym} = ${Math.round(pos.bag.valueSol * 100) / 100} SOL ($${Math.round(pos.bag.valueUsd).toLocaleString('en-US')})${share}.`);
    }
    if (b?.since) {
      const counts = `${b.buys} ${b.buys === 1 ? 'buy' : 'buys'}, ${b.sells} ${b.sells === 1 ? 'sell' : 'sells'}${b.transfersIn ? `, ${b.transfersIn} ${b.transfersIn === 1 ? 'transfer' : 'transfers'} in` : ''}`;
      if (pos.reentry?.lastExit) lines.push(`Building again since ${when(b.since)}, after a full exit on ${day(pos.reentry.lastExit)}: ${counts}.`);
      else lines.push(`Building since ${pos.partial ? 'at least ' : ''}${when(b.since)}: ${counts}.`);
    }
    if (pos.pnl?.costKnown === false || (pos.pnl && pos.pnl.sol == null)) lines.push('PnL: unknown, part of the bag came in by transfer.');
    else if (pos.pnl) {
      const p = pos.pnl;
      lines.push(`PnL on ${sym} with this buy: ${p.sol > 0 ? '+' : ''}${p.sol} SOL${p.pct == null ? '' : ` (${p.pct > 0 ? '+' : ''}${p.pct}%)`}.`);
    }
    lines.push('', `<code>${ev.mint}</code>`, '', `<a href="${site}/w/${ev.w}">Wallet</a>  ·  <a href="https://solscan.io/tx/${ev.sig}">Transaction</a>`);
    return lines.join('\n');
  };
  const positionOf = (ev) =>
    new Promise((res) => {
      const t = setTimeout(() => res(null), 12000);
      bus.emit('position?', ev.w, ev.mint, { sig: ev.sig }, (p) => {
        clearTimeout(t);
        res(p);
      });
    });

  const signalCaption = (sig) =>
    [
      `<b>${tick(sig)} is up ${Math.round(sig.change1h)}% in 1 hour</b>`,
      '',
      `Traded by ${sig.wallets.map((x) => esc(x.name)).join(', ')} in the last 24 hours.`,
      '',
      `<code>${sig.mint}</code>`,
    ].join('\n');
  const digestCaption = (title, rows, sigs) =>
    [
      `<b>${title}</b>`,
      '',
      `Trades: ${rows.length}`,
      `Growth signals: ${sigs.length}`,
      ...(sigs.length ? ['', ...sigs.map((x) => `${tick(x)} +${Math.round(x.change1h)}% in 1 hour`)] : []),
    ].join('\n');
  const walletCaption = (w) => [`<b>${esc(label(w))}</b>`, '', `<code>${w}</code>`, '', `<a href="${site}/w/${w}">Open this wallet on wtch.plus</a>`].join('\n');

  async function card(chat, w) {
    const v = await new Promise((res) => bus.emit('wallet?', w, res));
    if (!v) return say(chat, 'wtch+ could not read this wallet, so try again in a minute.');
    const trades = v.swaps.slice(0, 5).map((s) => `${s.side === 'buy' ? 'Bought' : 'Sold'} ${s.sol} SOL of $${esc(s.sym || s.mint.slice(0, 4))}.`);
    const buf = await walletCard(v, label(w)).catch(() => null);
    if (buf) return photo(chat, buf, walletCaption(w));
    return say(
      chat,
      [
        `<b>${esc(label(w))}</b> <code>${w}</code>`,
        `SOL balance: ${v.sol} SOL`,
        `SOL spent on buys in the last ${v.count} trades: ${v.flow.in} SOL`,
        `SOL received from sells in the last ${v.count} trades: ${v.flow.out} SOL`,
        `Profit in SOL over the last ${v.count} trades: ${v.flow.net} SOL`,
        '',
        ...trades,
        '',
        `<a href="${site}/w/${w}">Open this wallet on wtch.plus</a>`,
      ].join('\n'),
    );
  }

  // ── the agent (server/routes/agent.mjs) drives a linked chat: its watch list and minSol become the chat's
  const agentOf = (chat) => {
    let a = null;
    bus.emit('agent:chat', chat, (x) => (a = x));
    return a;
  };
  function syncChat(chat, a) {
    db.run('INSERT INTO tg_chats (chat, t) VALUES (?, ?) ON CONFLICT(chat) DO NOTHING', chat, Date.now());
    db.run('UPDATE tg_chats SET all_top = 0, bar = ? WHERE chat = ?', a.rules.minSol, chat);
    db.run('DELETE FROM tg_watch WHERE chat = ?', chat);
    for (const w of a.watch) db.run('INSERT OR IGNORE INTO tg_watch (chat, w) VALUES (?, ?)', chat, w);
  }
  bus.on('agent:changed', (a, chat) => chat && syncChat(chat, a));
  const isNewToken = (mint) => (db.get('SELECT COUNT(*) n FROM trades WHERE mint = ? AND t < ?', mint, Date.now() - 86400_000)?.n ?? 0) === 0;
  const passes = (a, ev) => {
    if (!a) return true;
    if (a.rules.sides === 'buys' && ev.side !== 'buy') return false;
    if (a.rules.sides === 'sells' && ev.side !== 'sell') return false;
    if (a.rules.newTokensOnly && !isNewToken(ev.mint)) return false;
    return true;
  };
  const CAD_MS = { hourly: 3600_000, daily: 86400_000 };
  async function flush() {
    for (const { chat } of db.all('SELECT DISTINCT chat FROM tg_queue')) {
      const a = agentOf(chat);
      const every = CAD_MS[a?.cadence] ?? 0;
      const last = db.get('SELECT t FROM tg_flush WHERE chat = ?', chat)?.t ?? 0;
      if (every && Date.now() - last < every) continue;
      const all = db.all('SELECT ev FROM tg_queue WHERE chat = ? ORDER BY t', chat).map((r) => JSON.parse(r.ev));
      const rows = all.filter((x) => x.kind !== 'signal');
      const sigs = all.filter((x) => x.kind === 'signal').sort((x, y) => y.change1h - x.change1h);
      db.run('DELETE FROM tg_queue WHERE chat = ?', chat);
      db.run('INSERT OR REPLACE INTO tg_flush (chat, t) VALUES (?, ?)', chat, Date.now());
      if (!all.length) continue;
      const top = rows.slice().sort((x, y) => y.sol - x.sol);
      const title = a?.cadence === 'daily' ? 'Last 24 hours' : 'Last hour';
      await photo(chat, await digestCard(top, title, sigs).catch(() => null), digestCaption(title, rows, sigs), MENU);
    }
  }
  const flushTimer = setInterval(() => void flush(), 5 * 60_000);
  flushTimer.unref?.();
  ctx.onStop(() => clearInterval(flushTimer));

  // /demo: one of each message type, built from live data, to the chat that asked (for screenshots and videos)
  async function demo(chat) {
    const recent = db.all('SELECT * FROM trades ORDER BY t DESC LIMIT 200').map((r) => ({ ...r, name: label(r.w) }));
    const buy = recent.find((r) => r.side === 'buy');
    const sell = recent.find((r) => r.side === 'sell');
    const top = recent.slice().sort((x, y) => y.sol - x.sol);
    const sig = { id: 'demo', mint: (buy || recent[0]).mint, sym: (buy || recent[0]).sym, change1h: 64, wallets: [...new Map(recent.slice(0, 6).map((r) => [r.w, { w: r.w, name: r.name }])).values()].slice(0, 3) };
    const r = chatRow(chat) ?? { bar: 10, all_top: 1 };
    await photo(chat, await welcomeCard().catch(() => null), `<b>Welcome to wtch+</b>\n\nYou get an alert here when one of the ${WATCH.length} top wallets trades 10 SOL or more.\n\n${HELP}`, MENU);
    await photo(chat, await menuCard({ wallets: r.all_top ? WATCH.length : watched(chat).length, bar: r.bar }).catch(() => null), `<b>Your agent</b>\n\nWallets: ${r.all_top ? WATCH.length : watched(chat).length}\nSmallest trade: ${r.bar} SOL`, MENU);
    if (buy) {
      const pos = await positionOf(buy).catch(() => null);
      if (pos?.found) await photo(chat, await positionCard(buy, pos).catch(() => null), positionCaption(buy, pos), coinKeys(buy.mint));
      else await photo(chat, await alertCard(buy).catch(() => null), tradeCaption(buy), coinKeys(buy.mint));
    }
    if (sell) await photo(chat, await alertCard(sell).catch(() => null), tradeCaption(sell), coinKeys(sell.mint));
    await photo(chat, await signalCard(sig).catch(() => null), signalCaption(sig), coinKeys(sig.mint));
    await photo(chat, await digestCard(top.slice(0, 3), 'Last hour', [sig]).catch(() => null), digestCaption('Last hour', top.slice(0, 12), [sig]), MENU);
    await card(chat, WATCH[0][1]);
    await photo(chat, await linkedCard(WATCH[0][1]).catch(() => null), `<b>Wallet linked</b>\n\n<code>${WATCH[0][1]}</code>`);
    if (buy) await photo(chat, await winCard({ sym: buy.sym || buy.mint.slice(0, 4), buy: 2, sell: 5.3 }).catch(() => null), `<b>${tick(buy)} closed at ×2.65</b>\n\nExample of a profit card.`);
  }

  async function onMessage(m) {
    const chat = m.chat?.id;
    const text = String(m.text || '').trim();
    if (!chat || !text.startsWith('/')) return;
    const [cmd0, arg = ''] = text.split(/\s+/, 2);
    const cmd = cmd0.split('@')[0].toLowerCase();
    const now = Date.now();
    if (cmd === '/start') {
      db.run('INSERT INTO tg_chats (chat, t) VALUES (?, ?) ON CONFLICT(chat) DO NOTHING', chat, now);
      const am = /^agent_([0-9a-f]{12})$/.exec(arg);
      if (am) {
        let a = null;
        bus.emit('agent?', am[1], (x) => (a = x));
        if (!a) return say(chat, 'This agent link is out of date, so open wtch.plus and press the Telegram button again.');
        bus.emit('agent:link', a.id, chat, m.from?.username ?? null);
        syncChat(chat, a);
        const side = a.rules.sides === 'all' ? 'every trade' : a.rules.sides === 'buys' ? 'every buy' : 'every sell';
        return photo(
          chat,
          await welcomeCard().catch(() => null),
          `Your agent <b>${esc(a.name)}</b> now sends ${side} of ${a.rules.minSol} SOL or more by ${a.watch.length} wallets here.`,
          MENU,
        );
      }
      if (ADDR.test(arg)) {
        // the site's deep link: this chat follows one wallet (usually the trader's own), every trade from 0.1 SOL
        db.run('INSERT OR IGNORE INTO tg_watch (chat, w) VALUES (?, ?)', chat, arg);
        db.run('UPDATE tg_chats SET all_top = 0, bar = 0.1 WHERE chat = ?', chat);
        bus.emit('track', arg);
        await photo(chat, await welcomeCard().catch(() => null), `<b>Welcome to wtch+</b>\n\nYou get an alert here for every trade of 0.1 SOL or more by <b>${esc(label(arg))}</b>.\n\n${HELP}`, MENU);
        return card(chat, arg);
      }
      return photo(chat, await welcomeCard().catch(() => null), `<b>Welcome to wtch+</b>\n\nYou get an alert here when one of the ${WATCH.length} top wallets trades 10 SOL or more.\n\n${HELP}`, MENU);
    }
    if (!chatRow(chat)) db.run('INSERT INTO tg_chats (chat, t) VALUES (?, ?)', chat, now);
    if (cmd === '/watch' || cmd === '/unwatch' || cmd === '/w') {
      if (!ADDR.test(arg)) return say(chat, 'Put a Solana wallet address after the command.');
      if (cmd === '/w') return card(chat, arg);
      if (cmd === '/watch') {
        db.run('INSERT OR IGNORE INTO tg_watch (chat, w) VALUES (?, ?)', chat, arg);
        db.run('UPDATE tg_chats SET all_top = 0 WHERE chat = ?', chat);
        bus.emit('track', arg);
        return say(chat, `You now get alerts for <b>${esc(label(arg))}</b>.`);
      }
      db.run('DELETE FROM tg_watch WHERE chat = ? AND w = ?', chat, arg);
      if (!watched(chat).length) db.run('UPDATE tg_chats SET all_top = 1 WHERE chat = ?', chat);
      return say(chat, `You stopped alerts for <b>${esc(label(arg))}</b>.`);
    }
    if (cmd === '/bar') {
      const n = Number(arg);
      if (!(n >= 0.1 && n <= 10000)) return say(chat, 'Put a size in SOL after the command, like /bar 10.');
      db.run('UPDATE tg_chats SET bar = ? WHERE chat = ?', n, chat);
      return say(chat, `You get alerts for trades of ${n} SOL or more.`);
    }
    if (cmd === '/list') {
      const r = chatRow(chat);
      const list = r.all_top ? WATCH.map(([n]) => n) : watched(chat).map(label);
      return say(chat, `You get alerts for trades of ${r.bar} SOL or more by ${list.map(esc).join(', ')}.`);
    }
    if (cmd === '/menu') {
      const r = chatRow(chat);
      const n = r.all_top ? WATCH.length : watched(chat).length;
      return photo(chat, await menuCard({ wallets: n, bar: r.bar }).catch(() => null), `<b>Your agent</b>\n\nWallets: ${n}\nSmallest trade: ${r.bar} SOL`, MENU);
    }
    if (cmd === '/digest') return digest(chat);
    if (cmd === '/demo') return demo(chat);
    if (cmd === '/stop') {
      db.run('DELETE FROM tg_watch WHERE chat = ?', chat);
      db.run('DELETE FROM tg_chats WHERE chat = ?', chat);
      return say(chat, 'Alerts are off, and /start turns them back on.');
    }
    return say(chat, HELP);
  }

  bus.on('trade', (ev) => {
    const chats = db.all(
      `SELECT c.chat FROM tg_chats c
       WHERE c.bar <= ? AND ((c.all_top = 1 AND ? = 1) OR EXISTS (SELECT 1 FROM tg_watch w WHERE w.chat = c.chat AND w.w = ?))`,
      ev.sol,
      nameOf.has(ev.w) ? 1 : 0,
      ev.w,
    );
    const msg = tradeCaption(ev);
    const kb = coinKeys(ev.mint);
    const now = [];
    for (const { chat } of chats) {
      const a = agentOf(chat);
      if (!passes(a, ev)) continue;
      if (a && a.cadence !== 'each') db.run('INSERT OR IGNORE INTO tg_queue (chat, sig, ev, t) VALUES (?, ?, ?, ?)', chat, ev.sig, JSON.stringify(ev), Date.now());
      else now.push(chat);
    }
    if (!now.length) return;
    // buys show the trader's whole position in the coin; anything missing falls back to the plain trade card
    void (async () => {
      const pos = ev.side === 'buy' ? await positionOf(ev).catch(() => null) : null;
      const full = pos?.found;
      const buf = await (full ? positionCard(ev, pos) : alertCard(ev)).catch(() => null);
      const caption = full ? positionCaption(ev, pos) : msg;
      for (const chat of now) {
        sent++;
        void photo(chat, buf, caption, kb);
      }
    })();
  });

  // growth signals (server/routes/signals.mjs): to every chat that watches a wallet which traded the coin
  bus.on('signal', (sig) => {
    const ws = (sig.wallets || []).map((x) => x.w);
    if (!ws.length) return;
    const chats = db.all(`SELECT DISTINCT chat FROM tg_watch WHERE w IN (${ws.map(() => '?').join(',')})`, ...ws).map((r) => r.chat);
    const now = [];
    for (const chat of chats) {
      const a = agentOf(chat);
      if (a && a.cadence !== 'each') db.run('INSERT OR IGNORE INTO tg_queue (chat, sig, ev, t) VALUES (?, ?, ?, ?)', chat, `signal:${sig.id}`, JSON.stringify({ kind: 'signal', ...sig }), Date.now());
      else now.push(chat);
    }
    if (!now.length) return;
    const msg = signalCaption(sig);
    const kb = coinKeys(sig.mint);
    void signalCard(sig)
      .catch(() => null)
      .then((buf) => {
        for (const chat of now) {
          sent++;
          void photo(chat, buf, msg, kb);
        }
      });
  });

  async function loop() {
    while (!stopped) {
      try {
        const ups = await call('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, 35000);
        for (const u of ups) {
          offset = u.update_id + 1;
          if (u.callback_query) {
            const q = u.callback_query;
            void call('answerCallbackQuery', { callback_query_id: q.id }).catch(() => undefined);
            const chat = q.message?.chat?.id;
            if (chat && q.data === 'digest') await digest(chat);
            if (chat && q.data === 'list') await onMessage({ chat: { id: chat }, text: '/list' });
            continue;
          }
          if (u.message) await onMessage(u.message).catch((e) => log('telegram.msg.fail', { e: String(e.message).slice(0, 80) }));
        }
      } catch (e) {
        if (stopped) break;
        log('telegram.poll.fail', { e: String(e.message || e).slice(0, 80) });
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  try {
    me = await call('getMe');
    await call('setMyCommands', {
      commands: [
        { command: 'watch', description: 'Adds a wallet to your alerts' },
        { command: 'bar', description: 'Sets the smallest trade size in SOL for alerts' },
        { command: 'list', description: 'Shows the wallets you get alerts for' },
        { command: 'w', description: 'Shows the stats of a wallet' },
        { command: 'menu', description: 'Shows your agent and its buttons' },
        { command: 'digest', description: 'Shows the biggest trades of the last 24 hours' },
        { command: 'stop', description: 'Turns off all alerts' },
      ],
    }).catch(() => undefined);
    // the chat's menu button opens the Mini App (Telegram needs an https URL, so this is prod only)
    if (site.startsWith('https://'))
      await call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Agent', web_app: { url: `${site}/tg` } } }).catch(() => undefined);
    void loop();
    log('telegram.ready', { bot: me.username });
  } catch (e) {
    log('telegram.fail', { e: String(e.message || e).slice(0, 120) });
  }
  ctx.onStop(() => {
    stopped = true;
  });
}
