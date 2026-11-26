// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { decodeFunctionData, toHex } from 'viem';
import { multicall3Abi } from '../../../../../../packages/chain/src/core/v2/reveal-batch-calls-v2';
import { boxCollectionAbi } from '@squarehole/chain/abi';
import { checkRevealSnapshot, prepareRevealItems, releaseUnknownRevealIntent, runRevealItems } from './reveal-items';
import { readRevealProgress, revealProgressKey, saveRevealIntent } from './reveal-items-store';
import { digest, must, runFixture, runPresses, traceRevealSends } from './reveal-items.test-support';
import { indexedDBRevealStore } from './reveal-indexeddb';
import { IDBFactory } from 'fake-indexeddb';
import { revealAssets } from './reveal-assets';
import { openHiddenReveal, prepareHiddenReveal, releaseUnknownHiddenOpening } from './reveal-hidden';

it('af3 R3-M1 the timer release prepare run chain fails at its first step with retained ports', async () => {
  const f = runFixture(1), source = await f.source(), key = revealProgressKey(f.identity.chainId, f.identity.token);
  const p = await readRevealProgress(f.ports.store, key, f.identity.specHash);
  await saveRevealIntent(f.ports.store, key, p, { attempt: 'old', ids: ['1'], account: f.identity.creator, createdAt: 0,
    capWei: '100', status: 'unknown', clock: { wall: 0, tick: 0, epoch: 'test', elapsed: 0 } });
  f.time = 1_800_000;
  // Same real executor, wallet, clock, storage and lock ports; no session-issued authority.
  const retained = { ...f.ports }, put = vi.spyOn(f.ports.store, 'put'), wallet = vi.spyOn(retained, 'wallet');
  const chain = async () => {
    await releaseUnknownRevealIntent(source, 'old', retained);
    const prepared = await prepareRevealItems(source, retained);
    if (prepared.ok) await runRevealItems(prepared.value, retained, f.controller.signal);
  };
  await expect(new Promise<void>((resolve, reject) => { setTimeout(() => { void chain().then(resolve, reject); }, 0); }))
    .rejects.toThrow('session-authority-required');
  expect(put).not.toHaveBeenCalled(); expect(wallet).not.toHaveBeenCalled(); expect(f.sends).toHaveLength(0);
});

it('af3 R3-M1 raw journal writers uploader and hidden engines refuse forged authority before using ports', async () => {
  const store = indexedDBRevealStore(new IDBFactory(), 'af3-no-authority');
  await expect(store.put('key', '{}')).rejects.toThrow('session-authority-required');
  await expect(must(store.records).commit('key', 0, { revision: 1, specHash: digest(1), count: 0, bytes: 0 }, []))
    .rejects.toThrow('session-authority-required');
  await expect(saveRevealIntent(store, 'key', { version: 1, specHash: digest(1), intents: [] }, {} as never))
    .rejects.toThrow('session-authority-required');
  await expect(revealAssets({} as never, {} as never, new AbortController().signal)).rejects.toThrow('session-authority-required');
  await expect(releaseUnknownHiddenOpening({} as never, 'old', {} as never)).rejects.toThrow('session-authority-required');
  await expect(prepareHiddenReveal({} as never, 1n, '0x0', {} as never, {} as never, {} as never, {} as never)).rejects.toThrow('session-authority-required');
  await expect(openHiddenReveal({} as never, new AbortController().signal)).rejects.toThrow('session-authority-required');
});

it.each(['lost-outside-item', 'outside-completes-retry', 'recovery-exceeds-plan'] as const)('af3 R3-M2 af5 M1 reorg sends follow the read chain answer and retain wait holes: %s', async kind => {
  const f = runFixture(kind === 'recovery-exceeds-plan' ? 81 : 41); let polls = 0, final = 99n, tip = 99n, reorg = false;
  const block = (number: bigint) => ({ number, hash: toHex(number + (reorg && number > 100n ? 1000n : 0n), { size: 32 }) });
  f.ports.chain.snapshot = async (_identity, tag) => ({ ...f.snapshot, block: block(tag === 'finalized' ? final : tip) });
  f.ports.chain.canonical = async b => !(reorg && b.hash === digest(102));
  f.ports.chain.revealed = async (_c, ids, b) => ids.map(id => (b.number <= final ? f.finalized : f.latest).has(id));
  f.onSend = async (ids, hash) => {
    if (hash === digest(1)) {
      tip = 102n; // A at 100, outside reveals at 101, then inclusion plus one.
      ids.filter(id => id !== 1n).forEach(id => f.latest.add(id));
      for (let id = 41n; id <= f.snapshot.size; id++) f.latest.add(id); // Outside inclusion at 101; disjoint batches are skipped.
    } else {
      final = tip + 1n; tip = final + 1n;
      ids.forEach(id => f.latest.add(id)); f.latest.forEach(id => f.finalized.add(id));
      f.receipts.set(hash, { ...must(f.receipts.get(hash)), block: block(final) });
    }
  };
  f.ports.sleep = async () => {
    polls++;
    if (polls === 1) { reorg = true; tip = 103n; for (let id = 41n; id <= f.snapshot.size; id++) f.latest.delete(id); }
    if (polls === 2) {
      final = 100n; for (const id of f.latest) f.finalized.add(id);
      if (kind === 'outside-completes-retry') { tip = 105n; final = 104n; f.latest.add(1n); f.finalized.add(1n); }
    }
  };
  const simulate = f.ports.simulate;
  let staleSimulations = 0;
  f.ports.simulate = async (...args) => {
    const calls = decodeFunctionData({ abi: multicall3Abi, data: args[0].data }).args[0];
    if (polls >= 2 && calls.some(c => {
      const decoded = decodeFunctionData({ abi: boxCollectionAbi, data: c.callData });
      return decoded.functionName === 'reveal' && f.latest.has(decoded.args[0]);
    })) { staleSimulations++; throw new Error('AlreadyRevealed'); }
    return simulate(...args);
  };
  const predecessors = traceRevealSends(f.ports);
  const plan = await f.plan();
  if (kind === 'recovery-exceeds-plan') {
    const result = await runRevealItems(plan, f.ports, f.controller.signal);
    expect(predecessors).toEqual(f.sends.map(() => `read:chainId:${f.identity.chainId}`));
    expect(polls).toBe(2); expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.reason);
    expect(staleSimulations).toBe(0);
    expect(result.value.reason).toBe('plan-changed'); expect(f.sends).toHaveLength(1); return;
  }
  // SH-203 af5 (R4-L3a): a press sends at most the transactions it showed; the hole that needs one more goes on the next.
  const { presses, last } = await runPresses(f, plan);
  expect(presses.every(p => p.sent <= p.shown)).toBe(true);
  expect(predecessors).toEqual(f.sends.map(() => `read:chainId:${f.identity.chainId}`));
  expect(polls).toBe(2);
  expect(staleSimulations).toBe(0);
  const result = { value: last };
  expect(result.value.reason).toBe('complete'); expect(f.latest.has(41n)).toBe(true);
  expect(f.sends.filter(s => s.ids.includes(1n))).toHaveLength(kind === 'outside-completes-retry' ? 1 : 2);
  expect(must(f.sends.at(-1)).ids).toEqual([41n]);
});

vi.mock('./reveal-test-seam', async () => import('./reveal-test-seam.test-support'));

vi.mock('../../../../../../packages/box-spec/src/generated/box-spec.v2', { spy: true });
import { decodeBoxSpecV2 } from '../../../../../../packages/box-spec/src/generated/box-spec.v2';
it('af3 model work validates identical spec bytes once across 1000 receipt polls', () => {
  const f = runFixture(7); vi.mocked(decodeBoxSpecV2).mockClear();
  for (let poll = 0; poll < 1000; poll++) checkRevealSnapshot(f.identity, f.snapshot, f.identity.creator, 1);
  expect(decodeBoxSpecV2).toHaveBeenCalledTimes(1);
  expect(() => checkRevealSnapshot(f.identity, { ...f.snapshot, encodedSpec: '0x00' }, f.identity.creator, 1)).toThrow();
});
