import { describe, expect, it } from 'vitest';
import { toHex, type Address, type Hex, type PublicClient } from 'viem';
import { ViemChain, interpret } from '../src/chain';
import { loadConfig } from '../src/config';
import { openBudget, settle, type Budget } from '../src/decide';
import { runTick, type ChainPort, type KeeperState } from '../src/run';
import { decodeState, encodeState } from '../src/state';
import type { World } from '../src/world';
import { seededRng } from '../src/rng';
import { addr, box, keeper, options, quiet, time, v2 } from './support/v2';

// Second release review (RC6RR2-HP-2): every send is reserved at its whole signed limit times its maximum fee, and our
// keeper never released that reservation, so at a 1 gwei base fee one press took a third or more of the ordinary day.
// A reservation is now settled to what the send paid once its receipt is final and canonical.
const GWEI = 1_000_000_000n;
const FINALITY = 64n;
const production = () => ({ ...loadConfig({ SH_KEEPER_RPC_URL: 'http://fake.invalid', SH_KEEPER_DESTINATION_FORK: 'osaka',
  SH_KEEPER_TRANSACTION_GAS_CAP: '16777216' }), keeper, privateEndpoint: false, dryRun: false, rng: seededRng(2) });
const hashOf = (n: number) => toHex(BigInt(n), { size: 32 });

describe('RC6RR2-HP-2: reservations settle to what final receipts paid', () => {
  const day = (over: Partial<Budget> = {}): Budget => ({ ...openBudget(undefined, 1n, time), ...over });
  it('releases a final send down to its paid wei on every counter it was charged to, and keeps the rest reserved', () => {
    const b = day({ oursWei: 30n, pokesWei: 7n, totalWei: 47n, unblockingWei: 10n, unblockingWeiByBox: { [addr(3)]: 10n },
      pending: [{ costWei: 20n, ours: 'ours', hash: hashOf(1) }, { costWei: 10n, ours: 'ours', box: addr(3), hash: hashOf(2) },
        { costWei: 7n, ours: 'pokes', hash: hashOf(3) }, { costWei: 10n, hash: hashOf(4) }, { costWei: 1n }] });
    const s = settle(b, { [hashOf(1)]: 5n, [hashOf(2)]: 4n, [hashOf(3)]: 7n, [hashOf(4)]: 11n });
    // hash 4 claims more than its signed maximum: not a settlement of this reservation; it stays.
    expect(s).toMatchObject({ oursWei: 30n - 15n - 6n, pokesWei: 7n, totalWei: 47n - 15n - 6n, unblockingWei: 4n,
      unblockingWeiByBox: { [addr(3)]: 4n } });
    expect(s.pending).toEqual([{ costWei: 10n, hash: hashOf(4) }, { costWei: 1n }]);
    expect(settle(s, {})).toEqual(s);
    // Persisted with the journal; a new UTC day starts empty.
    expect(decodeState(encodeState({ budget: b }, 't'), 't').budget).toEqual(b);
    expect(openBudget(b, 2n, time + 86_400n).pending).toBeUndefined();
  });

  it('a 1 gwei day gets consecutive presses in a conversion series and still fits a second box\'s collect and deepen', async () => {
    const A = box({ id: 1n, hook: addr(0x21), receiver: addr(0x31), coordinator: addr(0x11), v2: { ...v2, buyBackP: 0n, depthBudget: 0n } });
    const B = box({ id: 2n, hook: addr(0x22), receiver: addr(0x32), coordinator: addr(0x12), v2: { ...v2, buyBackP: 0n, depthBudget: 10n ** 18n } });
    const at = (block: bigint): World => ({ block: { number: block, timestamp: time + (block - 100n) * 12n, baseFeePerGas: GWEI },
      fitGraduated: false, boxes: [A, B] });
    let w = at(100n);
    const estimates: Record<string, bigint> = { sellFees: 1_500_000n, deepen: 900_000n, collect: 700_000n };
    const sends = new Map<string, { block: bigint; paid: bigint }>();
    const log: { block: bigint; job: string; box: bigint | undefined }[] = [];
    // Box B wants one collect and one deepen today; box A's conversion series wants a press on every turn.
    const once = (job: string) => log.every(s => s.job !== job || s.box !== 2n);
    const port: ChainPort = {
      read: async () => w,
      readIncome: async () => ({ at: w.block.timestamp, platformWei: 10n ** 30n, mined: {},
        boxes: { [A.receiver]: { shareWei: 10n ** 30n, tipsWei: 0n }, [B.receiver]: { shareWei: 10n ** 30n, tipsWei: 0n } } }),
      simulate: async c => c.job === 'sellFees' && c.to === A.hook
        ? { ...interpret(c, [0, 10n ** 20n, 10n ** 16n, 5n * 10n ** 14n], 10n ** 18n), estimate: estimates.sellFees ?? 0n }
        : ((c.job === 'deepen' && c.to === B.hook) || (c.job === 'collect' && c.to === B.receiver)) && once(c.job)
          ? { ok: true, tipWei: 0n, estimate: estimates[c.job] ?? 0n } : { ok: false, tipWei: null, estimate: 0n },
      send: async c => {
        const hash = hashOf(sends.size + 1);
        // What the node charges: the estimate at the base fee plus the priority fee, never the signed maximum.
        sends.set(hash, { block: w.block.number, paid: (estimates[c.job] ?? 0n) * (GWEI + 50_000_000n) });
        log.push({ block: w.block.number, job: c.job, box: c.boxId });
        return hash;
      },
      settled: async hashes => Object.fromEntries(hashes.flatMap(h => {
        const s = sends.get(h);
        return s && w.block.number >= s.block + FINALITY ? [[h, s.paid]] : [];
      })),
    };
    let state: KeeperState = {};
    for (let block = 100n; block < 400n; block++) {
      w = at(block);
      state = (await runTick(port, state, production(), quiet)).state;
    }
    const presses = log.filter(s => s.job === 'sellFees').map(s => s.block);
    expect(presses.some((b, i) => presses[i + 1] === b + 1n), `consecutive presses: ${presses.join(',')}`).toBe(true);
    expect(log.filter(s => s.job === 'collect' && s.box === 2n)).toHaveLength(1);
    expect(log.filter(s => s.job === 'deepen' && s.box === 2n)).toHaveLength(1);
    // Two presses a finality window once the first reservations settle: 1 + 2 + 2 + 2 + 2 in 300 blocks.
    expect(presses.length).toBeGreaterThanOrEqual(9);
    // The day's counters never exceed the ceilings, and settled sends count at what they paid.
    const limits = production().limits;
    expect(state.budget?.oursWei).toBeLessThanOrEqual(limits.oursWeiPerDay - limits.reserveWeiPerDay);
    expect(state.budget?.totalWei).toBeLessThanOrEqual(limits.totalWeiPerDay - limits.reserveWeiPerDay);
  });

  it('a send the node never confirmed, or a dry run, stays reserved at its signed maximum', async () => {
    const A = box({ v2: { ...v2, buyBackP: 0n, depthBudget: 0n } });
    const w: World = { block: { number: 100n, timestamp: time, baseFeePerGas: GWEI }, fitGraduated: false, boxes: [A] };
    const port: ChainPort = { read: async () => w, readIncome: async () => ({ at: time, platformWei: 10n ** 30n, mined: {},
      boxes: { [A.receiver]: { shareWei: 10n ** 30n, tipsWei: 0n } } }),
      simulate: async c => c.job === 'sellFees' ? { ...interpret(c, [0, 1n, 1n, 0n], null), estimate: 1_000_000n } : { ok: false, tipWei: null, estimate: 0n },
      send: async () => { throw new Error('accepted, then timed out'); }, settled: async hashes => Object.fromEntries(hashes.map(h => [h, 1n])) };
    const out = await runTick(port, {}, production(), quiet);
    expect(out.state.budget.pending).toEqual([{ costWei: 8_200_000n * 2_050_000_000n, ours: 'ours' }]);
    const dry = await runTick({ ...port, send: async () => hashOf(9) }, {}, { ...production(), dryRun: true }, quiet);
    expect(dry.state.budget.pending).toEqual([{ costWei: 8_200_000n * 2_050_000_000n, ours: 'ours' }]);
  });
});

describe('ViemChain.settled reads only final, canonical receipts this keeper sent', () => {
  it('returns gasUsed times the effective price, and nothing it cannot prove', async () => {
    const final = { number: 1_000n, hash: hashOf(0xf1) };
    const receipts: Record<string, Record<string, unknown>> = {
      [hashOf(1)]: { blockNumber: 900n, blockHash: hashOf(0xb9), gasUsed: 700_000n, effectiveGasPrice: 1_050_000_000n, from: keeper },
      [hashOf(2)]: { blockNumber: 1_001n, blockHash: hashOf(0xba), gasUsed: 1n, effectiveGasPrice: 1n, from: keeper },
      [hashOf(3)]: { blockNumber: 900n, blockHash: hashOf(0xbb), gasUsed: 1n, effectiveGasPrice: 1n, from: keeper },
      [hashOf(4)]: { blockNumber: 900n, blockHash: hashOf(0xb9), gasUsed: 1n, effectiveGasPrice: 0n, from: keeper },
      [hashOf(5)]: { blockNumber: 900n, blockHash: hashOf(0xb9), gasUsed: 1n, effectiveGasPrice: 1n, from: addr(77) },
    };
    const client = {
      getChainId: async () => 11155111,
      getBlock: async (args: { blockTag?: string; blockNumber?: bigint }) => args.blockTag === 'finalized' ? final
        : args.blockNumber === 900n ? { number: 900n, hash: hashOf(0xb9) } : { number: args.blockNumber, hash: final.hash },
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        const r = receipts[hash]; if (!r) throw new Error('not found');
        return { ...r, transactionHash: hash };
      },
    } as unknown as PublicClient;
    const chain = new ViemChain({ ...options() }, client, keeper as Address, { public: null, private: null }, null, quiet);
    expect(await chain.settled([1, 2, 3, 4, 5, 6].map(hashOf))).toEqual({ [hashOf(1)]: 700_000n * 1_050_000_000n });
  });
});
