/**
 * Release review of rc6 (RC6RR-FC-1). The indexer reads every v2 box's money at every head block, and part 4 put the
 * income inbox's custody read (`heldBalance` of ETH, WETH, P and T) into that read. `heldBalance(P)` reverts
 * `TokenUnreadable` when P's `balanceOf(inbox)` reverts, returns a short word or needs more than 50,000 gas, a state
 * the contracts are built to survive. Before this fix one box's refusal stopped the head for every box: every snapshot
 * went stale and every claim send on the site refused. Now an unreadable coin only leaves the inbox's publication
 * incomplete, and any other refused money read leaves that one box without money (and unverified) at that block.
 */
import { describe, expect, it } from 'vitest';
import { decodeFunctionData, type Abi, type Address, type Hex } from 'viem';
import { CoreChainIndexer } from '../../../src/core/chain-indexer';
import { coordinatorV2Abi, royaltyRouterV2Abi } from '../../../src/core/v2/chain-v2';
import { refusedAtHash } from '../../../src/core/v2/money-v2';
import { World } from '../core-synth';
import { boxLogsV2, serviceBoxV2, serviceChainV2, synthManifestV2, listingAddedLog, serviceListingV2, requiredV2 } from '../scripted-core-chain';

type Refusal = { readonly part: 8 | 0; readonly fn: string; readonly coin?: 'p' };

async function run(refusal: Refusal | null, from = 105n) {
  const a = serviceBoxV2(4n, 100n, 4n);
  const b = serviceBoxV2(5n, 100n, 5n);
  const world = new World('rc6-money-isolation');
  world.block(10n); world.block(99n, [listingAddedLog(serviceListingV2())]); world.block(100n, [boxLogsV2(a), boxLogsV2(b)]);
  world.to(110n);
  const numberOf = new Map(world.headers.map((h) => [h.hash.toLowerCase(), h.number]));
  const chain = serviceChainV2(world, [a, b]);
  const original = chain.callAt.bind(chain);
  chain.callAt = async (to: Address, data: Hex, hash: Hex) => {
    const target = refusal ? requiredV2(a.record.contracts[refusal.part]) : null;
    if (refusal && target && to.toLowerCase() === target.toLowerCase() && (numberOf.get(hash.toLowerCase()) ?? 0n) >= from) {
      const abi: Abi = refusal.part === 8 ? royaltyRouterV2Abi : coordinatorV2Abi;
      const { functionName, args } = decodeFunctionData({ abi, data });
      if (functionName === refusal.fn && (!refusal.coin || String(args?.[0]).toLowerCase() === a.record.q.toLowerCase())) {
        // What a JSON-RPC node answers for the router's own refusal, `TokenUnreadable(P)` (`_read`).
        throw Object.assign(new Error('execution reverted'), { code: 3, data: '0x' });
      }
    }
    return original(to, data, hash);
  };
  const indexer = new CoreChainIndexer({ reader: chain, manifest: synthManifestV2(), auditEvery: 10_000 });
  const warn = console.warn; const error = console.error;
  const warnings: string[] = [];
  console.warn = (...m: unknown[]) => { warnings.push(m.map(String).join(' ')); };
  console.error = () => {};
  try {
    await indexer.start();
    await indexer.idle();
    const first = indexer.head()?.number ?? null;
    world.to(200n);
    for (const h of world.headers) numberOf.set(h.hash.toLowerCase(), h.number);
    chain.setBranch(world.headers.filter((h) => h.number > 110n), []);
    await indexer.enqueue(chain.header(200n));
    await indexer.idle();
    const later = indexer.head()?.number ?? null;
    const viewA = indexer.v2BoxView(requiredV2(a.record.contracts[1]));
    const viewB = indexer.v2BoxView(requiredV2(b.record.contracts[1]));
    return { first, later, viewA, viewB, warnings, metrics: { ...indexer.metrics }, p: a.record.q.toLowerCase() };
  } finally {
    console.warn = warn; console.error = error;
    indexer.stop();
  }
}

describe('RC6RR-FC-1: one box\'s refused money read never stops the head for every box', () => {
  it('control: both boxes publish money at every head', async () => {
    const r = await run(null);
    expect([r.first, r.later]).toEqual([110n, 200n]);
    expect(r.viewA?.money?.block).toBe('200');
    expect(r.viewB?.money?.block).toBe('200');
    expect(Object.keys(r.viewA?.money?.royalty?.balances ?? {})).toContain(r.p);
  });

  it('an inbox whose P balance cannot be read publishes that coin as unknown and complete: false', async () => {
    const r = await run({ part: 8, fn: 'heldBalance', coin: 'p' });
    expect([r.first, r.later]).toEqual([110n, 200n]);
    expect(r.viewB?.money?.block).toBe('200');
    expect(r.viewA?.money?.block).toBe('200');
    const royalty = r.viewA?.money?.royalty;
    expect(royalty?.complete).toBe(false);
    expect(Object.keys(royalty?.balances ?? {})).not.toContain(r.p);
    expect(Object.keys(royalty?.balances ?? {}).length).toBeGreaterThan(0);
    expect(r.metrics.errors).toBe(0);
  });

  it('any other refused money read leaves only that box without money, unverified, and says so once', async () => {
    const r = await run({ part: 0, fn: 'claimState' });
    expect([r.first, r.later]).toEqual([110n, 200n]);
    expect(r.viewB?.money?.block).toBe('200');
    expect(r.viewA?.money).toBeNull();
    expect(r.viewA?.verified).toBeNull();
    expect(r.warnings.filter((w) => w.includes('money not read'))).toHaveLength(1);
    expect(r.metrics.errors).toBe(0);
  });

  it('isolates only the chain refusing a read at its hash, however a node words the revert; anything else is retried (CQ11-E)', () => {
    expect(refusedAtHash(Object.assign(new Error('RPC Request failed.'), { code: 3 }))).toBe(true);
    expect(refusedAtHash(new Error('outer', { cause: Object.assign(new Error('Missing or invalid parameters.'), { code: -32000, details: 'execution reverted' }) }))).toBe(true);
    expect(refusedAtHash(Object.assign(new Error('x'), { name: 'ExecutionRevertedError' }))).toBe(true);
    for (const error of [new Error('money read offline'), Object.assign(new Error('Request exceeds defined limit.'), { code: -32005 }),
      new Error('HTTP request failed.', { cause: new Error('ECONNRESET') }), null, 'execution reverted']) expect(refusedAtHash(error)).toBe(false);
  });
});
