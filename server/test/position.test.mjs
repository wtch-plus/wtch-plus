// Position engine checks (server/lib/position.mjs): node --test server/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ata, build, order, toLeg } from '../lib/position.mjs';

const H = 3600_000;
// a leg: slot, hours from 0, token change, balance after, SOL change
const leg = (slot, h, tok, bal, val) => ({ sig: `s${slot}-${tok}`, slot, t: h * H, tok, bal, val });

test('ATA matches a known token account (Token-2022 pump coin)', () => {
  assert.equal(ata('86AEJExyjeNNgcp7GrAvCXTDicf5aGWgoERbXFiG1EdD', '6VHEqmyE7zJr5RUX8ztS7FFMFGChFkdBx7ShZEWxpump', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'), 'CzaAzzd3f66Z4kmsuQSPGpKMwzzv3yX1LtmTyLshEhK5');
});

test('one round: bag, building since the first buy, PnL with the last fill price', () => {
  const p = build([leg(1, 0, 100, 100, -1), leg(2, 1, 100, 200, -2), leg(3, 2, -50, 150, 1.5)], 0.02);
  assert.equal(p.open.tokens, 150);
  assert.equal(p.open.start, 0);
  assert.equal(p.open.buys, 2);
  assert.equal(p.open.sells, 1);
  // spent 3, got 1.5, 150 tokens at 0.02 = 3 → +1.5
  assert.equal(p.open.pnlSol, 1.5);
  assert.equal(p.open.pnlPct, 50);
  assert.equal(p.reentry, null);
  assert.equal(p.rounds.length, 0);
});

test('re-entry: a full exit closes the round and the next buy starts a new one', () => {
  const p = build([leg(1, 0, 100, 100, -1), leg(2, 5, -100, 0, 3), leg(3, 48, 200, 200, -2), leg(4, 49, 100, 300, -1)], 0.01);
  assert.equal(p.rounds.length, 1);
  assert.equal(p.rounds[0].pnlSol, 2);
  assert.equal(p.open.start, 48 * H, 'building since the first buy after the exit, not the first buy ever');
  assert.equal(p.open.spentSol, 3);
  assert.equal(p.open.pnlSol, 0);
  assert.deepEqual(p.reentry, { rounds: 1, lastExit: 5 * H, earlierPnlSol: 2 });
  assert.equal(p.allTimePnlSol, 2);
});

test('"since" is exact after a full exit even when older history is cut', () => {
  // the first leg we can see already had 50 tokens before it: that round is cut, the next one starts from zero
  const p = build([leg(1, 0, 50, 100, -1), leg(2, 1, -100, 0, 2), leg(3, 2, 10, 10, -0.5)], 0.05);
  assert.equal(p.partial, true);
  assert.equal(p.open.partialStart, false);
  assert.equal(p.open.start, 2 * H);
  const cut = build([leg(1, 0, 50, 100, -1)], 0.01);
  assert.equal(cut.open.partialStart, true);
});

test('dust left after a sell counts as a full exit', () => {
  const p = build([leg(1, 0, 1e6, 1e6, -1), leg(2, 1, -999_999.5, 0.5, 2), leg(3, 30, 1e6, 1e6 + 0.5, -1)], 1e-6);
  assert.equal(p.rounds.length, 1);
  assert.equal(p.open.start, 30 * H);
});

test('trades in one slot are ordered by balance, not by arrival', () => {
  const legs = [leg(7, 1, -60, 0, 0.6), leg(7, 1, 100, 100, -1), leg(7, 1, -40, 60, 0.4)];
  assert.deepEqual(
    order(legs).map((l) => l.bal),
    [100, 60, 0],
  );
  const p = build(legs, 0.01);
  assert.equal(p.open, null);
  assert.equal(p.rounds[0].pnlSol, 0);
});

test('tokens sent to another wallet leave at cost', () => {
  const p = build([leg(1, 0, 1000, 1000, -10), leg(2, 0, -900, 100, 0), leg(3, 1, -100, 0, 1.2)], null);
  // 10 SOL bought 1000; 900 moved out at cost 9; the last 100 (cost 1) sold for 1.2 → +0.2
  assert.equal(p.rounds[0].pnlSol, 0.2);
});

test('tokens that came in by transfer make PnL unknown, not a profit', () => {
  const p = build([leg(1, 0, 50, 50, 0), leg(2, 1, 50, 100, 0), leg(3, 2, -100, 0, 8)], null);
  assert.equal(p.rounds[0].costKnown, false);
  assert.equal(p.rounds[0].pnlSol, null);
  assert.equal(p.allTimePnlSol, null);
});

test('a buy paid in USDC counts in SOL, and is flagged when SOL/USD is missing', () => {
  const W = 'W1111111111111111111111111111111111111111';
  const MEME = 'Meme111111111111111111111111111111111111pump';
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const tx = {
    slot: 3,
    blockTime: 100,
    meta: {
      err: null,
      preBalances: [1e9],
      postBalances: [1e9],
      preTokenBalances: [{ accountIndex: 1, owner: W, mint: USDC, uiTokenAmount: { uiAmount: 1000 } }],
      postTokenBalances: [
        { accountIndex: 1, owner: W, mint: USDC, uiTokenAmount: { uiAmount: 300 } },
        { accountIndex: 2, owner: W, mint: MEME, programId: 'p', uiTokenAmount: { uiAmount: 5e7 } },
      ],
    },
    transaction: { message: { accountKeys: [W, 'A1', 'A2'] } },
  };
  const priced = toLeg(tx, 'x', W, MEME, 100);
  assert.equal(priced.val, -7);
  assert.equal(priced.usd, true);
  assert.equal(toLeg(tx, 'x', W, MEME, null).usd, true);
});

test('a route that leaves dust of another coin: the SOL goes to the coin really bought', () => {
  const W = 'W1111111111111111111111111111111111111111';
  const MEME = 'Meme111111111111111111111111111111111111pump';
  const DUST = 'Dust11111111111111111111111111111111111111';
  const tx = {
    slot: 9,
    blockTime: 100,
    meta: {
      err: null,
      preBalances: [20e9],
      postBalances: [10e9],
      preTokenBalances: [],
      postTokenBalances: [
        { accountIndex: 1, owner: W, mint: MEME, programId: 'p', uiTokenAmount: { uiAmount: 2e8 } },
        { accountIndex: 2, owner: W, mint: DUST, programId: 'p', uiTokenAmount: { uiAmount: 0.08 } },
      ],
    },
    transaction: { message: { accountKeys: [W, 'A1', 'A2'] } },
  };
  // 10 SOL at $100 = $1000; the dust is worth 0.08 × $1250 = $100 now
  const prices = new Map([[DUST, 1250]]);
  const meme = toLeg(tx, 'x', W, MEME, 100, prices);
  const dust = toLeg(tx, 'x', W, DUST, 100, prices);
  assert.equal(meme.val, -9);
  assert.equal(dust.val, -1);
});
