import { encodeAbiParameters, encodeEventTopics, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { bloomContains, bloomQuery } from '../src/bloom';
import { SEPOLIA_REHEARSAL } from '../src/config';
import { decodeBlockLogs, decodePoolLog, LAUNCH_TOPICS, launchEventsAbi, TOPICS, type RawLog } from '../src/events';
import { LAUNCH_TAX_TABLE_PIPS } from '../src/shape';
import { loadRecordedFixture } from './scripted-chain';

const T = SEPOLIA_REHEARSAL;
const fixture = loadRecordedFixture();
const genesisLogs = fixture.logs.filter((l) => l.blockNumber === T.deployBlock);

describe('decoding the recorded Sepolia genesis transaction', () => {
  const events = decodeBlockLogs(genesisLogs, T);
  const kinds = events.map((e) => e.kind);

  it('finds every pool and launch event in log order', () => {
    expect(kinds).toEqual([
      'transfer', // mint of the issuance to the genesis
      'other', // Approval
      'initialize',
      'modify_liquidity', // the seed
      'transfer', // seed tokens into the PoolManager
      'pool_launched',
      'other', // Approval
      'swap', // bootstrap buy
      'modify_liquidity', // Δ0 fee collection by the hook
      'fees_realised',
      'transfer', // bootstrap tokens to the genesis
      'bootstrapped',
      'transfer', // burned
      'window_announced',
      'other', // RehearsalGenesis
    ]);
    for (let i = 1; i < events.length; i += 1) expect(events[i]?.ref.logIndex).toBeGreaterThan(events[i - 1]?.ref.logIndex ?? -1);
  });

  it('keeps the swap sign trap straight: a buy has amount0 < 0 (ETH in) and amount1 > 0 (tokens out)', () => {
    const swap = events.find((e) => e.kind === 'swap');
    if (swap?.kind !== 'swap') throw new Error('no swap');
    expect(swap.amount0).toBe(-1_500_000_000_000_000n);
    expect(swap.amount1).toBe(1_079_104_076_324_374_082_820_149n);
    expect(swap.sender.toLowerCase()).toBe(T.launchRouter.toLowerCase()); // the router, not the wallet
    expect(swap.feePips).toBe(10_000);
    expect(swap.liquidity).toBe(40_128_552_009_550_614_593_458n);
  });

  it('reads the fee collection as Δ0 from the hook, the seed as the one positive Δ', () => {
    const modifies = events.filter((e) => e.kind === 'modify_liquidity');
    expect(modifies.map((m) => (m.kind === 'modify_liquidity' ? m.liquidityDelta : null))).toEqual([40_128_552_009_550_614_593_458n, 0n]);
    for (const m of modifies) if (m.kind === 'modify_liquidity') expect(m.sender.toLowerCase()).toBe(T.hook.toLowerCase());
  });

  it('reads the announced window and the burn', () => {
    const window = events.find((e) => e.kind === 'window_announced');
    expect(window).toMatchObject({ openBlock: 11_812_074n, closeBlock: 11_812_106n });
    expect(T.openBlock).toBe(11_812_074n);
    expect(T.closeBlock).toBe(11_812_106n);
    const burns = events.filter((e) => e.kind === 'transfer' && e.to === '0x0000000000000000000000000000000000000000');
    expect(burns).toHaveLength(1);
    expect(burns[0]).toMatchObject({ amount: 1_079_104_076_324_374_082_820_149n });
  });

  it('agrees with the live router on the tax table (taxTable() read at recording time)', () => {
    expect(fixture.taxTable).toEqual([...LAUNCH_TAX_TABLE_PIPS]);
    expect(LAUNCH_TAX_TABLE_PIPS).toHaveLength(32);
  });

  it('ignores another pool, and a known event name from the wrong contract', () => {
    const swapLog = genesisLogs.find((l) => l.topics[0] === TOPICS.Swap) as RawLog;
    const otherPool: RawLog = { ...swapLog, topics: [swapLog.topics[0] as Hex, `0x${'ab'.repeat(32)}` as Hex, swapLog.topics[2] as Hex] };
    expect(decodePoolLog(otherPool, T)).toBeNull();
    const transfer = genesisLogs.find((l) => l.address.toLowerCase() === T.token.toLowerCase()) as RawLog;
    expect(decodePoolLog({ ...transfer, address: T.collector }, T)).toBeNull();
    expect(decodePoolLog({ ...transfer, address: '0x000000000000000000000000000000000000dEaD' }, T)).toBeNull();
    expect(decodePoolLog({ ...transfer, removed: true }, T)).toBeNull();
    const fees = encodeEventTopics({ abi: launchEventsAbi, eventName: 'PoolFeesRealised', args: { poolId: `0x${'cd'.repeat(32)}` } }) as Hex[];
    expect(decodePoolLog({ ...transfer, address: T.hook, topics: fees, data: `0x${'0'.repeat(128)}` }, T)).toBeNull();
  });

  it('decodes the graduation events of the hook (CurveCompleted, Migrated) with raw bigints', () => {
    const base = genesisLogs[0] as RawLog;
    const latch: RawLog = {
      ...base,
      address: T.hook,
      topics: encodeEventTopics({ abi: launchEventsAbi, eventName: 'CurveCompleted' }) as Hex[],
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint160' }], [26_055_300n, 4_295_128_740n]),
    };
    expect(decodePoolLog(latch, T)).toMatchObject({ kind: 'curve_completed', completedBlock: 26_055_300n, sqrtPriceX96: 4_295_128_740n });
    const migrated: RawLog = {
      ...base,
      address: T.hook,
      topics: encodeEventTopics({ abi: launchEventsAbi, eventName: 'Migrated', args: { poolId: T.poolId } }) as Hex[],
      data: encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint256' }, { type: 'uint256' }],
        [4_206_980_085_000_000_000n, 0n, 39_634_799_753_200_128_742_328n, 1_134_633_271_438_127_274_922n, 28_696_714_735_121_197_504_483n, 201_862_030_679_196_583_428_033_132n, 0n],
      ),
    };
    expect(decodePoolLog(migrated, T)).toMatchObject({
      kind: 'migrated',
      ethFromCurve: 4_206_980_085_000_000_000n,
      askLiquidity: 28_696_714_735_121_197_504_483n,
      tokenPulled: 201_862_030_679_196_583_428_033_132n,
    });
    // From any other contract, or for another pool, they are not ours.
    expect(decodePoolLog({ ...latch, address: T.collector }, T)).toBeNull();
    const otherPool = encodeEventTopics({ abi: launchEventsAbi, eventName: 'Migrated', args: { poolId: `0x${'cd'.repeat(32)}` } }) as Hex[];
    expect(decodePoolLog({ ...migrated, topics: otherPool }, T)).toBeNull();
    expect(LAUNCH_TOPICS.CurveCompleted).toBe(latch.topics[0]);
    expect(LAUNCH_TOPICS.Migrated).toBe(migrated.topics[0]);
  });

  it('decodes CurveReopened (a completed curve reopened by a block end, review 2026-09-30) from the hook only', () => {
    const base = genesisLogs[0] as RawLog;
    const reopened: RawLog = {
      ...base,
      address: T.hook,
      topics: encodeEventTopics({ abi: launchEventsAbi, eventName: 'CurveReopened' }) as Hex[],
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint160' }], [26_055_310n, 574_288_637_983_682_666_264_510_264_346_944n]),
    };
    expect(decodePoolLog(reopened, T)).toMatchObject({ kind: 'curve_reopened', reopenedBlock: 26_055_310n, sqrtPriceX96: 574_288_637_983_682_666_264_510_264_346_944n });
    expect(decodePoolLog({ ...reopened, address: T.collector }, T)).toBeNull();
    expect(LAUNCH_TOPICS.CurveReopened).toBe(reopened.topics[0]);
  });

  it('dedupes a log returned twice', () => {
    expect(decodeBlockLogs([...genesisLogs, ...genesisLogs], T)).toHaveLength(events.length);
  });
});

describe('logs bloom', () => {

  it('never rules out a block that has our logs (recorded Sepolia headers)', () => {
    const withLogs = new Set(fixture.logs.map((l) => l.blockHash));
    for (const header of fixture.headers.filter((h) => withLogs.has(h.hash))) {
      expect(header.logsBloom).toBeDefined();
      const query = bloomQuery(header.logsBloom, T);
      expect(query).toEqual({ pool: true, contracts: true });
      for (const log of fixture.logs.filter((l) => l.blockHash === header.hash)) {
        expect(bloomContains(header.logsBloom as Hex, log.address)).toBe(true);
        for (const topic of log.topics) expect(bloomContains(header.logsBloom as Hex, topic)).toBe(true);
      }
    }
  });

  it('rules out most recorded blocks without our logs (no getLogs needed)', () => {
    const withLogs = new Set(fixture.logs.map((l) => l.blockHash));
    const empty = fixture.headers.filter((h) => !withLogs.has(h.hash) && h.logsBloom);
    const skipped = empty.filter((h) => {
      const q = bloomQuery(h.logsBloom, T);
      return !q.pool && !q.contracts;
    });
    expect(empty.length).toBeGreaterThan(50);
    expect(skipped.length / empty.length).toBeGreaterThan(0.9);
  });

  it('asks for everything when a header carries no bloom', () => {
    expect(bloomQuery(undefined, T)).toEqual({ pool: true, contracts: true });
    expect(() => bloomContains('0x00', T.token)).toThrow(RangeError);
  });
});
