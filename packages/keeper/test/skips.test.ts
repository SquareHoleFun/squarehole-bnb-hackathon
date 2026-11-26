import { DEFERRAL_CODES, deferralCode, formatDeferral, logSkips } from '../src/skips';
import { decodeState, encodeState } from '../src/state';
/**
 * Review round 1, finding M4: a keeper that sends nothing must say why. Each (job, reason) skip is logged at most once
 * an hour with how many it left out; a simulation's transport failure is logged apart from a revert; a send error is
 * logged every time; a keeper without a private endpoint says so at start.
 */
import { describe, expect, it } from 'vitest';
import { ViemChain } from '../src/chain';
import { loadConfig, startupWarnings } from '../src/config';
import { feesFor } from '../src/gas';
import type { Logger } from '../src/log';
import { seededRng } from '../src/rng';
import { runTick, type ChainPort, type KeeperState, type RunConfig } from '../src/run';
import type { Candidate, Sim } from '../src/types';
import type { World } from '../src/world';
import { REVERT, fakeClient, fakeNode } from './support/fake-rpc';

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as const;
const T0 = 1_791_302_405n;
const cfg: RunConfig = {
  keeper: addr(0xbeef), dryRun: false, privateEndpoint: false, priorityFeeWei: 10n ** 8n,
  limits: { oursWeiPerDay: 10n ** 17n, pokesWeiPerDay: 10n ** 17n, reserveWeiPerDay: 0n, totalWeiPerDay: 10n ** 18n, maxTxPerBlock: 4 },
  payoutMinWei: 1n, rng: seededRng(1),
};

function recorder() {
  const lines: { level: string; msg: string; data?: Record<string, unknown> }[] = [];
  const log: Logger = {
    info: (msg, data) => lines.push({ level: 'info', msg, data }),
    warn: (msg, data) => lines.push({ level: 'warn', msg, data }),
    error: (msg, data) => lines.push({ level: 'error', msg, data }),
  };
  return { lines, log };
}

const world = (block: bigint, over: Partial<World> = {}): World => ({
  block: { number: block, timestamp: T0 + block * 12n, baseFeePerGas: 10n ** 9n }, fitGraduated: true, boxes: [{ id: 0n, version: 1, coordinator: addr(1), hook: addr(2), receiver: addr(3),
    priceSource: null, graduated: false, failed: true, curveClosed: false, gateOpen: true, openAt: 0n, deadline: 0n,
    spotTick: null, sampleTick: null, checkpointTime: 0n, fitOwed: 0n, platformOwed: 5n,
    qPerEthX18: 10n ** 18n }], ...over,
});

async function run(blocks: number, port: (block: bigint) => ChainPort, log: Logger) {
  let state: KeeperState = {};
  for (let i = 1; i <= blocks; i++) state = (await runTick(port(BigInt(i)), state, cfg, log)).state;
  return state;
}

const ok = async (): Promise<Sim> => ({ ok: true, tipWei: null, estimate: 80_000n });

describe('skips are logged (review round 1, M4)', () => {
  it('logs each (job, reason) skip at most once an hour, with how many it left out', async () => {
    const { lines, log } = recorder();
    await run(400, (b) => ({ read: async () => world(b), simulate: async () => ({ ok: false, tipWei: null, estimate: 0n }), send: async () => '0x01' }), log);
    const skips = lines.filter((l) => l.msg === 'skipped' && l.data?.job === 'receiverPayPlatform');
    expect(skips.map((l) => [l.level, l.data?.code])).toEqual([['info', 'NO_WORK'], ['info', 'NO_WORK']]);
    expect(skips[1]?.data?.repeats).toBe(299);
  });

  it('logs a simulation\'s transport failure apart from nothing to do', async () => {
    const { lines, log } = recorder();
    const simulate = async (): Promise<Sim> => {
      throw new Error('pending block tag not supported');
    };
    await run(1, (b) => ({ read: async () => world(b), simulate, send: async () => '0x01' }), log);
    const line = lines.find((l) => l.msg === 'skipped');
    expect([line?.level, line?.data?.job, line?.data?.code]).toEqual(['warn', 'receiverPayPlatform', 'SIMULATION_ERROR']);
    expect(line?.data).toEqual({ boxId: '0', job: 'receiverPayPlatform', code: 'SIMULATION_ERROR', repeats: 0 });
  });

  it('logs every send error', async () => {
    const { lines, log } = recorder();
    const send = async (): Promise<string> => {
      throw new Error('insufficient funds');
    };
    await run(3, (b) => ({ read: async () => world(b), simulate: ok, send }), log);
    expect(lines.filter((l) => l.level === 'error' && l.msg === 'send failed')).toHaveLength(3);
  });

  it('reads a revert as nothing to do, and throws on a transport failure', async () => {
    const node = fakeNode();
    const keeper = addr(0xbeef);
    const chain = new ViemChain(loadConfig({ SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216', SH_KEEPER_RPC_URL: 'http://fake.invalid' }), fakeClient(node), keeper, { public: null, private: null }, null, recorder().log);
    const poke: Candidate = { job: 'poke', key: 'poke:5', to: addr(5), fn: 'poke', args: [] };
    const fees = feesFor(10n ** 9n, 10n ** 8n);
    node.calls[`${addr(5)}:poke`] = () => 12;
    expect(await chain.simulate(poke, fees)).toMatchObject({ ok: true, estimate: 100_000n });
    node.calls[`${addr(5)}:poke`] = () => {
      throw REVERT;
    };
    expect((await chain.simulate(poke, fees)).ok).toBe(false);
    node.calls[`${addr(5)}:poke`] = () => {
      throw new Error('connection refused');
    };
    await expect(chain.simulate(poke, fees)).rejects.toThrow(/connection refused/);
  });

  it('warns explicitly that CQ11 gas calibration is provisional', () => {
    const base = { SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216', SH_KEEPER_RPC_URL: 'https://rpc.example.invalid' };
    expect(startupWarnings(loadConfig(base))).toEqual([]);
    expect(startupWarnings(loadConfig({ ...base, SH_KEEPER_BOX_REGISTRY: addr(9) }))).toEqual([expect.stringMatching(/FINAL2-GAS/)]);
  });
});

describe('SH-236 safe per-box reasons', () => {
  it('logs two boxes independently each hour, and separates jobs and codes across restart', () => {
    const { log, lines } = recorder();
    const skips = [5n, 6n].map(boxId => ({ boxId, job: 'collect', code: 'BOX_INCOME_CAP' as const }));
    let state = logSkips(undefined, skips, 1n, log);
    state = logSkips(state, skips, 3600n, log);
    expect(lines).toHaveLength(2);
    state = decodeState(encodeState({ skipLog: state }, 'id'), 'id').skipLog ?? {};
    state = logSkips(state, skips, 3601n, log);
    expect(lines.map(l => l.data)).toEqual([
      { boxId: '5', job: 'collect', code: 'BOX_INCOME_CAP', repeats: 0 },
      { boxId: '6', job: 'collect', code: 'BOX_INCOME_CAP', repeats: 0 },
      { boxId: '5', job: 'collect', code: 'BOX_INCOME_CAP', repeats: 1 },
      { boxId: '6', job: 'collect', code: 'BOX_INCOME_CAP', repeats: 1 },
    ]);
    state = logSkips(state, [{ ...skips[0], boxId: 5n, job: 'buyBack', code: 'BOX_INCOME_CAP' },
      { boxId: 5n, job: 'collect', code: 'PLATFORM_INCOME_CAP' }], 3602n, log);
    expect(lines).toHaveLength(6);
    expect(logSkips(state, [], 7202n, log)).toEqual({});
  });
  it('accepts old throttle journals without resetting their monetary liability', () => {
    const state = decodeState(encodeState({ skipLog: { 'collect|box income cap': { at: 1n, repeats: 8 } },
      incomeSpend: [{ box: addr(9), at: 1n, costWei: 88n }] }, 'id'), 'id');
    const { log, lines } = recorder();
    logSkips(state.skipLog, [{ boxId: 5n, job: 'collect', code: 'BOX_INCOME_CAP' }], 2n, log);
    expect(lines).toHaveLength(1);
    expect(state.incomeSpend?.[0]?.costWei).toBe(88n);
  });
  it('only emits validated fields and maps hostile or unknown text to OTHER', () => {
    const hostile = '0x1234567890123456789012345678901234567890 https://rpc.invalid/key\nsecret';
    expect(deferralCode(hostile)).toBe('OTHER');
    expect(deferralCode('gas admission: ' + hostile)).toBe('OTHER');
    expect(deferralCode('__proto__')).toBe('OTHER');
    const line = formatDeferral({ boxId: 5n, job: 'collect', code: hostile, repeats: 0, key: hostile, error: new Error(hostile) });
    expect(line).toBe('keeper: box=5 job=collect reason=OTHER repeats=0');
    expect(formatDeferral({ boxId: hostile, job: hostile, code: {}, repeats: hostile })).toBe('keeper: box=unknown job=unknown reason=OTHER repeats=0');
    for (const code of DEFERRAL_CODES) expect(formatDeferral({ boxId: 5n, job: 'collect', code })).toBe(`keeper: box=5 job=collect reason=${code} repeats=0`);
  });
});

it('maps the three produced F182 reasons to their finite codes', () => {
  expect(['start unpaid', 'start tip too small', 'start cost cap'].map(deferralCode))
    .toEqual(['START_UNPAID', 'START_TIP_TOO_SMALL', 'START_COST_CAP']);
});
