import { describe, expect, it } from 'vitest';
import { DRAW, PHASE, REVEAL_GRACE, claimOffer, drawOffer, drawRow, placeholderRow, roundUpFit } from './box0-model';

const me = '0x00000000000000000000000000000000000000a1' as const;
const service = '0x000000000000000000000000000000000000c0de' as const;
const NOW = 1_800_000_000n;
const DAY = 86_400n;
const FIT = 10n ** 18n;

describe('SH-BOX0-ACTIONS box 0 model', () => {
  it('offers a draw only while drawing (or waiting for the graduation word), with the chain quote', () => {
    expect(drawOffer(PHASE.Drawing, 1_234n * FIT)).toEqual({ quote: 1_234n * FIT });
    expect(drawOffer(PHASE.AwaitingWord, 1n)).toEqual({ quote: 1n });
    for (const phase of [PHASE.BeforeOpen, PHASE.Curve, PHASE.Terminal]) expect(drawOffer(phase, 1n)).toBeNull();
    expect(drawOffer(PHASE.Drawing, null)).toBeNull();
    expect(drawOffer(PHASE.Drawing, 0n)).toBeNull();
  });

  it('says where each draw is, and opens it without its picture only from its fallback time', () => {
    const base = { id: 3n, drawer: me, itemId: 0n, fallbackAt: 0n };
    expect(drawRow({ ...base, status: DRAW.Requested }, NOW, 'Misfit')).toEqual({ key: 'draw-3', text: 'Draw 3 · waiting for its number', action: null });
    const settled = { ...base, status: DRAW.Settled, itemId: 4101n, fallbackAt: NOW + 2n * DAY + 1n };
    expect(drawRow(settled, NOW, 'Misfit')).toEqual({ key: 'draw-3', text: 'Draw 3 · Misfit 4101 · on its way', action: null });
    expect(drawRow({ ...settled, fallbackAt: NOW }, NOW, 'Misfit')).toEqual({ key: 'draw-3', text: 'Draw 3 · Misfit 4101', action: { kind: 'open-draw', ticket: 3n, label: 'Open without picture' } });
    for (const status of [DRAW.None, DRAW.Opened, DRAW.Cancelled]) expect(drawRow({ ...base, status }, NOW, 'Misfit')).toBeNull();
  });

  it('says where each placeholder is: waiting for numbers, its number, the service approval, the fallback open', () => {
    const p = { id: 7n, number: 0n, approved: null };
    expect(placeholderRow(p, { phase: PHASE.AwaitingWord, wordAcceptedAt: 0n, now: NOW, service })).toEqual({ key: 'placeholder-7', text: 'Placeholder 7 · waiting for numbers', action: null });
    const numbered = { ...p, number: 77n };
    const drawing = { phase: PHASE.Drawing, wordAcceptedAt: NOW - DAY, now: NOW, service };
    expect(placeholderRow(numbered, drawing, 'Misfit')).toEqual({ key: 'placeholder-7', text: 'Placeholder 7 · Misfit 77', action: { kind: 'approve-service', tokenId: 7n, label: 'Let the service open it' } });
    expect(placeholderRow({ ...numbered, approved: service }, drawing, 'Misfit')).toEqual({ key: 'placeholder-7', text: 'Placeholder 7 · Misfit 77 · on its way', action: null });
    // No service in this build: the fallback date, in days.
    expect(placeholderRow(numbered, { ...drawing, service: null }, 'Misfit')).toEqual({ key: 'placeholder-7', text: 'Placeholder 7 · Misfit 77 · opens in 29 d', action: null });
    const late = { ...drawing, wordAcceptedAt: NOW - REVEAL_GRACE };
    expect(placeholderRow(numbered, late, 'Misfit')).toEqual({ key: 'placeholder-7', text: 'Placeholder 7 · Misfit 77', action: { kind: 'open', tokenId: 7n, label: 'Open without picture' } });
    expect(placeholderRow(p, { phase: PHASE.Terminal, wordAcceptedAt: 0n, now: NOW, service }, 'Misfit')).toEqual({ key: 'placeholder-7', text: 'Placeholder 7 · draws stopped', action: null });
  });

  it('claims what the stream pays: owed plus pending, less the 1 raw unit it keeps, up to what it holds', () => {
    expect(claimOffer({ owed: 0n, pending: [], held: 10n ** 30n, ids: [] })).toBeNull();
    expect(claimOffer({ owed: 1n, pending: [], held: 10n ** 30n, ids: [] })).toBeNull();
    expect(claimOffer({ owed: 0n, pending: [5n, 6n], held: 10n ** 30n, ids: [4100n, 4101n] })).toEqual({ amount: 10n, ids: [4100n, 4101n] });
    expect(claimOffer({ owed: 100n, pending: [50n], held: 40n, ids: [4100n] })).toEqual({ amount: 40n, ids: [4100n] });
    expect(claimOffer({ owed: 9n, pending: [], held: 10n ** 30n, ids: [] })).toEqual({ amount: 8n, ids: [] });
    const many = Array.from({ length: 60 }, (_, i) => BigInt(4100 + i));
    expect(claimOffer({ owed: 0n, pending: many.map(() => 2n), held: 10n ** 30n, ids: many })?.ids).toHaveLength(50);
  });

  it('rounds a charge up at two decimals, never down', () => {
    expect(roundUpFit(1n)).toBe(10n ** 16n);
    expect(roundUpFit(10n ** 16n)).toBe(10n ** 16n);
    expect(roundUpFit(10n ** 16n + 1n)).toBe(2n * 10n ** 16n);
  });

  it('in terminal mode: a waiting draw says draws stopped; a numbered placeholder still opens from its fallback (review)', () => {
    const base = { id: 3n, drawer: me, itemId: 0n, fallbackAt: 0n };
    expect(drawRow({ ...base, status: DRAW.Requested }, NOW, 'Misfit', true)).toEqual({ key: 'draw-3', text: 'Draw 3 · draws stopped', action: null });
    // A settled draw still opens in terminal mode (openDraw has no terminal check).
    expect(drawRow({ ...base, status: DRAW.Settled, itemId: 4101n, fallbackAt: NOW }, NOW, 'Misfit', true)?.action).toEqual({ kind: 'open-draw', ticket: 3n, label: 'Open without picture' });
    // `open` needs only the stored word, so a numbered placeholder keeps its fallback open after terminal mode begins.
    const terminal = { phase: PHASE.Terminal, wordAcceptedAt: NOW - REVEAL_GRACE, now: NOW, service: null };
    expect(placeholderRow({ id: 7n, number: 77n, approved: null }, terminal, 'Misfit')).toEqual({ key: 'placeholder-7', text: 'Placeholder 7 · Misfit 77', action: { kind: 'open', tokenId: 7n, label: 'Open without picture' } });
    expect(placeholderRow({ id: 7n, number: 77n, approved: null }, { ...terminal, wordAcceptedAt: NOW - DAY }, 'Misfit').text).toBe('Placeholder 7 · Misfit 77 · opens in 29 d');
  });
});
