import { authorizeRevealTestTarget } from './reveal-test-seam.test-support';
// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { shLimit } from '../../../../../../vitest.timeouts.mjs';
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { decodeFunctionData } from 'viem';
import { multicall3Abi } from '../../../../../../packages/chain/src/core/v2/reveal-batch-calls-v2';
import { boxCollectionAbi } from '@squarehole/chain/abi';
import { prepareRevealItems, runRevealItems, reconcileRevealItems, releaseUnknownRevealIntent } from './reveal-items';
import { activeRevealIntents, journalWork, readRevealProgress, revealProgressKey, saveRevealIntent } from './reveal-items-store';
import { indexedDBRevealStore } from './reveal-indexeddb';
import { digest, must, runFixture } from './reveal-items.test-support';

it.each(['after-inclusion', 'wallet-gap'] as const)('af2 R2-M1 blocks overlapping retry through a two-block reorg: %s', async moment => {
  const f = runFixture(41); let removed = false, overlap = false;
  f.ports.chain.snapshot = async (_identity, tag) => ({ ...f.snapshot, block: tag === 'finalized'
    ? { number: 99n, hash: digest(99) } : { number: removed ? 103n : 101n, hash: digest(removed ? 103 : 101) } });
  f.ports.chain.revealed = async (_c, ids, b) => ids.map(id => b.number > 99n && f.latest.has(id));
  f.ports.chain.canonical = async b => !(removed && [digest(100), digest(101)].includes(b.hash));
  const receipt = f.ports.chain.receipt;
  f.ports.chain.receipt = async hash => removed && hash === digest(1) ? null : receipt(hash);
  f.onSend = async (ids, hash) => {
    if (hash === digest(1)) for (const id of ids) { if (id !== 1n) f.latest.add(id); }
    else { if (ids.includes(1n)) overlap = true; for (const id of ids) f.latest.add(id); }
  };
  const simulate = f.ports.simulate;
  f.ports.simulate = async (...args) => {
    const calls = decodeFunctionData({ abi: multicall3Abi, data: args[0].data }).args[0];
    const ids = calls.map(c => { const d = decodeFunctionData({ abi: boxCollectionAbi, data: c.callData }); return d.functionName === 'reveal' ? d.args[0] : 0n; });
    if (moment === 'wallet-gap' && f.sends.length && ids.includes(1n)) { removed = true; f.latest.clear(); }
    return simulate(...args);
  };
  f.ports.sleep = async () => { removed = true; f.latest.clear(); };
  const plan = await f.plan(); const result = await runRevealItems(plan, f.ports, f.controller.signal);
  expect(overlap).toBe(false); expect(f.sends.filter(s => s.ids.includes(1n))).toHaveLength(1);
  expect(f.sends.some(s => s.ids.includes(41n))).toBe(true);
  expect(result.ok && result.value.reason).not.toBe('complete');
});

it('af2 R2-M1 adds zero finality waits when all inner calls succeed', async () => {
  const f = runFixture(41); f.onSend = async ids => { ids.forEach(id => f.latest.add(id)); };
  f.ports.chain.snapshot = async (_identity, tag) => ({ ...f.snapshot, block: tag === 'finalized' ? { number: 99n, hash: digest(99) } : { number: 101n, hash: digest(101) } });
  f.ports.chain.revealed = async (_c, ids, b) => ids.map(id => b.number > 99n && f.latest.has(id));
  const sleep = vi.spyOn(f.ports, 'sleep');
  expect((await runRevealItems(await f.plan(), f.ports, f.controller.signal)).ok).toBe(true);
  expect(f.sends).toHaveLength(2); expect(sleep).not.toHaveBeenCalled();
});

it.each(['finalized', 'reverted'] as const)('af2 R2-L1 reopens legacy terminal %s without evidence', async status => {
  const f = runFixture(1), source = await f.source(), key = revealProgressKey(f.identity.chainId, f.identity.token);
  f.saved.set(key, JSON.stringify({ version: 1, specHash: f.identity.specHash, intents: [{ attempt: 'old', ids: ['1'], account: f.identity.creator,
    createdAt: 0, capWei: '100', hash: digest(1), status, ...(status === 'reverted' ? { succeeded: [] } : {}) }] }));
  expect(await prepareRevealItems(source, f.ports)).toEqual({ ok: false, reason: 'receipt-pending' });
  expect(activeRevealIntents(await readRevealProgress(f.ports.store, key, f.identity.specHash))).toHaveLength(1);
});

it('af2 R2-L2 discovers an outside reveal after a new finalized head without reload', async () => {
  const f = runFixture(1), source = await f.source();
  expect((await reconcileRevealItems(source, f.ports))).toMatchObject({ ok: true, value: { finalized: 0n } });
  f.finalized.add(1n); f.latest.add(1n);
  f.ports.chain.snapshot = async (_i, tag) => ({ ...f.snapshot, block: { number: tag === 'finalized' ? 102n : 103n, hash: digest(tag === 'finalized' ? 102 : 103) } });
  expect(await reconcileRevealItems(source, f.ports)).toMatchObject({ ok: true, value: { finalized: 1n, latest: 1n } });
});

it.each(['nan', 'unsafe', 'backward', 'forward'] as const)('af2 R2-L4 refuses release on %s clock readings', async kind => {
  const f = runFixture(1), source = await f.source(), key = revealProgressKey(f.identity.chainId, f.identity.token);
  const p = await readRevealProgress(f.ports.store, key, f.identity.specHash);
  await saveRevealIntent(f.ports.store, key, p, { attempt: 'old', ids: ['1'], account: f.identity.creator, createdAt: 0, capWei: '100', status: 'unknown',
    clock: { wall: 60_000, tick: 60_000, epoch: 'test', elapsed: 60_000 } });
  const wall = kind === 'nan' ? NaN : kind === 'unsafe' ? Infinity : kind === 'backward' ? 0 : 1_860_000;
  f.ports.now = () => wall;
  Object.assign(f.ports, { clock: () => ({ wall, tick: 61_000, epoch: 'test' }) });
  expect(await releaseUnknownRevealIntent(source, 'old', f.ports)).toMatchObject({ ok: false });
  expect(must((await readRevealProgress(f.ports.store, key, f.identity.specHash)).intents[0]).status).toBe('unknown');
});

it('af2 R2-L3 writes linear bytes and scans only changed work for 10000 items', async () => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  const f = runFixture(10_000); let final = 99n;
  f.ports.chain.snapshot = async (_identity, tag) => ({ ...f.snapshot, block: { number: tag === 'finalized' ? final : 101n, hash: digest(tag === 'finalized' ? (final === 99n ? 99 : 100) : 101) } });
  f.onSend = async ids => { ids.forEach(id => f.latest.add(id)); };
  Object.assign(f.ports, { store: authorizeRevealTestTarget(indexedDBRevealStore(new IDBFactory(), 'af2-linear')) });
  let bytes = 0, records = 0;
  const put = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    bytes += new TextEncoder().encode(JSON.stringify(value)).length;
    if (this.name === 'attempts') records++;
    return put.call(this, value, key);
  });
  journalWork.scanned = 0; journalWork.serialized = 0; journalWork.bytes = 0;
  try {
    const source = await f.source(), planned = await prepareRevealItems(source, f.ports); if (!planned.ok) throw new Error(planned.reason);
    const result = await runRevealItems(planned.value, f.ports, f.controller.signal);
    expect(result).toMatchObject({ ok: true, value: { reason: 'awaiting-finality' } });
    expect(records).toBe(750); expect(bytes).toBeLessThan(1_100_000);
    expect(journalWork.scanned).toBeLessThanOrEqual(2000); expect(journalWork.serialized).toBe(750);
    const before = { bytes, scanned: journalWork.scanned, serialized: journalWork.serialized };
    for (let i = 0; i < 3; i++) await reconcileRevealItems(source, f.ports);
    expect({ bytes, scanned: journalWork.scanned, serialized: journalWork.serialized }).toEqual(before);
    final = 100n; f.latest.forEach(id => f.finalized.add(id));
    expect(await reconcileRevealItems(source, f.ports)).toMatchObject({ ok: true, value: { finalizedComplete: true } });
    expect(records).toBe(1000); expect(bytes).toBeLessThan(1_600_000);
    expect(journalWork.scanned).toBeLessThanOrEqual(2750); expect(journalWork.serialized).toBe(1000);
    console.warn('af2 journal metrics', { records, bytes, scanned: journalWork.scanned, serialized: journalWork.serialized });
  } finally { spy.mockRestore(); vi.unstubAllGlobals(); }
}, shLimit(360_000));

it('af2 R2-L1 reopens terminal evidence above the current finalized head', async () => {
  const f = runFixture(1), source = await f.source(), key = revealProgressKey(f.identity.chainId, f.identity.token);
  const p = await readRevealProgress(f.ports.store, key, f.identity.specHash);
  await saveRevealIntent(f.ports.store, key, p, { attempt: 'old', ids: ['1'], account: f.identity.creator, createdAt: 0, capWei: '100',
    hash: digest(1), status: 'reverted', succeeded: [], receiptStatus: 'reverted', block: { number: '100', hash: digest(100) } });
  f.ports.chain.snapshot = async (_i, tag) => ({ ...f.snapshot, block: tag === 'finalized' ? { number: 99n, hash: digest(99) } : { number: 101n, hash: digest(101) } });
  expect(await prepareRevealItems(source, f.ports)).toEqual({ ok: false, reason: 'receipt-pending' });
});

vi.mock('./reveal-test-seam', async () => import('./reveal-test-seam.test-support'));
