/**
 * The whole v2 system on Sepolia (docs/v2/sepolia-full.md; broadcast 2026-09-30, checked in
 * docs/evidence/SH-V2-sepolia-full.md Part A): the `sepolia-full` target, its addresses recomputed from first
 * principles, and a replay of the recorded chain (fixtures/sepolia-full.json: every log of ours from the genesis block
 * to block 11,818,130 and the headers of the launch window, read-only from the keyless public RPC by
 * scripts/record-fixture.ts) through the pipeline, checked against the chain's own slot0 and totalSupply.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeAbiParameters, getContractAddress, keccak256, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { DEFAULT_POOL_TARGET, loadServiceConfig, poolTargetFromEnv, SEPOLIA_FULL, SEPOLIA_REHEARSAL } from '../src/config';
import { MISFITS_CURVE } from '../src/curve';
import { applyBlock, initialPoolState } from '../src/derive';
import { decodeBlockLogs } from '../src/events';
import { Gateway } from '../src/gateway/server';
import type { BlockHeader } from '../src/model';
import { PoolIndexer } from '../src/pipeline';
import { LAUNCH_TAX_TABLE_PIPS, MISFITS_LAUNCH_SHAPE } from '../src/shape';
import { MemoryStore } from '../src/store/memory-store';
import type { LiveSnapshot } from '../src/views';
import { loadRecordedFixture, ScriptedChain } from './scripted-chain';

const T = SEPOLIA_FULL;
const fixture = loadRecordedFixture('sepolia-full.json');
/** The testnet deployer (F08); the genesis is its CREATE at nonce 11 (A1, transaction 8). */
const DEPLOYER: Address = '0x1F1481667Ef20928d55524dfE4640f96Bd9b4eeE';
const DEPLOYER_LOWER = DEPLOYER.toLowerCase();
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const created = (from: Address, nonce: bigint) => getContractAddress({ from, nonce });

/** keccak256(abi.encode(PoolKey)): native ETH, the token, 1%, spacing 60, the hook. */
function poolIdOf(token: Address, hook: Address): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
      ['0x0000000000000000000000000000000000000000', token, MISFITS_LAUNCH_SHAPE.lpFeePips, MISFITS_LAUNCH_SHAPE.tickSpacing, hook],
    ),
  );
}

describe('the sepolia-full target', () => {
  it('names the deployed contracts: each one is the genesis’s CREATE at its nonce, the genesis the deployer’s at nonce 11', () => {
    expect(created(DEPLOYER, 11n)).toBe(T.genesis);
    expect(created(T.genesis, 1n)).toBe(T.token);
    expect(created(T.genesis, 5n)).toBe(T.collector);
    expect(created(T.genesis, 6n)).toBe(T.launchRouter);
    expect(created(T.genesis, 8n)).toBe(T.executor);
    // The hook is CREATE2 (salt 5,627, A2): its low 14 bits are the flags of Uniswap's automatic routing class.
    expect(BigInt(T.hook) & 0x3fffn).toBe(0x2ae0n);
    expect(poolIdOf(T.token, T.hook)).toBe(T.poolId);
    expect(T.poolManager).toBe('0xE03A1074c86CFeDd5C142C4F04F1a1536e203543');
  });

  it('has the open block the genesis announced (its block + 300) and the 32-block window, on the Misfits curve', () => {
    expect(T).toMatchObject({ chainId: 11_155_111, deployBlock: 11_817_793n, openBlock: 11_818_093n, closeBlock: 11_818_125n, tokenSymbol: 'RHT2', issuance: 10n ** 27n });
    expect(T.curve).toBe(MISFITS_CURVE);
    expect(T.curve.raiseWei).toBe(T.targetWei); // F40 L6: the full raise is the target
    expect(T.label).not.toMatch(/fit|misfit|square|hole|stonk|sorter/i); // the neutral names stay neutral (F30 Q2)
    // The router's table on chain (recorded `taxTable()`) is the one the service computes the window tax with.
    expect(fixture.taxTable).toEqual([...LAUNCH_TAX_TABLE_PIPS]);
  });

  it('is the service’s default; SH_POOL_TARGET picks the route rehearsal; anything else is refused', () => {
    expect(DEFAULT_POOL_TARGET).toBe('sepolia-full');
    expect(loadServiceConfig({}).target).toBe(SEPOLIA_FULL);
    expect(loadServiceConfig({ SH_POOL_TARGET: '' }).target).toBe(SEPOLIA_FULL);
    expect(loadServiceConfig({ SH_POOL_TARGET: 'sepolia-rehearsal' }).target).toBe(SEPOLIA_REHEARSAL);
    expect(poolTargetFromEnv({ SH_POOL_TARGET: 'sepolia-full' })).toBe(SEPOLIA_FULL);
    expect(() => loadServiceConfig({ SH_POOL_TARGET: 'mainnet' })).toThrow();
    expect(() => poolTargetFromEnv({ SH_POOL_TARGET: 'SEPOLIA-FULL' })).toThrow();
  });

  it('is the pool the web app’s Sepolia market record names (apps/web/fit-markets/fit-market-11155111.json)', () => {
    const record = JSON.parse(readFileSync(join(ROOT, 'apps/web/fit-markets/fit-market-11155111.json'), 'utf8')) as {
      chainId: number;
      poolId: string;
      deployBlock: string;
      openBlock: string;
      curve: string;
      collectionSize: string;
      contracts: Record<string, string>;
      names: { token: { name: string; symbol: string } };
    };
    expect(record.chainId).toBe(T.chainId);
    expect(record.poolId).toBe(T.poolId);
    expect([BigInt(record.deployBlock), BigInt(record.openBlock)]).toEqual([T.deployBlock, T.openBlock]);
    expect(record.curve).toBe('misfits');
    expect(record.collectionSize).toBe('4200');
    const c = record.contracts;
    for (const [key, value] of [['token', T.token], ['hook', T.hook], ['poolManager', T.poolManager], ['launchRouter', T.launchRouter], ['genesis', T.genesis], ['collector', T.collector], ['executor', T.executor]] as const) {
      expect(same(c[key] ?? '', value), key).toBe(true);
    }
    // The custody contracts the indexer does not follow, from the same first principles (A2).
    expect(c['collection']).toBe(created(T.genesis, 2n));
    expect(c['vault']).toBe(created(T.genesis, 3n));
    expect(c['placeholders']).toBe(created(T.genesis, 7n));
    expect(c['randomnessSource']).toBe('0x617f7E7349393992b0cf5F4D42F1c090A171d432'); // SOURCE_ADDRESS_SEPOLIA
    expect(record.names.token).toEqual({ name: 'Rehearsal Token 2', symbol: T.tokenSymbol });
  });
});

describe('the genesis block on the recorded chain', () => {
  it('decodes into the seed, the bootstrap buy and its burn, and the announced window', () => {
    const header = fixture.headers.find((h) => h.number === T.deployBlock) as BlockHeader;
    const logs = fixture.logs.filter((l) => l.blockNumber === T.deployBlock);
    const events = decodeBlockLogs(logs, T);
    expect(events.map((e) => e.kind)).toEqual([
      'transfer', // issuance to the genesis
      'initialize',
      'modify_liquidity', // the hook's seed
      'transfer', // the curve's tokens into the PoolManager
      'pool_launched',
      'swap', // the bootstrap buy through the launch router
      'modify_liquidity', // its Δ0 fee collection
      'fees_realised',
      'transfer', // the bought tokens back to the genesis
      'bootstrapped',
      'transfer', // burned
      'window_announced',
    ]);
    const base = initialPoolState({ ...header, number: T.deployBlock - 1n }, T.curve);
    const ctx = { launchRouter: T.launchRouter, hook: T.hook, genesis: T.genesis, collector: T.collector, executor: T.executor, shape: T.curve };
    const { state, trades, activity } = applyBlock(base, header, events, fixture.senders, ctx);
    expect(state).toMatchObject({
      sqrtPriceX96: 2_134_668_269_687_644_999_244_826_820_850_194n,
      tick: 204_040,
      liquidity: MISFITS_LAUNCH_SHAPE.liquidity,
      swapCount: 1,
      volumeWei: 1_500_000_000_000_000n,
      feesWei: 14_999_999_999_999n,
      burnedRaw: 1_079_101_566_195_790_658_621_806n,
      anomalies: 0,
      phase: 'curve',
    });
    expect(trades[0]).toMatchObject({ route: 'bootstrap', ethRaw: 1_500_000_000_000_000n, tokenRaw: 1_079_101_566_195_790_658_621_806n, trader: DEPLOYER_LOWER, retainedAfterWei: 1_484_999_999_999_999n });
    expect(activity.map((a) => `${a.kind}:${a.detail}`)).toEqual(['burn:bootstrap', 'window_announced:11818093-11818125']);
  });
});

describe('pipeline: replaying the recorded full deployment', () => {
  it('backfills from the genesis block, follows the last 32 blocks, and matches the chain at block 11,818,130', async () => {
    const chain = ScriptedChain.fromFixture(fixture, T);
    const store = new MemoryStore();
    const indexer = new PoolIndexer({ reader: chain, store, target: T, confirmations: 2, now: () => 1_000 });
    await indexer.start();
    await indexer.idle();
    expect(indexer.metrics.verified).toBe(true); // √P, tick, L and burned equal the recorded slot0 and totalSupply
    expect(indexer.metrics.errors).toBe(0);
    expect(fixture.atEnd.totalSupply).toBe(T.issuance - 1_079_101_566_195_790_658_621_806n);
    const snapshot = JSON.parse((await store.getSnapshot())?.json ?? '{}') as LiveSnapshot;
    expect(snapshot).toMatchObject({
      chainId: 11_155_111,
      poolId: T.poolId,
      label: T.label,
      tokenSymbol: 'RHT2',
      head: { number: '11818130', hash: fixture.atEnd.hash },
      state: {
        retainedWei: '1484999999999999',
        soldRaw: '1079101566195790658621806',
        leftRaw: '797058867754607625913344075',
        fillBps: 3,
        curveBps: 3,
        phase: 'CURVE_ACTIVE',
        launchPhase: 'curve',
        burned: '1079101.566195790658621806',
        swapCount: 1,
      },
      window: { openBlock: '11818093', closeBlock: '11818125', status: 'open', nextBlockTaxPips: 0 },
      // The Misfits curve, not the rehearsal's: the page compares this with its own record.
      curve: { tickLower: 177_180, tickUpper: 204_060, targetWei: '4206980085000000000', raiseWei: '4206980085000000000', liquidity: '40035151265858715901343', tokensDepositedRaw: '798137969320803416571965883' },
    });
    expect(snapshot.trades).toHaveLength(1);
    expect(snapshot.trades[0]).toMatchObject({ route: 'bootstrap', eth: '0.0015', tokens: '1079101.566195790658621806', trader: DEPLOYER_LOWER });
    expect(snapshot.activity.map((a) => a.kind)).toEqual(['window_announced', 'burn']);
  });

  it('serves nothing that names the launch: the snapshot as stored and served, and /curve, stay neutral (F30 Q2)', async () => {
    const HINTS = /fit|misfit|square|hole|stonk|sorter/i;
    const chain = ScriptedChain.fromFixture(fixture, T);
    const store = new MemoryStore();
    const indexer = new PoolIndexer({ reader: chain, store, target: T, confirmations: 2, now: () => 1_000 });
    await indexer.start();
    await indexer.idle();
    const stored = (await store.getSnapshot())?.json ?? '';
    expect(stored.length).toBeGreaterThan(0);
    expect(stored).not.toMatch(HINTS);
    const gateway = new Gateway({ store, target: T, port: 0, host: '127.0.0.1' });
    await gateway.start();
    try {
      const base = `http://127.0.0.1:${gateway.address().port}/v1/pools/11155111/${T.poolId.toLowerCase()}`;
      const curve = await (await fetch(`${base}/curve`)).text();
      const snapshot = await (await fetch(`${base}/snapshot`)).text();
      expect(JSON.parse(curve)).toMatchObject({ curve: { targetWei: '4206980085000000000' } });
      expect(JSON.parse(snapshot)).toMatchObject({ poolId: T.poolId, tokenSymbol: 'RHT2' });
      expect(curve).not.toMatch(HINTS);
      expect(snapshot).not.toMatch(HINTS);
    } finally {
      await gateway.stop();
      await store.close();
    }
  });

  it('counts down to the open and walks the tax table from the recorded window headers', async () => {
    const chain = ScriptedChain.fromFixture(fixture, T, T.openBlock + 9n); // recorded headers are contiguous from 11,818,060
    const store = new MemoryStore();
    const indexer = new PoolIndexer({ reader: chain, store, target: T, confirmations: 2 });
    await indexer.start();
    const snapshot = JSON.parse((await store.getSnapshot())?.json ?? '{}') as LiveSnapshot;
    expect(snapshot.window).toMatchObject({ status: 'router_window', nextBlock: '11818103', blocksToClose: '22', nextBlockTaxPips: LAUNCH_TAX_TABLE_PIPS[10] });
    expect(indexer.metrics.errors).toBe(0);
  });
});
