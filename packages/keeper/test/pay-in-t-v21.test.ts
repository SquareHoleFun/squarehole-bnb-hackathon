import { expect, it } from 'vitest';
import { plan, emptyMemory, afterRun } from '../src/plan';
import { seededRng } from '../src/rng';
import { box, keeper, v2, world } from './support/v2';
import type { V2State } from '../src/world';

const options = () => ({ keeper, payoutMinWei: 0n, rng: seededRng(2) });
const reward = { ...v2, buyBackP: 0n, depthBudget: 0n, rewardsPendingP: 1n << 140n, rewardBurnPendingT: 0n } as V2State;
it('T20 schedules pending reward P through the existing capped buy-back job', () => {
  const w = world(box({ v2: reward }));
  const p = plan(w, emptyMemory(), options());
  const buy = p.candidates.find(c => c.job === 'buyBack');
  expect(buy).toMatchObject({ fn: 'buyBack', args: [keeper] });
  if (!buy) throw new Error('missing reward buy');
  expect(plan(w, afterRun(p.mem, buy, true, w), options()).candidates.some(c => c.job === 'buyBack')).toBe(false);
  expect(plan(world(box({ v2: reward, graduated: false })), emptyMemory(), options()).candidates.some(c => c.job === 'buyBack')).toBe(false);
  expect(plan(world(box({ v2: reward, failed: true })), emptyMemory(), options()).candidates.some(c => c.job === 'buyBack')).toBe(false);
});
it('T21 retries bought inside-item T through burnPending without a new spending category', () => {
  const w = world(box({ v2: { ...reward, rewardsPendingP: 0n, rewardBurnPendingT: 9n } as V2State }));
  expect(plan(w, emptyMemory(), options()).candidates).toContainEqual(expect.objectContaining({ job: 'burnPending', fn: 'burnPending' }));
});
it('IP16 schedules Depth P through the existing pool job and preserves its budget category', () => {
  const w = world(box({ v2: { ...reward, rewardsPendingP: 0n, depthBudget: 1n << 140n } }));
  const p = plan(w, emptyMemory(), options());
  const deepen = p.candidates.find(c => c.job === 'deepen');
  expect(deepen).toMatchObject({ fn: 'deepen', args: [keeper] });
  expect(p.candidates.some(c => c.job === 'buyBack')).toBe(false);
  if (!deepen) throw new Error('missing Depth pool step');
  expect(plan(w, afterRun(p.mem, deepen, true, w), options()).candidates.some(c => c.job === 'deepen')).toBe(false);
  expect(plan(world(box({ v2: { ...v2, depthBudget: 1n }, failed: true })), emptyMemory(), options()).candidates.some(c => c.job === 'deepen')).toBe(false);
});

import { runTick } from '../src/run';
import { options as runOptions, quiet, fundedIncome } from './support/v2';
it('T28 reward steps obey both F111 income limits and the fixed daily ceiling', async () => {
  const w = world(box({ v2: reward }));
  const sends: string[] = [];
  const port = { read: async () => w, readIncome: async () => ({ ...fundedIncome(w), platformWei: 0n, boxes: {} }),
    simulate: async (c: { job: string }) => ({ ok: c.job === 'buyBack', estimate: 100_000n, tipWei: null }),
    send: async () => { sends.push('send'); return '0x01'; } };
  const out = await runTick(port, {}, { ...runOptions(), dryRun: false }, quiet);
  expect(out.report.skipped).toContainEqual(expect.objectContaining({ job: 'buyBack', why: 'box income cap' }));
  expect(sends).toEqual([]);
});

import { readM3 } from '../src/m3';
import { addr } from './support/v2';
import type { Address } from 'viem';
import { readM2 } from '../src/m2';
it('AF1 rescans holder settlement after later purchases and then schedules residue', async () => {
  let complete = true;
  // HoldersT on both sides (choice 7, ledger paying T = role 1), purchased funding, residue at the 0.01 T burn floor.
  const call = async <T>(_to: Address, _abi: readonly unknown[], fn: string, args?: readonly unknown[]): Promise<T> => {
    const result = fn === 'roleOf' ? addr(args?.[1] === 17n ? 17 : 1) : fn === 'holderLedger' ? addr(17)
      : fn === 'currentTradeBatch' ? 3n : fn === 'tradeBatch' ? { closed: true }
        : fn === 'buyersChoice' || fn === 'sellersChoice' ? 7 : fn === 'payoutAsset' ? addr(1) : fn === 'holderBatchPaid' ? 7n
          : fn === 'holderBatchClosed' ? true : fn === 'batchState' ? [complete, 2n, 0n, 10n ** 16n] : undefined;
    if (result === undefined) throw new Error(`unexpected read ${fn}`);
    return result as T;
  };
  const scan = {};
  const read = () => readM2({ registry: addr(90), id: 1n, hook: addr(2), receiver: addr(5), coordinator: addr(0), failed: false,
    scan, call, code: async () => '0x', guard: async (_key, fn) => fn() });
  expect(await read()).toContainEqual(expect.objectContaining({ job: 'holderResidue', args: [1n] }));
  complete = false;
  expect(await read()).toContainEqual(expect.objectContaining({ job: 'holderSettle', args: [1n, 16n] }));
  complete = true;
  expect(await read()).toContainEqual(expect.objectContaining({ job: 'holderResidue', args: [1n] }));
});
it('T29 uses eight-record mixed currency pages and an independent T residue retry', async () => {
  const call = async <T>(_to: Address, _abi: readonly unknown[], fn: string, args?: readonly unknown[]): Promise<T> => {
    const result = fn === 'roleOf' ? addr(args?.[1] === 16n ? 16 : 3) : fn === 'itemLedger' ? addr(16)
      : fn === 'tokenSides' ? 1 : fn === 'itemFundingCount' ? 20n : 0n;
    return result as T;
  };
  const work = await readM3({ registry: addr(90), id: 1n, receiver: addr(5), coordinator: addr(1), failed: false, graduated: true, gateOpen: true,
    call, guard: async (_key, read, fallback) => { try { return await read(); } catch { return fallback(); } } });
  expect(work).toContainEqual(expect.objectContaining({ job: 'itemSync', args: [8n] }));
  expect(work).toContainEqual(expect.objectContaining({ job: 'itemResidue', fn: 'flushResidueT' }));
});
