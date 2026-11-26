import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { SEPOLIA_REHEARSAL } from '../src/config';
import { curvePoint } from '../src/curve';
import { applyBlock, initialPoolState, type DeriveContext } from '../src/derive';
import { decodeBlockLogs, launchEventsAbi, poolManagerEventsAbi } from '../src/events';
import type { BlockHeader } from '../src/model';
import { REHEARSAL_SHAPE } from '../src/shape';
import { fakeHeader, fakeHash, loadRecordedFixture } from './scripted-chain';
import { synthBurn, synthSwap, txHash } from './synth';

const T = SEPOLIA_REHEARSAL;
const ctx: DeriveContext = { launchRouter: T.launchRouter, hook: T.hook, genesis: T.genesis, collector: T.collector, executor: T.executor, shape: T.curve };
const fixture = loadRecordedFixture();

function genesisResult() {
  const header = fixture.headers.find((h) => h.number === T.deployBlock) as BlockHeader;
  const logs = fixture.logs.filter((l) => l.blockNumber === T.deployBlock);
  const base = initialPoolState({ ...header, number: T.deployBlock - 1n }, T.curve);
  return applyBlock(base, header, decodeBlockLogs(logs, T), fixture.senders, ctx);
}

describe('folding blocks into the pool state', () => {
  it('turns the genesis block into the live state (bootstrap buy, fee, burn)', () => {
    const { state, trades, activity } = genesisResult();
    expect(state).toMatchObject({
      sqrtPriceX96: 2_134_673_235_199_704_036_912_890_647_912_850n,
      tick: 204_040,
      liquidity: REHEARSAL_SHAPE.liquidity,
      swapCount: 1,
      buyCount: 1,
      sellCount: 0,
      volumeWei: 1_500_000_000_000_000n,
      feesWei: 14_999_999_999_999n,
      burnedRaw: 1_079_104_076_324_374_082_820_149n,
      anomalies: 0,
    });
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      side: 'buy',
      route: 'bootstrap',
      ethRaw: 1_500_000_000_000_000n,
      tokenRaw: 1_079_104_076_324_374_082_820_149n,
      feeEthRaw: 14_999_999_999_999n,
      trader: '0x1f1481667ef20928d55524dfe4640f96bd9b4eee', // the testnet deployer (docs/v2/sepolia-rehearsal.md)
      retainedAfterWei: 1_484_999_999_999_999n,
      fillBpsAfter: 3,
    });
    expect(activity.map((a) => `${a.kind}:${a.detail}`)).toEqual(['burn:bootstrap', 'window_announced:11812074-11812106']);
    // The live chain at block 11,812,130 (recorded slot0 and totalSupply) agrees.
    expect(state.sqrtPriceX96).toBe(fixture.atEnd.sqrtPriceX96);
    expect(T.issuance - fixture.atEnd.totalSupply).toBe(state.burnedRaw);
  });

  it('pairs fees and the launch tax with their swap, and prices every trade', () => {
    const { state: start } = genesisResult();
    const header = fakeHeader(1, T.openBlock + 3n, fakeHash(1, T.openBlock + 2n), 1_790_740_000n);
    const buyer: Address = '0x00000000000000000000000000000000000b0b01';
    const a = synthSwap(T, header, txHash(1), 10, start.sqrtPriceX96, true, 10n ** 17n, { tax: 9n * 10n ** 17n, buyer });
    const b = synthSwap(T, header, txHash(2), 20, a.sqrtAfter, true, 5n * 10n ** 16n, { sender: '0x7E4f6c5e954Da5c61B3423D81E2277431Ac043f3' });
    const c = synthSwap(T, header, txHash(3), 30, b.sqrtAfter, false, 2n * 10n ** 25n, { sender: '0x7E4f6c5e954Da5c61B3423D81E2277431Ac043f3' });
    const burn = synthBurn(T, header, txHash(4), 40, T.collector, 12_345n);
    // tx.from of the router buy is a relayer here: the trader must still be TaxedBuy.buyer.
    const senders = new Map([[txHash(1), '0x00000000000000000000000000000000000e1a70' as Address], [txHash(2), '0x00000000000000000000000000000000000c0c02' as Address]]);
    const { state, trades, activity } = applyBlock(start, header, decodeBlockLogs([...a.logs, ...b.logs, ...c.logs, burn], T), senders, ctx);
    expect(trades.map((t) => [t.side, t.route])).toEqual([['buy', 'launch_router'], ['buy', 'other'], ['sell', 'other']]);
    expect(trades[0]).toMatchObject({ taxRaw: 9n * 10n ** 17n, recipient: buyer, trader: buyer, feeEthRaw: a.positionFee, ethRaw: 10n ** 17n, tokenRaw: a.amountOut });
    expect(trades[1]).toMatchObject({ taxRaw: 0n, recipient: null, trader: '0x00000000000000000000000000000000000c0c02', feeEthRaw: b.positionFee, feeTokenRaw: 0n });
    expect(trades[2]).toMatchObject({ trader: null, feeEthRaw: 0n, feeTokenRaw: c.positionFee, ethRaw: c.amountOut, tokenRaw: 2n * 10n ** 25n });
    expect(state.sqrtPriceX96).toBe(c.sqrtAfter);
    expect(state).toMatchObject({ swapCount: 4, buyCount: 3, sellCount: 1, taxWei: 9n * 10n ** 17n, burnedRaw: start.burnedRaw + 12_345n });
    expect(state.feesWei).toBe(start.feesWei + a.positionFee + b.positionFee);
    expect(state.feesTokenRaw).toBe(c.positionFee);
    expect(trades[2]?.retainedAfterWei).toBe(curvePoint(c.sqrtAfter).retainedWei);
    expect(trades[2]?.retainedAfterWei).toBeLessThan(trades[1]?.retainedAfterWei ?? 0n); // a sell lowers the band
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ kind: 'burn', detail: 'collector', amountRaw: 12_345n });
    expect(trades.map((t) => t.score)).toEqual([...trades.map((t) => t.score)].sort((x, y) => x - y));
  });

  it('flags what the hook forbids (a donation, a liquidity change that is not the Δ0 fee collection)', () => {
    const { state: start } = genesisResult();
    const header = fakeHeader(1, T.openBlock + 40n, fakeHash(1, T.openBlock + 39n), 1_790_741_000n);
    const seed = fixture.logs.find((l) => l.logIndex === 155) ?? (() => { throw new Error('no seed log'); })();
    const moved = { ...seed, blockNumber: header.number, blockHash: header.hash };
    const { state, activity } = applyBlock(start, header, decodeBlockLogs([moved], T), new Map(), ctx);
    expect(state.anomalies).toBe(1);
    expect(activity[0]).toMatchObject({ kind: 'anomaly', detail: 'modify_liquidity' });
  });

  it('records the completion latch and the migration as activity (graduation step B)', () => {
    const { state: start } = genesisResult();
    const header = fakeHeader(1, T.openBlock + 50n, fakeHash(1, T.openBlock + 49n), 1_790_742_000n);
    const base = { blockNumber: header.number, blockHash: header.hash, transactionHash: txHash(9), transactionIndex: 0 };
    const latch = {
      ...base,
      logIndex: 1,
      address: T.hook,
      topics: encodeEventTopics({ abi: launchEventsAbi, eventName: 'CurveCompleted' }) as Hex[],
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint160' }], [header.number, 4_295_128_740n]),
    };
    const migrated = {
      ...base,
      logIndex: 2,
      address: T.hook,
      topics: encodeEventTopics({ abi: launchEventsAbi, eventName: 'Migrated', args: { poolId: T.poolId } }) as Hex[],
      data: encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint256' }, { type: 'uint256' }],
        [4_206_980_085_000_000_000n, 0n, 1n, 2n, 3n, 5n, 0n],
      ),
    };
    const { activity } = applyBlock(start, header, decodeBlockLogs([latch, migrated], T), new Map(), ctx);
    expect(activity.map((a) => `${a.kind}:${a.detail}`)).toEqual([`curve_completed:${header.number}`, 'migration:bid:1,sentinel:2,ask:3']);
    expect(activity[1]).toMatchObject({ amountRaw: 5n, ethRaw: 4_206_980_085_000_000_000n });
  });

  // Review 2026-09-30 (the indexer before any graduated deployment): a launch phase derived from the hook's events,
  // and the migration's own liquidity logs and later outside liquidity are not anomalies.
  const hookLog = (header: BlockHeader, tx: Hex, logIndex: number, eventName: 'CurveCompleted' | 'CurveReopened', block: bigint) => ({
    blockNumber: header.number,
    blockHash: header.hash,
    transactionHash: tx,
    transactionIndex: 0,
    logIndex,
    address: T.hook,
    topics: encodeEventTopics({ abi: launchEventsAbi, eventName }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint160' }], [block, 4_295_128_740n]),
  });
  const migratedLog = (header: BlockHeader, tx: Hex, logIndex: number) => ({
    blockNumber: header.number,
    blockHash: header.hash,
    transactionHash: tx,
    transactionIndex: 0,
    logIndex,
    address: T.hook,
    topics: encodeEventTopics({ abi: launchEventsAbi, eventName: 'Migrated', args: { poolId: T.poolId } }) as Hex[],
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint256' }, { type: 'uint256' }],
      [4_206_980_085_000_000_000n, 0n, 1n, 2n, 3n, 5n, 0n],
    ),
  });
  const liquidityLog = (header: BlockHeader, tx: Hex, logIndex: number, sender: Address, lower: number, upper: number, delta: bigint, salt: Hex) => ({
    blockNumber: header.number,
    blockHash: header.hash,
    transactionHash: tx,
    transactionIndex: 0,
    logIndex,
    address: T.poolManager,
    topics: encodeEventTopics({ abi: poolManagerEventsAbi, eventName: 'ModifyLiquidity', args: { id: T.poolId, sender } }) as Hex[],
    data: encodeAbiParameters([{ type: 'int24' }, { type: 'int24' }, { type: 'int256' }, { type: 'bytes32' }], [lower, upper, delta, salt]),
  });
  const SALT0 = `0x${'00'.repeat(32)}` as Hex;
  const SALT1 = `0x${'00'.repeat(31)}01` as Hex;
  const positionManager: Address = '0x000000000000000000000000000000000000beef';

  it('derives the launch phase from the hook: completed, reopened, completed again, migrated (never "sold out")', () => {
    const { state: s0 } = genesisResult();
    expect(s0).toMatchObject({ phase: 'curve', completedBlock: null, migratedBlock: null });
    const h1 = fakeHeader(1, T.openBlock + 60n, fakeHash(1, T.openBlock + 59n), 1_790_743_000n);
    const r1 = applyBlock(s0, h1, decodeBlockLogs([hookLog(h1, txHash(11), 1, 'CurveCompleted', h1.number - 1n)], T), new Map(), ctx);
    expect(r1.state).toMatchObject({ phase: 'completed', completedBlock: h1.number - 1n, migratedBlock: null });
    const h2 = fakeHeader(1, h1.number + 5n, fakeHash(1, h1.number + 4n), 1_790_743_060n);
    const r2 = applyBlock(r1.state, h2, decodeBlockLogs([hookLog(h2, txHash(12), 1, 'CurveReopened', h2.number - 2n)], T), new Map(), ctx);
    expect(r2.state).toMatchObject({ phase: 'curve', completedBlock: null });
    expect(r2.activity.map((a) => `${a.kind}:${a.detail}`)).toEqual([`curve_reopened:${h2.number - 2n}`]);
    const h3 = fakeHeader(1, h2.number + 3n, fakeHash(1, h2.number + 2n), 1_790_743_100n);
    const r3 = applyBlock(r2.state, h3, decodeBlockLogs([hookLog(h3, txHash(13), 1, 'CurveCompleted', h3.number - 1n)], T), new Map(), ctx);
    const h4 = fakeHeader(1, h3.number + 32n, fakeHash(1, h3.number + 31n), 1_790_743_500n);
    const r4 = applyBlock(r3.state, h4, decodeBlockLogs([migratedLog(h4, txHash(14), 9)], T), new Map(), ctx);
    expect(r4.state).toMatchObject({ phase: 'migrated', completedBlock: h3.number - 1n, migratedBlock: h4.number });
  });

  it('does not count the migration\'s own liquidity logs, or outside liquidity once it opens, as anomalies', () => {
    const { state: s0 } = genesisResult();
    const h1 = fakeHeader(1, T.openBlock + 100n, fakeHash(1, T.openBlock + 99n), 1_790_744_000n);
    const tx = txHash(21);
    // M1 (the curve out, salt 0), M3 (bid, sentinel, ask with salt 1), then Migrated: one transaction.
    const migration = [
      liquidityLog(h1, tx, 1, T.hook, 177_180, 204_060, -(10n ** 22n), SALT0),
      liquidityLog(h1, tx, 2, T.hook, 177_180, 204_060, 10n ** 22n, SALT1),
      liquidityLog(h1, tx, 3, T.hook, 204_060, 887_220, 10n ** 21n, SALT1),
      liquidityLog(h1, tx, 4, T.hook, -887_220, 177_180, 10n ** 22n, SALT1),
      migratedLog(h1, tx, 5),
    ];
    const r1 = applyBlock(s0, h1, decodeBlockLogs(migration, T), new Map(), ctx);
    expect(r1.state).toMatchObject({ phase: 'migrated', migratedBlock: h1.number, anomalies: 0 });
    // An outside add before the pool opens (the hook refuses it, so seeing one is an anomaly).
    const h2 = fakeHeader(1, h1.number + 31n, fakeHash(1, h1.number + 30n), 1_790_744_400n);
    const early = [liquidityLog(h2, txHash(22), 1, positionManager, 176_400, 177_960, 10n ** 18n, SALT0)];
    const r2 = applyBlock(r1.state, h2, decodeBlockLogs(early, T), new Map(), ctx);
    expect(r2.state.anomalies).toBe(1);
    // From migration + 32 outside adds and removals are ordinary.
    const h3 = fakeHeader(1, h1.number + 32n, fakeHash(1, h1.number + 31n), 1_790_744_412n);
    const open = [
      liquidityLog(h3, txHash(23), 1, positionManager, 176_400, 177_960, 10n ** 18n, SALT0),
      liquidityLog(h3, txHash(24), 2, positionManager, 176_400, 177_960, -(10n ** 18n), SALT0),
    ];
    const r3 = applyBlock(r2.state, h3, decodeBlockLogs(open, T), new Map(), ctx);
    expect(r3.state.anomalies).toBe(1);
    // A hook liquidity change outside the migration transaction still is one.
    const h4 = fakeHeader(1, h3.number + 1n, fakeHash(1, h3.number), 1_790_744_424n);
    const r4 = applyBlock(r3.state, h4, decodeBlockLogs([liquidityLog(h4, txHash(25), 1, T.hook, 177_180, 204_060, -1n, SALT1)], T), new Map(), ctx);
    expect(r4.state.anomalies).toBe(2);
  });

  it('refuses a block that does not follow the state, or logs of another block', () => {
    const { state } = genesisResult();
    const older = { ...fakeHeader(1, T.deployBlock, fakeHash(1, 0n), 0n) };
    expect(() => applyBlock(state, older, [], new Map(), ctx)).toThrow(RangeError);
    const header = fakeHeader(1, T.deployBlock + 1n, fakeHash(1, T.deployBlock), 0n);
    const foreign = decodeBlockLogs(fixture.logs.filter((l) => l.blockNumber === T.deployBlock), T);
    expect(() => applyBlock(state, header, foreign, new Map(), ctx)).toThrow(/expected/);
  });
});
