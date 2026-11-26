// @vitest-environment node
/**
 * SH-258: the trade box's and the test-coin page's targets under `SH_TESTNET=bnb` (BNB Chain testnet, chain 97): the
 * network's own record (packages/chain/src/trade-sepolia/coin-deployment-97.json, embedded as TESTNET_COIN_RECORD; here
 * passed in) instead of Sepolia's pins. Fakes (0x97…) and lane c's rehearsal files on a local chain with id 97 (SH-260,
 * 9f5056a8): never the real record.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Eip1193Request } from '@squarehole/chain/write';
import type { V2Snapshot, V2Source } from '../core/v2/indexer-v2';
import type { ReleaseV2 } from '../../../../../packages/chain/src/core/v2';
import { parseCoreManifestV2 } from '../../../../../packages/chain/src/core/v2';
import { required } from '../core/v2/test-support/required';
import rehearsalRecord from '../../../../../packages/chain/test/fixtures/bnb-testnet/coin-deployment-97.rehearsal.json' with { type: 'json' };
import rehearsalManifest from '../../../../../packages/chain/test/fixtures/bnb-testnet/core-manifest-97.rehearsal.json' with { type: 'json' };

const ZERO = '0x0000000000000000000000000000000000000000';
const fake = (n: number) => `0x97${'0'.repeat(34)}${n.toString(16).padStart(4, '0')}`;
const HASH = `0x${'97'.repeat(32)}`;
const MANAGER = fake(1);
const REGISTRY = fake(2);
const COORDINATOR = fake(3);
const pair = (coin: string, symbol: string, decimals: number) => ({ coin, symbol, decimals, fee: '3000', tickSpacing: 60, hooks: ZERO, tickLower: -887220, tickUpper: 887220 });
/** BNB Chain testnet's trade and test-coin record, in coin-deployment.json's shape (fakes). */
const coinRecord = (patch: Record<string, unknown> = {}) => ({
  chainId: 97, status: 'deployed', teth: { address: fake(10), codeHash: HASH }, pairHelper: { address: fake(11), codeHash: HASH },
  poolManager: MANAGER, poolSwapTest: fake(12), poolSwapTestCodeHash: HASH,
  pairs: [pair(fake(20), 'tUSDC', 6), pair(fake(21), 'tNVDA', 18), pair(fake(22), 'tGOLD', 18), pair(fake(23), 'tPEPE', 18)], ...patch,
});
const sourceOf = (chainId: number): V2Source => ({ network: 'sepolia', rpc: 'https://bsc-testnet-rpc.publicnode.com', origin: '', manifest: {
  chainId, chain: { poolManager: { address: MANAGER } }, releases: [{ registry: { address: REGISTRY } }] } }) as unknown as V2Source;
const release = { registry: { address: REGISTRY, codeHash: HASH } } as unknown as Pick<ReleaseV2, 'registry'>;
const record = { contracts: [COORDINATOR, ...Array.from({ length: 23 }, (_, i) => fake(100 + i))], codeHashes: Array.from({ length: 24 }, () => HASH) } as unknown as V2Snapshot['record'];
const rpcs = () => {
  const urls: string[] = [];
  return { urls, make: (url: string): Eip1193Request => { urls.push(url); return async () => null; } };
};

async function bnb<T>(load: () => Promise<T>): Promise<T> {
  vi.stubEnv('SH_TESTNET', 'bnb');
  vi.resetModules();
  return load();
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('SH_TESTNET=bnb: the trade box and the test-coin page read the network’s own record', () => {
  it('the trade target: the record’s PoolSwapTest with the release’s registry, BscScan; no record or not deployed: not set up', async () => {
    const { tradeTargetOf } = await bnb(() => import('./trade-target'));
    const rpc = rpcs();
    const read = tradeTargetOf(sourceOf(97), { record, release }, null, rpc.make, coinRecord());
    if (!read.ok) throw new Error(read.reason);
    expect(read.target.chainId).toBe(97);
    expect(read.target.localDeployment).toEqual({ poolSwapTest: fake(12), poolManager: MANAGER, poolSwapTestCodeHash: HASH, boxRegistry: REGISTRY });
    expect(rpc.urls).toEqual(['https://bsc-testnet-rpc.publicnode.com']);
    expect(read.target.explorer(HASH)).toBe(`https://testnet.bscscan.com/tx/${HASH}`);
    for (const missing of [null, coinRecord({ status: 'predicted' }), coinRecord({ chainId: 11155111 }), coinRecord({ poolManager: fake(99) })]) {
      expect(tradeTargetOf(sourceOf(97), { record, release }, null, rpc.make, missing)).toEqual({ ok: false, reason: 'deployment_required' });
    }
    // Sepolia's chain is not this build's test network.
    expect(tradeTargetOf(sourceOf(11_155_111), { record, release }, null, rpc.make, coinRecord())).toEqual({ ok: false, reason: 'chain_not_allowed' });
  });

  it('the files SH-260 writes (its rehearsal on chain 97): the trade box and the test-coin page are set up', async () => {
    const [{ tradeTargetOf }, { coinTargetOf }] = await bnb(() => Promise.all([import('./trade-target'), import('./coin-target')]));
    const manifest = parseCoreManifestV2(rehearsalManifest);
    const source = { network: 'sepolia', rpc: 'https://bsc-testnet-rpc.publicnode.com', origin: '', manifest } as unknown as V2Source;
    const trade = tradeTargetOf(source, { record, release: required(manifest.releases[0]) }, null, rpcs().make, rehearsalRecord);
    if (!trade.ok) throw new Error(trade.reason);
    expect(trade.target.localDeployment).toMatchObject({ poolSwapTest: rehearsalRecord.poolSwapTest, boxRegistry: manifest.releases[0]?.registry.address });
    const coins = coinTargetOf(source, null, rpcs().make, rehearsalRecord);
    if (!coins.ok) throw new Error(coins.reason);
    expect([coins.target.teth.symbol, ...coins.target.pairs.map((p) => p.symbol)]).toEqual(['tETH', 'tUSDC', 'tNVDA', 'tGOLD', 'tPEPE']);
  });

  it('the coin target: tETH and the four test coins from the record; without it, "not live yet"', async () => {
    const [{ coinTargetOf }, words] = await bnb(() => Promise.all([import('./coin-target'), import('./trade-words')]));
    const rpc = rpcs();
    const read = coinTargetOf(sourceOf(97), null, rpc.make, coinRecord());
    if (!read.ok) throw new Error(read.reason);
    expect(read.target.teth).toEqual({ address: fake(10), symbol: 'tETH', decimals: 18 });
    expect(read.target.pairs.map((p) => p.symbol)).toEqual(['tUSDC', 'tNVDA', 'tGOLD', 'tPEPE']);
    expect(read.target.localDeployment).toEqual(coinRecord());
    expect(read.target.explorer(HASH)).toBe(`https://testnet.bscscan.com/tx/${HASH}`);
    const absent = coinTargetOf(sourceOf(97), null, rpc.make, null);
    expect(absent).toEqual({ ok: false, reason: 'deployment_predicted' });
    expect(words.tradeLine('deployment_predicted')).toBe('Test coins are not live yet.');
    expect(words.tradeLine('deployment_required')).toBe('Trading is not set up on this chain.');
    expect(coinTargetOf(null, null, rpc.make, coinRecord())).toEqual({ ok: false, reason: 'source_unavailable' });
  });
});

describe('SH_TESTNET=bnb: the trade box’s words and clock', () => {
  it('coin and gas words name BNB and tBNB; a quote counts whole seconds', async () => {
    const [words, stage] = await bnb(() => Promise.all([import('./trade-words'), import('./trade-stage')]));
    expect(words.tradeLine('wrong_value')).toBe('Wrong BNB amount.');
    expect(words.tradeLine('gas_funds')).toBe('Needs a little tBNB for gas.');
    expect(stage.slotSecondsSince(0, 2_500)).toBe(2n);
  });

  it('the default build keeps Sepolia’s words and 12-second slots', async () => {
    const [words, stage] = await Promise.all([import('./trade-words'), import('./trade-stage')]);
    expect(words.tradeLine('wrong_value')).toBe('Wrong ETH amount.');
    expect(words.tradeLine('gas_funds')).toBe('Needs a little SepETH for gas.');
    expect(stage.slotSecondsSince(0, 23_999)).toBe(12n);
  });
});

describe('round 3: the buy form\'s launch tax time', () => {
  it('BNB Chain testnet: the latest observed block\'s time, never moved on by the browser\'s clock', async () => {
    const stage = await bnb(() => import('./trade-stage'));
    // The quote's block at window second 11; 30 wall seconds later, no newer block observed: still second 11 (step 0).
    expect(stage.taxChainNow(1_000n, { blockTimestamp: 1_011n, at: 0 }, 30_000)).toBe(1_011n);
    expect(stage.windowTaxAt(1_000n, stage.taxChainNow(1_000n, { blockTimestamp: 1_011n, at: 0 }, 30_000))).toEqual(stage.windowTaxAt(1_000n, 1_000n));
  });

  it('Sepolia, as before: the quote\'s block plus whole 12 s slots', async () => {
    const stage = await import('./trade-stage');
    expect(stage.taxChainNow(1_000n, { blockTimestamp: 1_011n, at: 0 }, 24_000)).toBe(1_035n);
  });
});

describe('SH_TESTNET=bnb: the test-coin page without a deployed record', () => {
  it('says the coins are not live yet before it reads the chain (no index, no source)', async () => {
    const { coinTargetOf } = await bnb(() => import('./coin-target'));
    expect(coinTargetOf(null, null, rpcs().make, null)).toEqual({ ok: false, reason: 'deployment_predicted' });
    expect(coinTargetOf(null, null, rpcs().make, coinRecord({ status: 'predicted' }))).toEqual({ ok: false, reason: 'deployment_predicted' });
  });
});

describe('SH_TESTNET=bnb: the faucet button without a readable price', () => {
  it('a missing or zero gas price never lets the drip button on (the sender would refuse)', async () => {
    const due = await bnb(() => import('./faucet-due'));
    expect(due.dripGasNeed(null)).toBe(due.UNREADABLE_PRICE_NEED);
    expect(due.dripGasNeed(0n)).toBe(due.UNREADABLE_PRICE_NEED);
    expect(due.dripGasNeed(100_000_000n, 500_000n)).toBe(100_000_000_000_000n);
  });

  it('round 3: a due drip without a usable price says so, never "needs a little tBNB" (more funds would not help)', async () => {
    const [due, words, run, executor] = await bnb(() => Promise.all([import('./faucet-due'), import('./trade-words'), import('./trade-run'), import('@squarehole/chain/write')]));
    expect(due.dripGasReason(null, 10n ** 18n)).toBe('gas_price_unread');
    expect(due.dripGasReason(0n, 10n ** 18n)).toBe('gas_price_unread');
    expect(due.dripGasReason(100_000_000n, 10n ** 18n, 500_000n)).toBeNull();
    expect(due.dripGasReason(100_000_000n, 1n, 500_000n)).toBe('gas_funds');
    // Round 3b: above the ceiling no balance helps: said as that, before any lack of funds.
    expect(due.dripGasReason(6_000_000_000n, 1n, 500_000n)).toBe('gas_price_high');
    expect(words.tradeLine('gas_price_unread')).toBe('No usable gas price from the network; nothing was sent.');
    expect(words.tradeLine('gas_funds')).toBe('Needs a little tBNB for gas.');
    // A trade or coin send the executor refused for the price reaches the page as that price's line.
    expect(run.sendFailure(new executor.NetworkPriceError('no_price', null))).toEqual({ kind: 'not_sent', reason: 'gas_price_unread' });
    expect(run.sendFailure(new executor.NetworkPriceError('above_ceiling', 6_000_000_000n))).toEqual({ kind: 'not_sent', reason: 'gas_price_high' });
    expect(run.sendFailure(new executor.NetworkPriceError('rose', 120_000_000n))).toEqual({ kind: 'not_sent', reason: 'gas_price_rose' });
  });

  it('Sepolia keeps "any SepETH at all" without a price', async () => {
    const due = await import('./faucet-due');
    expect(due.dripGasNeed(null)).toBe(1n);
  });
});

