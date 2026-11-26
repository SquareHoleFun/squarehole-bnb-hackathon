/**
 * FE1: the one claim-state rule for holder payouts (holder-claims.ts). Each case below is one of the three
 * cross-review findings on M2-53 (a, b, c) or the rule's own boundaries: block numbers decide, never snapshot hashes.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import type { HolderClaimV2 } from './actions-v2';
import { MAX_BATCHES_READ, batchPages, batchState, batchesToRead, claimInOrder, claimableNow, holderCandidates, withClaim, withRead, type HolderSession } from './holder-claims';
import type { M2ViewV2 } from '../../../../../../packages/indexer/src/core/v2/m2-views-v2';
import { NOTHING_LEFT_BATCH } from './claims-index';

const A = '0x00000000000000000000000000000000000000a1' as Address;
const B = '0x00000000000000000000000000000000000000b2' as Address;
const H = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const;
const credit = (claimableP: bigint | null, patch: Partial<HolderClaimV2> = {}): HolderClaimV2 => ({
  hash: H(1), batchId: 1n, holder: A, status: 'settled', hookClosed: true, fundingFinal: true, fundingP: 100n, complete: true,
  holderCursor: 3n, noticeCursor: 0n, residueP: 0n, claimableP, failedBox: false, payout: claimableP ? 'available' : 'empty', ...patch,
});
const claim = { tx: H(80), block: 110n, paidP: 60n };
const state = (session: HolderSession, batch = 1n) => batchState(session[batch.toString()]);
const read = (session: HolderSession, block: bigint, amount: bigint | null, patch: Partial<HolderClaimV2> = {}) =>
  withRead(session, 1n, { block, credit: credit(amount, patch) });

describe('FE1 claim-state rule', () => {
  it('before any claim, a settled credit with an available payout is ready, with its own Claim button', () => {
    const s = read({}, 100n, 60n);
    expect(state(s)).toEqual({ kind: 'ready', amount: 60n });
    expect(claimableNow(state(s))).toBe(60n);
  });

  it('(a) mined at block R while the feed still serves an older block: Claimed only, no Claim button', () => {
    const s = withClaim(read({}, 100n, 60n), 1n, claim);
    expect(state(s)).toEqual({ kind: 'claimed', amount: 60n, checked: false });
    expect(claimableNow(state(s))).toBeNull();
    // Another read of an older block, still showing the old credit, changes nothing.
    expect(state(read(s, 109n, 60n))).toEqual({ kind: 'claimed', amount: 60n, checked: false });
  });

  it('a read at block R or later that shows the credit gone confirms the claim', () => {
    const s = withClaim(read({}, 100n, 60n), 1n, claim);
    expect(state(read(s, 110n, 0n))).toEqual({ kind: 'claimed', amount: 60n, checked: true });
    expect(state(read(s, 125n, 0n))).toEqual({ kind: 'claimed', amount: 60n, checked: true });
  });

  it('a read at block R or later that still shows the credit means reorged out: unpaid amount and Claim again', () => {
    const s = read(withClaim(read({}, 100n, 60n), 1n, claim), 110n, 60n);
    expect(state(s)).toEqual({ kind: 'unconfirmed', amount: 60n, ready: true });
    expect(claimableNow(state(s))).toBe(60n);
  });

  it('(b) after a proven reorg, a failed read leaves the decision alone (nothing is written)', () => {
    const decided = read(withClaim(read({}, 100n, 60n), 1n, claim), 112n, 60n);
    // A failed read writes nothing: the panel only shows a retry chip, so the state is the decided one.
    expect(state(decided)).toEqual({ kind: 'unconfirmed', amount: 60n, ready: true });
  });

  it('(c) overlapping checks: an older read arriving late can neither confirm a proven reorg nor undo a confirmation', () => {
    const claimed = withClaim(read({}, 100n, 60n), 1n, claim);
    const reorged = read(claimed, 115n, 60n);
    expect(state(read(reorged, 111n, 0n))).toEqual({ kind: 'unconfirmed', amount: 60n, ready: true });
    const confirmed = read(claimed, 115n, 0n);
    expect(state(read(confirmed, 111n, 60n))).toEqual({ kind: 'claimed', amount: 60n, checked: true });
  });

  it('a newer read can still change the decision (the claim re-included after the reorg)', () => {
    const reorged = read(withClaim(read({}, 100n, 60n), 1n, claim), 112n, 60n);
    expect(state(read(reorged, 113n, 0n))).toEqual({ kind: 'claimed', amount: 60n, checked: true });
  });

  it('claiming again after a reorg starts over from the new receipt block', () => {
    const reorged = read(withClaim(read({}, 100n, 60n), 1n, claim), 112n, 60n);
    const again = withClaim(reorged, 1n, { tx: H(81), block: 118n, paidP: 60n });
    expect(state(again)).toEqual({ kind: 'claimed', amount: 60n, checked: false });
    expect(state(read(again, 118n, 0n))).toEqual({ kind: 'claimed', amount: 60n, checked: true });
  });

  it('a reorged-out claim whose payout is now refused shows the amount but no Claim button', () => {
    const s = read(withClaim(read({}, 100n, 60n), 1n, claim), 112n, 60n, { payout: 'unavailable' });
    expect(state(s)).toEqual({ kind: 'unconfirmed', amount: 60n, ready: false });
    expect(claimableNow(state(s))).toBeNull();
  });

  it('only block numbers are compared: a read at the same block replaces the stored one whatever its hash', () => {
    const s = read({}, 100n, 60n, { payout: 'unavailable' });
    expect(state(s).kind).toBe('paused');
    expect(state(read(s, 100n, 60n, { hash: H(2) }))).toEqual({ kind: 'ready', amount: 60n });
  });

  it.each([
    ['open', 'not_ready', null, 'open'], ['awaiting_funding', 'not_ready', null, 'funding'], ['settling', 'not_ready', null, 'calculating'],
    ['settled', 'empty', 0n, 'none'], ['settled', 'unavailable', 60n, 'paused'], ['settled', 'unverified', 60n, 'unchecked'],
  ] as const)('%s / %s reads as %s, with no Claim button', (status, payout, amount, kind) => {
    const s = read({}, 100n, amount, { status, payout });
    expect(state(s).kind).toBe(kind);
    expect(claimableNow(state(s))).toBeNull();
  });

  it('nothing read yet is unknown, not zero', () => {
    expect(state({})).toEqual({ kind: 'unknown' });
  });
});

describe('FE1 batches to read', () => {
  const batch = (patch: Partial<M2ViewV2['batches'][string]> = {}) => ({ fundingP: 100n, complete: true, holderP: 80n, residueP: 20n, paidP: 0n, tipsP: 0n, flushedP: 0n, payments: {}, ...patch });
  const history = (batches: M2ViewV2['batches']): M2ViewV2 => ({ failed: false, batches, shop: null, starter: null });

  it('reads recorded batches oldest first, skipping fully paid ones and ones already paid to this wallet', () => {
    const h = history({ '3': batch(), '1': batch(), '2': batch({ paidP: 80n }), '4': batch({ paidP: 10n, payments: { [A]: { to: A, grossP: 10n, tipP: 0n, receivedP: 10n } } }), '5': batch({ complete: false, holderP: null }) });
    expect(batchesToRead(h, A, {}, null)).toEqual([1n, 3n, 5n]);
    expect(batchesToRead(h, B, {}, null)).toEqual([1n, 3n, 4n, 5n]);
  });

  it('keeps every batch this session claimed (it still needs its deciding read) and one typed batch', () => {
    const h = history({ '4': batch({ paidP: 80n, payments: { [A]: { to: A, grossP: 80n, tipP: 0n, receivedP: 80n } } }) });
    const session = withClaim({}, 4n, claim);
    expect(batchesToRead(h, A, session, 9n)).toEqual([4n, 9n]);
    expect(batchesToRead(null, A, {}, 7n)).toEqual([7n]);
    expect(batchesToRead(undefined, A, {}, null)).toEqual([]);
  });

  it(`reads at most the ${MAX_BATCHES_READ} newest batches`, () => {
    const h = history(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [String(i + 1), batch()])));
    const read = batchesToRead(h, A, {}, null);
    expect(read).toHaveLength(MAX_BATCHES_READ);
    expect(read[0]).toBe(9n); expect(read.at(-1)).toBe(20n);
  });
});

// SH-V2-M2-63 OC-01 (joint M2 review, medium): an explicitly selected batch and every receipt still waiting for its
// deciding read always get a read, whatever the backlog; the rest is paged, never dropped.
describe('OC-01 every selected batch and pending receipt gets a read', () => {
  const unpaid = { fundingP: 1n, complete: true, holderP: 1n, residueP: 0n, paidP: 0n, tipsP: 0n, flushedP: 0n, payments: {} };
  const backlog = (n: number): M2ViewV2 => ({ failed: false, shop: null, starter: null, batches: Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i + 1), unpaid])) });
  const pending = (...ids: bigint[]): HolderSession => ids.reduce<HolderSession>((s, id) => withClaim(s, id, { tx: H(Number(id)), block: 100n, paidP: 1n }), {});
  const allPages = (h: M2ViewV2, s: HolderSession, extra: bigint | null) =>
    Array.from({ length: batchPages(h, A, s, extra) }, (_, page) => batchesToRead(h, A, s, extra, page));

  it('thirteen unpaid batches: the batch typed in Details (the oldest) is read, within the bound', () => {
    const read = batchesToRead(backlog(13), A, {}, 1n);
    expect(read).toContain(1n);
    expect(read).toHaveLength(MAX_BATCHES_READ);
  });

  it('thirteen unpaid batches: an old claim still waiting for its deciding read is read', () => {
    const read = batchesToRead(backlog(13), A, pending(1n), null);
    expect(read).toContain(1n);
    expect(read.length).toBeLessThanOrEqual(MAX_BATCHES_READ);
  });

  it('the typed batch and a pending receipt both keep their reads against twenty newer batches', () => {
    const read = batchesToRead(backlog(20), A, pending(2n), 1n);
    expect(read).toContain(1n); expect(read).toContain(2n);
    expect(read).toHaveLength(MAX_BATCHES_READ);
  });

  it('the rest is paged: thirteen unpaid batches take two pages that together read every one, each within the bound', () => {
    const pages = allPages(backlog(13), {}, null);
    expect(pages).toHaveLength(2);
    for (const page of pages) expect(page.length).toBeLessThanOrEqual(MAX_BATCHES_READ);
    expect([...new Set(pages.flat())].sort((a, b) => Number(a - b))).toEqual(Array.from({ length: 13 }, (_, i) => BigInt(i + 1)));
    // Pages wrap around, and the typed batch is on every page.
    expect(batchesToRead(backlog(13), A, {}, null, 2)).toEqual(pages[0]);
    for (const page of allPages(backlog(13), {}, 1n)) expect(page).toContain(1n);
  });

  it('pending receipts alone above the bound are paged fairly; the typed batch stays on every page', () => {
    const ids = Array.from({ length: 15 }, (_, i) => BigInt(i + 1));
    const pages = allPages(backlog(15), pending(...ids), 20n);
    expect(pages.length).toBe(2);
    for (const page of pages) { expect(page.length).toBeLessThanOrEqual(MAX_BATCHES_READ); expect(page).toContain(20n); }
    expect([...new Set(pages.flat())].filter((id) => id !== 20n).sort((a, b) => Number(a - b))).toEqual(ids);
  });

  it('a claim already decided (credit gone at or after its receipt block) frees its slot for the backlog', () => {
    const decided = withRead(pending(13n), 13n, { block: 100n, credit: credit(0n, { batchId: 13n }) });
    expect(batchState(decided['13'])).toEqual({ kind: 'claimed', amount: 1n, checked: true });
    const read = batchesToRead(backlog(13), A, decided, null);
    expect(read).not.toContain(13n);
    expect(read).toEqual(Array.from({ length: 12 }, (_, i) => BigInt(i + 1)));
    // It stays a candidate, so its row can still say Claimed.
    expect(holderCandidates(backlog(13), A, decided, null)).toContain(13n);
  });
});

// FE12 review M-1: a batch paid in the box token gets a new tranche of credit after a claim, so a decided claim of it
// must not drop it from the read plan (the holder panel and Claim all's scan read only this plan).
describe('FE12 a batch paid in the box token stays in the read plan after its claim is decided', () => {
  const tBatch = (holderP: bigint, paidP: bigint) => ({ fundingP: holderP, complete: true, holderP, residueP: 0n, paidP, tipsP: 0n, flushedP: 0n, payments: {} });
  const unpaid = { fundingP: 1n, complete: true, holderP: 1n, residueP: 0n, paidP: 0n, tipsP: 0n, flushedP: 0n, payments: {} };
  const one = (holderP: bigint, paidP: bigint): M2ViewV2 => ({ failed: false, shop: null, starter: null, batches: { '2': tBatch(holderP, paidP) } });
  const grows = (batch: bigint) => batch === 2n;
  const claimed = withClaim({}, 2n, { tx: H(2), block: 110n, paidP: 38n });

  it('claimed and decided, it is still read; a later tranche shows as ready again', () => {
    const decided = withRead(claimed, 2n, { block: 110n, credit: { ...credit(0n, { batchId: 2n }), grows: true } });
    expect(batchState(decided['2'])).toEqual({ kind: 'claimed', amount: 38n, checked: true });
    // Paid in P, a decided claim leaves the plan; paid in T it stays, whether the history shows it paid or grown.
    expect(batchesToRead(one(38n, 38n), A, decided, null)).toEqual([]);
    expect(batchesToRead(one(38n, 38n), A, decided, null, 0, grows)).toEqual([2n]);
    expect(batchesToRead(one(60n, 38n), A, decided, null, 0, grows)).toEqual([2n]);
    const grown = withRead(decided, 2n, { block: 130n, credit: { ...credit(22n, { batchId: 2n }), grows: true } });
    expect(batchState(grown['2'])).toEqual({ kind: 'ready', amount: 22n });
    expect(claimableNow(batchState(grown['2']))).toBe(22n);
  });

  it('the claims index’s nothing-left read (no grows flag) decides it the same way, and it stays', () => {
    const indexed = withRead(claimed, 2n, { block: 110n, credit: NOTHING_LEFT_BATCH });
    expect(batchState(indexed['2'])).toEqual({ kind: 'claimed', amount: 38n, checked: true });
    expect(batchesToRead(one(38n, 38n), A, indexed, null, 0, grows)).toEqual([2n]);
    expect(holderCandidates(one(38n, 38n), A, indexed, null, grows)).toEqual([2n]);
  });

  it('after the open batches: it takes only a slot they leave, on the next page', () => {
    const h: M2ViewV2 = { failed: false, shop: null, starter: null, batches: { ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(i + 3), unpaid])), '2': tBatch(38n, 38n) } };
    const decided = withRead(claimed, 2n, { block: 110n, credit: { ...credit(0n, { batchId: 2n }), grows: true } });
    expect(batchPages(h, A, decided, null, grows)).toBe(2);
    expect(batchesToRead(h, A, decided, null, 0, grows)).toEqual(Array.from({ length: 12 }, (_, i) => BigInt(i + 3)));
    expect(batchesToRead(h, A, decided, null, 1, grows)).toEqual([2n]);
  });
});

describe('FE1 Claim all runs one claim at a time', () => {
  it('waits for each claim before starting the next, and reports all done', async () => {
    const order: string[] = [];
    const result = await claimInOrder([1n, 2n, 3n], async (batch) => {
      order.push(`start ${batch}`); await Promise.resolve(); order.push(`end ${batch}`);
    });
    expect(order).toEqual(['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3']);
    expect(result).toEqual({ done: 3, stoppedAt: null, error: null });
  });

  it('stops at the first claim that does not confirm; later ones are never started', async () => {
    const started: bigint[] = [];
    const result = await claimInOrder([1n, 2n, 3n], async (batch) => { started.push(batch); if (batch === 2n) throw new Error('rejected'); });
    expect(started).toEqual([1n, 2n]);
    expect(result).toMatchObject({ done: 1, stoppedAt: 2n, error: new Error('rejected') });
  });
});

describe('F127 claim-only sources', () => {
  // The generated holderLedgerV2Abi still lists claimFor until its regeneration (SH-V2-FE1 integrator request 2);
  // the site must never reach it, nor offer or explain pushed claims or claim tips.
  it('no v2 box or create source names claimFor, a pushed claim or a claim tip', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const dirs = [here, join(here, '../../create/v2')];
    const files = dirs.flatMap((dir) => readdirSync(dir).filter((name) => /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)).map((name) => join(dir, name)));
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) expect(readFileSync(file, 'utf8'), file).not.toMatch(/claimFor|claim tip|pushed (claim|payout)|payout push/i);
  });
});
