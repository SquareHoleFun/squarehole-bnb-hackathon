import { boxHookAbi, boxItemStreamAbi } from '@squarehole/chain/abi';
import { encodeFunctionResult, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { CoreChainIndexer, type HistoryMessage } from '../../../src/core/chain-indexer';
import { deferred } from '../core-art-deferred';
import { ev, synthBox, synthManifest, World } from '../core-synth';
import { boxLogsV2, listingAddedLog, requiredV2, serviceBoxV2, serviceChainV2, serviceListingV2, synthManifestV2, V2 } from '../scripted-core-chain';

async function mixedFixture(beforeFails: boolean, nextFails: boolean) {
  const source = synthBox({ boxId: 0n, creationBlock: 100n });
  const shared = { poolManager: V2.poolManager, randomness: V2.randomness };
  const box0 = { ...source, row: { ...source.row, ...shared }, record: { ...source.record, ...shared } };
  const box2 = serviceBoxV2();
  const world = new World('mixed-displays');
  world.block(10n);
  world.block(99n, [listingAddedLog(serviceListingV2())]);
  world.block(100n, [world.created(box0), boxLogsV2(box2)]);
  const candidate = world.block(101n, [ev.collected(box0, 150n, 0n)]);
  const chain = serviceChainV2(world, [box2]);
  const code = chain.codeAnswers;
  chain.codeAnswers = (address, hash) => box0.codes.get(address.toLowerCase()) ?? code(address, hash);
  const call = chain.callAt.bind(chain);
  const displayReads: Hex[] = [];
  chain.callAt = async (to, data, hash) => {
    const hook = to.toLowerCase() === box0.row.contracts.hook?.toLowerCase();
    const stream = to.toLowerCase() === box0.row.contracts.itemStream?.toLowerCase();
    if (!hook && !stream) return call(to, data, hash);
    displayReads.push(hash);
    const next = hash === candidate.hash;
    if (next ? nextFails : beforeFails) throw new Error('scripted display unavailable');
    const value = next ? 999n : 1n;
    return hook
      ? encodeFunctionResult({ abi: boxHookAbi, functionName: 'depthBudget', result: [value, value * 2n] })
      : encodeFunctionResult({ abi: boxItemStreamAbi, functionName: 'index', result: value * 3n });
  };
  const history: HistoryMessage[] = [];
  const updates: string[][] = [];
  const manifest = { ...synthManifestV2(), versions: synthManifest().versions };
  const indexer = new CoreChainIndexer({ reader: chain, manifest, auditEvery: 10_000,
    onHistory: (message) => { history.push(message); }, onUpdate: (tokens) => { updates.push([...tokens]); } });
  chain.tip = 100n;
  await indexer.start();
  const token0 = requiredV2(box0.row.contracts.token ?? undefined).toLowerCase();
  const token2 = requiredV2(box2.record.contracts[1]).toLowerCase();
  const entry = requiredV2(indexer.boxes.get(token0));
  expect(entry.row.isBox0).toBe(true);
  expect(indexer.boxView(token0)).toMatchObject({ asOf: { block: '100' }, readsBlock: beforeFails ? null : '100' });
  expect(entry.displayFailing).toBe(beforeFails);
  expect(indexer.v2BoxView(token2)?.money?.block).toBe('100');
  return { world, chain, candidate, displayReads, history, updates, indexer, token0, token2, entry };
}

describe('CQ11-E / BC-077 mixed-version display publication', () => {
  for (const outcome of ['accept', 'reorg', 'stop'] as const) {
    it.each([
      { beforeFails: false, nextFails: false },
      { beforeFails: false, nextFails: true },
      { beforeFails: true, nextFails: false },
    ])(`${outcome} after v1 display reads: prior failure=$beforeFails, next failure=$nextFails`, async ({ beforeFails, nextFails }) => {
      const f = await mixedFixture(beforeFails, nextFails);
      const { chain, indexer, candidate, token0, token2, entry } = f;
      const before = indexer.boxView(token0);
      const beforeV2 = indexer.v2BoxView(token2);
      const beforeHistory = f.history.length;
      const beforeUpdates = f.updates.length;
      const reached = deferred<boolean>(); const release = deferred<boolean>();
      const header = chain.headerByNumber.bind(chain);
      // The final canonical-header read follows ALL display reads, immediately before publication.
      chain.headerByNumber = async (number) => {
        if (number === candidate.number) { reached.resolve(true); await release.promise; }
        return header(number);
      };
      chain.tip = 101n;
      const applying = indexer.enqueue(candidate);
      await reached.promise;
      expect.soft(f.displayReads.filter((hash) => hash === candidate.hash)).toHaveLength(2);
      expect.soft(indexer.boxView(token0)).toEqual(before);
      expect.soft(entry.displayFailing).toBe(beforeFails);
      expect.soft(indexer.v2BoxView(token2)).toEqual(beforeV2);
      expect.soft(f.history).toHaveLength(beforeHistory);
      expect.soft(f.updates).toHaveLength(beforeUpdates);

      const replaceBranch = () => {
        const replacement = f.world.fork(100n, `replacement-${outcome}`);
        replacement.to(102n); // No v1 events: recovery must not rely on a display refresh or rollback.
        chain.setBranch(replacement.headers.filter((h) => h.number > 100n), []);
      };
      if (outcome === 'reorg') replaceBranch();
      if (outcome === 'stop') indexer.stop();
      release.resolve(true);
      await applying;
      chain.headerByNumber = header;

      if (outcome === 'accept') {
        expect(indexer.head()?.hash).toBe(candidate.hash);
        expect(indexer.boxView(token0)).toMatchObject({
          asOf: { block: '101' }, fees: { collectedQ: '150' },
          reads: nextFails ? before?.reads : { 'hook.depthBudgetQ': '999', 'hook.depthBudgetT': '1998', 'stream.index': '2997' },
          readsBlock: nextFails ? '100' : '101', readsCurrent: !nextFails,
        });
        expect(entry.displayFailing).toBe(nextFails);
        expect(indexer.v2BoxView(token2)?.money?.hash).toBe(candidate.hash);
        expect(f.history).toHaveLength(beforeHistory + 1);
        expect(f.updates).toHaveLength(beforeUpdates + 1);
      } else {
        expect.soft(indexer.head()?.number).toBe(100n);
        expect.soft(indexer.boxView(token0)).toEqual(before);
        expect.soft(entry.displayFailing).toBe(beforeFails);
        expect.soft(indexer.v2BoxView(token2)).toEqual(beforeV2);
        expect.soft(f.history).toHaveLength(beforeHistory);
        expect.soft(f.updates).toHaveLength(beforeUpdates);
        expect(indexer.metrics.errors).toBe(1);
        if (outcome === 'reorg') expect(indexer.metrics.lastError).toContain('v2 money block changed before publication');
        else expect(indexer.metrics.lastError).toMatch(/aborted/i);

        const readsBeforeRecovery = f.displayReads.length;
        if (outcome === 'stop') { replaceBranch(); await indexer.start(); }
        else await indexer.enqueue(chain.header(102n));
        expect(indexer.head()?.hash).toBe(chain.header(102n).hash);
        expect(indexer.boxView(token0)).toEqual({ ...before, asOf: indexer.asOf() });
        expect(entry.displayFailing).toBe(beforeFails);
        expect(f.displayReads).toHaveLength(readsBeforeRecovery);
        expect(indexer.v2BoxView(token2)?.money?.hash).toBe(chain.header(102n).hash);
        expect(indexer.metrics.reorgs).toBe(0);
        expect(f.history.some((message) => message.type === 'rollback')).toBe(false);
      }
      indexer.stop();
    });
  }
});
