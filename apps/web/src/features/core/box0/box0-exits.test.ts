/**
 * SH-BOX0-EXITS: the ways out of a stopped draw, as the page shows them (model) and the hidden item a take by number
 * names (pool search). The contract rules mirrored (BoxTickets.sol):
 *
 * - `enterTerminal`: graduated, not terminal, the queue's head dead. The page never offers it and says nothing before a
 *   stop (F142, desk R61-STOP "hide"); it reads the dead head (simulated: `headDead`) only to keep a draw that would
 *   revert `QueueDead` off the page.
 * - `cancelDraw`: terminal, the draw still requested; pays its drawer the release quote, fee-free after graduation.
 * - `handBack`: terminal and no graduation word stored (`HandBackClosed` otherwise); the holder's placeholders.
 * - `takeByNumber`: terminal from `terminalAt + TAKE_DELAY` (3 days); a numbered item must be in the draw pool at the
 *   index named; the vault refuses one that is not hidden.
 */
import { permutePlaceholderShuffle } from '@squarehole/chain';
import type { Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import * as model from './box0-model';
import { DRAW, PHASE, TAKE_DELAY, drawOffer, drawRow, placeholderRow, queueBlocked, roundDownFit, takeOffer } from './box0-model';
import { findTakeable, takeSearchStart, takeSpan } from './box0-terminal';

const me = '0x00000000000000000000000000000000000000a1' as const;
const NOW = 1_800_000_000n;
const DAY = 86_400n;
const FIT = 10n ** 18n;
const requested = { id: 2n, drawer: me, status: DRAW.Requested, itemId: 0n, fallbackAt: 0n };

describe('SH-BOX0-EXITS model: before any stop (F142)', () => {
  it('says nothing about a dead head: a requested draw and a placeholder without a number keep their waiting lines', () => {
    // F142 (desk R61-STOP "hide"): no stop button and no pre-stop hint; the model has no stop offer at all.
    expect('stopOffer' in model).toBe(false);
    expect(drawRow(requested, NOW, 'Misfit')).toEqual({ key: 'draw-2', text: 'Draw 2 · waiting for its number', action: null });
    const t = { phase: PHASE.AwaitingWord, wordAcceptedAt: 0n, now: NOW, service: null, refund: null };
    expect(placeholderRow({ id: 7n, number: 0n, approved: null }, t, 'Misfit')).toEqual({ key: 'placeholder-7', text: 'Placeholder 7 · waiting for numbers', action: null });
    // A release quote read outside terminal mode never turns into a way out.
    expect(drawRow(requested, NOW, 'Misfit', false, 999n * FIT)).toEqual({ key: 'draw-2', text: 'Draw 2 · waiting for its number', action: null });
    expect(placeholderRow({ id: 7n, number: 0n, approved: null }, { ...t, phase: PHASE.Drawing, refund: 999n * FIT }, 'Misfit').action).toBeNull();
  });

  it('hides the draw while the dead head refuses it (QueueDead), but not when a draw would request the word', () => {
    const r = { headDead: true, slots: 4n, wordRequestedAt: NOW - 8n * DAY };
    expect(queueBlocked(r)).toBe(true);
    expect(drawOffer(PHASE.Drawing, 1_010n * FIT, queueBlocked(r))).toBeNull();
    // Nobody requested the graduation word for 30 days: the first draw requests it and does not check the head.
    expect(queueBlocked({ ...r, wordRequestedAt: 0n })).toBe(false);
    expect(queueBlocked({ ...r, headDead: false })).toBe(false);
    expect(drawOffer(PHASE.Drawing, 1_010n * FIT, false)).toEqual({ quote: 1_010n * FIT });
  });
});

describe('SH-BOX0-EXITS model: terminal mode', () => {
  it('gives a requested draw its FIT back, and keeps a settled one opening as before', () => {
    expect(drawRow(requested, NOW, 'Misfit', true, 999n * FIT)).toEqual({
      key: 'draw-2',
      text: 'Draw 2 · draws stopped',
      action: { kind: 'cancel-draw', ticket: 2n, amount: 999n * FIT, label: 'Get back' },
    });
    // No release quote readable: the line stays, without a button.
    expect(drawRow(requested, NOW, 'Misfit', true, null)).toEqual({ key: 'draw-2', text: 'Draw 2 · draws stopped', action: null });
    const settled = { ...requested, status: DRAW.Settled, itemId: 4101n, fallbackAt: NOW };
    expect(drawRow(settled, NOW, 'Misfit', true, 999n * FIT)?.action).toEqual({ kind: 'open-draw', ticket: 2n, label: 'Open without picture' });
  });

  it('hands back a placeholder without a number only while no word is stored; a numbered one keeps its open', () => {
    const t = { phase: PHASE.Terminal, wordAcceptedAt: 0n, now: NOW, service: null, refund: 999n * FIT };
    expect(placeholderRow({ id: 7n, number: 0n, approved: null }, t, 'Misfit')).toEqual({
      key: 'placeholder-7',
      text: 'Placeholder 7 · draws stopped',
      action: { kind: 'hand-back', tokenId: 7n, amount: 999n * FIT, label: 'Get back' },
    });
    const numbered = placeholderRow({ id: 7n, number: 77n, approved: null }, { ...t, wordAcceptedAt: NOW - 31n * DAY }, 'Misfit');
    expect(numbered.action).toEqual({ kind: 'open', tokenId: 7n, label: 'Open without picture' });
    expect(placeholderRow({ id: 7n, number: 0n, approved: null }, { ...t, refund: null }, 'Misfit').action).toBeNull();
  });

  it('offers a take by number from three days after the stop, only with a quote and a hidden item', () => {
    const base = { phase: PHASE.Terminal, terminalAt: NOW - TAKE_DELAY, now: NOW, quote: 1_010n * FIT, take: { itemId: 4123n, poolIndex: 5n } };
    expect(TAKE_DELAY).toBe(3n * DAY);
    expect(takeOffer(base)).toEqual({ kind: 'take', quote: 1_010n * FIT, itemId: 4123n, poolIndex: 5n });
    expect(takeOffer({ ...base, terminalAt: NOW - DAY })).toEqual({ kind: 'wait', days: 2n });
    expect(takeOffer({ ...base, terminalAt: NOW - DAY + 1n })).toEqual({ kind: 'wait', days: 3n });
    expect(takeOffer({ ...base, quote: null })).toBeNull();
    expect(takeOffer({ ...base, take: null })).toBeNull();
    expect(takeOffer({ ...base, phase: PHASE.Drawing })).toBeNull();
  });

  it('rounds a payout down (the page never shows more than it pays)', () => {
    expect(roundDownFit(999_999_999_999_999_999n)).toBe(99n * 10n ** 16n);
    expect(roundDownFit(10n ** 18n)).toBe(10n ** 18n);
  });
});

describe('SH-BOX0-EXITS pool search for a take by number', () => {
  const word = `0x${'5a'.repeat(32)}` as Hex;
  const pool = { word, firstId: 4100n, size: 64n };

  it('numbered: walks the pool, maps each position through the shuffle, and returns the first hidden item', async () => {
    const positions = [40n, 33n, 50n];
    const ids = positions.map((p) => pool.firstId + permutePlaceholderShuffle(word, p, pool.size));
    const reader = { positionAt: vi.fn(async (i: bigint) => positions[Number(i)] ?? 63n), isHidden: vi.fn(async (id: bigint) => id === ids[2]) };
    await expect(findTakeable({ slots: 10n, wordAcceptedAt: NOW, drawsSettled: 3n }, pool, reader)).resolves.toEqual({ itemId: ids[2], poolIndex: 2n });
    // No placeholders (q = 0): the position is the item's offset.
    const plain = { positionAt: async (i: bigint) => i + 3n, isHidden: async (id: bigint) => id === 4104n };
    await expect(findTakeable({ slots: 0n, wordAcceptedAt: 0n, drawsSettled: 3n }, pool, plain)).resolves.toEqual({ itemId: 4104n, poolIndex: 1n });
  });

  it('numbered: stops at the pool size and at its read limit, and finds nothing when nothing is hidden', async () => {
    const reader = { positionAt: vi.fn(async (i: bigint) => 10n + i), isHidden: vi.fn(async () => false) };
    await expect(findTakeable({ slots: 10n, wordAcceptedAt: NOW, drawsSettled: 50n }, pool, reader)).resolves.toBeNull();
    expect(reader.positionAt).toHaveBeenCalledTimes(4); // 64 − 10 − 50 left
    const big = { positionAt: vi.fn(async (i: bigint) => i), isHidden: vi.fn(async () => false) };
    await expect(findTakeable({ slots: 0n, wordAcceptedAt: 0n, drawsSettled: 0n }, { ...pool, size: 10_000n }, big, 16)).resolves.toBeNull();
    expect(big.positionAt).toHaveBeenCalledTimes(16);
  });

  // Review of SH-BOX0-EXITS: a take leaves its position in the pool, so after 64 takes the first 64 pool indexes are all
  // taken. A search that always starts at index 0 then finds nothing, and the take is gone from the page for good while
  // the contract still allows it. The search starts where it is told and wraps around the pool's end.
  it('starts where it is told and wraps around the pool, so taken items at the front never hide the take', async () => {
    const big = { ...pool, size: 10_000n };
    const reader = { positionAt: vi.fn(async (i: bigint) => i), isHidden: vi.fn(async (id: bigint) => id - big.firstId >= 64n) };
    await expect(findTakeable({ slots: 0n, wordAcceptedAt: 0n, drawsSettled: 0n }, big, reader)).resolves.toBeNull();
    await expect(findTakeable({ slots: 0n, wordAcceptedAt: 0n, drawsSettled: 0n }, big, reader, 64, 5_000n)).resolves.toEqual({ itemId: big.firstId + 5_000n, poolIndex: 5_000n });
    // From the last index the walk wraps to index 0: here only index 1 is hidden.
    const wrap = { positionAt: vi.fn(async (i: bigint) => i), isHidden: vi.fn(async (id: bigint) => id === pool.firstId + 1n) };
    await expect(findTakeable({ slots: 0n, wordAcceptedAt: 0n, drawsSettled: 0n }, pool, wrap, 4, 63n)).resolves.toEqual({ itemId: pool.firstId + 1n, poolIndex: 1n });
    // A start past the span folds into it; without numbers the walk is over item offsets.
    const loose = { positionAt: vi.fn(async () => 0n), isHidden: vi.fn(async (id: bigint) => id === pool.firstId + 3n) };
    await expect(findTakeable({ slots: 10n, wordAcceptedAt: 0n, drawsSettled: 0n }, pool, loose, 8, 64n + 60n)).resolves.toEqual({ itemId: pool.firstId + 3n, poolIndex: 0n });
    expect(loose.positionAt).not.toHaveBeenCalled();
    // The reads' start: an index inside the span (the pool's R once numbered, else every item).
    expect(takeSpan({ slots: 10n, wordAcceptedAt: NOW, drawsSettled: 3n }, 64n)).toBe(51n);
    expect(takeSpan({ slots: 10n, wordAcceptedAt: 0n, drawsSettled: 0n }, 64n)).toBe(64n);
    expect([takeSearchStart(51n, () => 0), takeSearchStart(51n, () => 0.999_999_999), takeSearchStart(0n)]).toEqual([0n, (BigInt(Math.floor(0.999_999_999 * Number.MAX_SAFE_INTEGER)) % 51n), 0n]);
    for (let i = 0; i < 50; i += 1) expect(takeSearchStart(7n)).toBeLessThan(7n);
  });

  it('without numbers (placeholders, no word stored): any hidden item, its pool index unused', async () => {
    const reader = { positionAt: vi.fn(async () => 0n), isHidden: vi.fn(async (id: bigint) => id >= 4102n) };
    await expect(findTakeable({ slots: 10n, wordAcceptedAt: 0n, drawsSettled: 0n }, pool, reader)).resolves.toEqual({ itemId: 4102n, poolIndex: 0n });
    expect(reader.positionAt).not.toHaveBeenCalled();
  });
});
