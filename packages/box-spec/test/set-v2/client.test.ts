import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { zeroHash, type Hex } from 'viem';
import {
  SET_LOAD_BATCH, SET_RETURN_BATCH, SET_PICK_BATCH, SET_RELEASE_BATCH, SET_MAX_PAGE,
  smallerBatch, buildSetCommitment, quoteSetPick, quoteSetReturn, maxIn, minOut, deadlineFrom, SetQuoteError,
  createSetListFile, parseSetListFile, setLinkHash,
} from '../../src/set-v2/index';
import vectors from '../../../contracts/test/box-v2/existing-nfts/fixtures/pricing-vectors.json';

const collection = '0x1111111111111111111111111111111111111111' as const;
const other = '0x2222222222222222222222222222222222222222' as const;
const max = (1n << 256n) - 1n;
const snapshot = { supply: 100003n, escrow: 0n, inside: 33n, count: 33n };

describe('E08A-QUOTE / SET-04 / SET-09', () => {
  it.each(vectors.traces)('replays every pricing-vector row for preset $preset', (trace) => {
    let supply = BigInt(trace.initialSupply), escrow = 0n, inside = BigInt(trace.count);
    for (const row of trace.rows) {
      const [returning, k, principal, fee, success, burn, nextS, nextE, nextN] = row.map(BigInt);
      if (k === undefined || principal === undefined || fee === undefined || burn === undefined) throw new Error('fixture');
      const state = { supply, escrow, inside, count: BigInt(trace.count) };
      const quote = () => returning === 1n ? quoteSetReturn(state, k) : quoteSetPick(state, k, BigInt(trace.preset));
      if (success === 1n) {
        expect(quote()).toEqual({ principal, fee, ...(returning === 1n ? { tokenOut: principal - fee } : { tokenIn: principal + fee }) });
        supply -= fee;
        escrow += returning === 1n ? -principal : principal;
        inside += returning === 1n ? k : -k;
      } else expect(quote).toThrow(/supply floor/);
      supply -= burn;
      expect([supply, escrow, inside]).toEqual([nextS, nextE, nextN]);
    }
  });
  it.each(vectors.wide)('full-width pick vector %s / %s * %s', (s, n, k, p) => {
    if (s === undefined || n === undefined || k === undefined || p === undefined) throw new Error('fixture');
    const principal = BigInt(p);
    const fee = (principal * 100n + 9999n) / 10000n;
    expect(quoteSetPick({ supply: BigInt(s), escrow: 0n, inside: BigInt(n), count: BigInt(n) }, BigInt(k), 100n))
      .toEqual({ principal, fee, tokenIn: principal + fee });
  });
  it('full-width return multiplies before dividing without uint256 intermediate truncation', () => {
    const escrow = max / 2n, a = max - escrow, principal = a * 3n / 7n;
    const fee = (principal * 500n + 9999n) / 10000n;
    expect(quoteSetReturn({ supply: max, escrow, inside: 7n, count: 10n }, 3n)).toEqual({ principal, fee, tokenOut: principal - fee });
  });
  it('refuses zero, last item, excess quantity, unit floor, insolvency and both fee floors', () => {
    for (const k of [0n, 33n, 34n]) expect(() => quoteSetPick(snapshot, k, 100n)).toThrow();
    for (const k of [0n, 2n]) expect(() => quoteSetReturn({ ...snapshot, inside: 32n }, k)).toThrow(/quantity/);
    expect(() => quoteSetReturn({ supply: 15n, escrow: 10n, inside: 9n, count: 10n }, 1n)).toThrow(/below unit/);
    expect(() => quoteSetReturn({ supply: 1000n, escrow: 1n, inside: 9n, count: 10n }, 1n)).toThrow(/escrow/);
    expect(() => quoteSetPick({ supply: 10n, escrow: 0n, inside: 10n, count: 10n }, 1n, 100n)).toThrow(/supply floor/);
    expect(() => quoteSetReturn({ supply: 10n, escrow: 1n, inside: 9n, count: 10n }, 1n)).toThrow(/supply floor/);
    expect(quoteSetReturn({ supply: 12n, escrow: 2n, inside: 9n, count: 10n }, 1n)).toEqual({ principal: 1n, fee: 1n, tokenOut: 0n });
  });
  it('refuses a pick of every item left (last item) and more than are left (quantity) within the 32-item cap', () => {
    const reasonOf = (state: typeof snapshot, k: bigint): string | undefined => {
      try { quoteSetPick(state, k, 100n); return undefined; } catch (error) { return (error as SetQuoteError).reason; }
    };
    const full = { supply: 100003n, escrow: 0n, inside: 10n, count: 10n };
    expect(reasonOf(full, 10n)).toBe('last item');
    expect(reasonOf(full, 11n)).toBe('quantity');
    expect(reasonOf(full, 9n)).toBeUndefined();
    const half = { supply: 100003n, escrow: 50000n, inside: 5n, count: 10n };
    expect(reasonOf(half, 5n)).toBe('last item');
    expect(reasonOf(half, 6n)).toBe('quantity');
    expect(reasonOf(half, 4n)).toBeUndefined();
  });
  it('refuses invalid state, fee presets, widths and batches beyond the protocol cap', () => {
    for (const supply of [-1n, max + 1n, 1 as unknown as bigint]) expect(() => quoteSetPick({ ...snapshot, supply }, 1n, 100n)).toThrow();
    for (const state of [{ ...snapshot, escrow: snapshot.supply + 1n }, { ...snapshot, inside: 0n }, { ...snapshot, inside: 34n }, { ...snapshot, count: 10001n }]) {
      expect(() => quoteSetPick(state, 1n, 100n)).toThrow();
    }
    for (const fee of [0n, 101n, 10000n]) expect(() => quoteSetPick(snapshot, 1n, fee)).toThrow(/preset/);
    expect(() => quoteSetReturn({ supply: 10000n, escrow: 9000n, inside: 10n, count: 100n }, 33n)).toThrow(/quantity/);
    expect(() => quoteSetPick({ ...snapshot, inside: 100n, count: 100n }, 33n, 100n)).toThrow(/quantity/);
  });
  it('rounds slippage outwards and adds explicit seconds without a wall clock', () => {
    expect(maxIn(101n, 100n)).toBe(103n);
    expect(minOut(101n, 100n)).toBe(99n);
    expect(maxIn(max, 0n)).toBe(max);
    expect(minOut(max, 10000n)).toBe(0n);
    expect(deadlineFrom(1792800000n, 300n)).toBe(1792800300n);
    for (const bps of [-1n, 10001n]) {
      expect(() => maxIn(1n, bps)).toThrow();
      expect(() => minOut(1n, bps)).toThrow();
    }
    expect(() => maxIn(max, 1n)).toThrow();
    expect(() => minOut(-1n, 1n)).toThrow();
    for (const seconds of [0n, -1n, max]) expect(() => deadlineFrom(1n, seconds)).toThrow();
  });
});

it('E08A-BATCH keeps protocol pages at 32 and transaction sizes independently bounded', () => {
  expect([SET_LOAD_BATCH, SET_RETURN_BATCH, SET_PICK_BATCH, SET_RELEASE_BATCH, SET_MAX_PAGE]).toEqual([16, 16, 32, 32, 32]);
  expect([32, 16, 8, 4, 2, 1, 3].map(smallerBatch)).toEqual([16, 8, 4, 2, 1, 1, 1]);
  for (const size of [0, -1, 33, 1.5, NaN, Infinity]) expect(() => smallerBatch(size)).toThrow();
  const ids = Array.from({ length: 33 }, (_, i) => BigInt(i));
  const normal = buildSetCommitment(collection, ids), tx = buildSetCommitment(collection, ids, SET_LOAD_BATCH);
  expect(normal.pages.map(p => p.ids.length)).toEqual([32, 1]);
  expect(tx.pages.map(p => p.ids.length)).toEqual([16, 16, 1]);
  expect(tx.commitment).toEqual(normal.commitment);
});

describe('E08A-LIST / SET-01 / SET-02', () => {
  it.each([10, 10000])('round-trips %s ordered ids including both uint256 endpoints', (count) => {
    const ids = Array.from({ length: count }, (_, i) => BigInt(i));
    ids[count - 1] = max;
    const file = createSetListFile(collection, ids);
    expect(file.schema).toBe('squarehole.set-list/1');
    expect(file.ids).toEqual(ids.map(String));
    const { commitment } = buildSetCommitment(collection, ids);
    expect(parseSetListFile(JSON.parse(JSON.stringify(file)), commitment)).toEqual({ commitment, ids });
  });
  it('refuses numeric ids, changed order/hash/collection/count, unknown fields and duplicates even rehashed', () => {
    const ids = Array.from({ length: 10 }, (_, i) => BigInt(i));
    const file = createSetListFile(collection, ids), expected = buildSetCommitment(collection, ids).commitment;
    for (const bad of [
      { ...file, ids: [0, ...file.ids.slice(1)] }, { ...file, ids: [...file.ids].reverse() },
      { ...file, ids: ['00', ...file.ids.slice(1)] }, { ...file, setHash: zeroHash },
      { ...file, collection: other }, { ...file, count: 11 }, { ...file, extra: true },
      { ...file, ids: [String(max + 1n), ...file.ids.slice(1)] },
    ]) expect(() => parseSetListFile(bad, expected)).toThrow();
    const changed = createSetListFile(other, ids);
    expect(() => parseSetListFile(changed, expected)).toThrow(/collection/);
    const reordered = createSetListFile(collection, [...ids].reverse());
    expect(() => parseSetListFile(reordered, expected)).toThrow(/hash/);
    expect(() => parseSetListFile(file, { ...expected, count: 11 })).toThrow(/count/);
    ids[1] = 0n;
    const setHash = [...ids].reverse().reduce<Hex>((hash, id) => setLinkHash(collection, id, hash), zeroHash);
    expect(() => parseSetListFile({ ...file, ids: ids.map(String), setHash }, { ...expected, setHash })).toThrow();
    expect(() => createSetListFile(collection, [0, ...ids.slice(1)] as unknown as bigint[])).toThrow();
  });
});

it('E08A-INTEGER source guard forbids lossy numeric parsing throughout the set source', () => {
  const dir = new URL('../../src/set-v2/', import.meta.url);
  for (const name of readdirSync(dir).filter(name => name.endsWith('.ts'))) {
    expect(readFileSync(new URL(name, dir), 'utf8'), name).not.toMatch(/\bNumber\s*\(|\bparseFloat\b|\bparseInt\b/);
  }
});
