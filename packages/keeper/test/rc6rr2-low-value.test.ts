import { describe, expect, it } from 'vitest';
import { toHex, type Address, type Hex, type PublicClient } from 'viem';
import { ViemChain, interpret } from '../src/chain';
import { emptyMemory, plan } from '../src/plan';
import { runTick, type ChainPort } from '../src/run';
import type { World } from '../src/world';
import { addr, box, options, quiet, time, v2, world } from './support/v2';

// RC6RR2-HP-3 / SH-RC7-HOOK-PAGE: a griefer can put more than 32 sources worth a few raw P ahead of real value.
// A page now ends after 32 such sources and can still sell below STEP_MIN_Q / 100; the unblocking rule stays.
const candidate = (w: World, job: string) => plan(w, emptyMemory(), options()).candidates.find(c => c.job === job);

describe('RC6RR2-HP-3: a press that sells less than a hundredth of the box\'s step minimum is unblocking work', () => {
  const STEP_MIN_Q = 5_000_000_000_000_000n;
  const press = () => { const c = candidate(world(box({ v2: { ...v2, buyBackP: 0n, depthBudget: 0n, stepMinQ: STEP_MIN_Q } })), 'sellFees');
    if (!c) throw new Error('press missing'); return c; };
  it('carries the threshold and marks a 42 raw P page, but not one at the threshold or a box with no known minimum', () => {
    expect(press().lowValueBelow).toBe(STEP_MIN_Q / 100n);
    expect(interpret(press(), [0, 16_706_585_120n, 42n, 2n], 10n ** 18n)).toMatchObject({ ok: true, tipWei: 2n, unblocking: true });
    expect(interpret(press(), [0, 1n, STEP_MIN_Q / 100n, 1n], 10n ** 18n).unblocking).toBeUndefined();
    const unknown = candidate(world(box({ v2: { ...v2, buyBackP: 0n, depthBudget: 0n } })), 'sellFees');
    if (!unknown) throw new Error('press missing');
    expect(interpret(unknown, [0, 1n, 42n, 2n], 10n ** 18n).unblocking).toBeUndefined();
  });
  it('sends such a press in a box with no income, at the positive-P floor, since it pays a tip', async () => {
    const w = world(box({ v2: { ...v2, buyBackP: 0n, depthBudget: 0n, stepMinQ: STEP_MIN_Q } }));
    const port: ChainPort = { read: async () => w, send: async () => `0x${'34'.repeat(32)}`,
      readIncome: async () => ({ at: w.block.timestamp, platformWei: 10n ** 30n, boxes: {}, mined: {} }),
      simulate: async c => c.job === 'sellFees' ? { ...interpret(c, [0, 16_706_585_120n, 42n, 2n], 10n ** 18n), estimate: 1_500_000n }
        : { ok: false, tipWei: null, estimate: 0n } };
    const out = await runTick(port, {}, { ...options(), dryRun: false, priorityFeeWei: 1n }, quiet);
    expect(out.report.sent).toEqual([expect.objectContaining({ job: 'sellFees', gas: 8_200_000n })]);
    expect(out.state.budget.unblockingWeiByBox?.[addr(3)]).toBe(8_200_000n * 3n);
  });
});

describe('the step minimum read from the hook clone\'s immutable arguments', () => {
  // BoxClones.ARGS_OFFSET 45; BoxHookV2Args.STEP_MIN_Q at argument offset 195, 16 bytes.
  const registry = addr(10), hook = addr(2);
  const code = (stepMinQ: bigint) => (`0x363d3d373d3d3d363d73${'ab'.repeat(20)}5af43d82803e903d91602b57fd5bf3`
    + '00'.repeat(195) + toHex(stepMinQ, { size: 16 }).slice(2)) as Hex;
  const chainWith = (hookCode: Hex | undefined) => {
    let reads = 0;
    let head = 100n, branch = 0n;
    const hash = (n: bigint) => toHex(n + branch, { size: 32 });
    const client = {
      getChainId: async () => 11155111,
      request: async () => ({ number: toHex(head), parentHash: hash(head - 1n), timestamp: toHex(time), baseFeePerGas: '0x1' }),
      getBlock: async ({ blockNumber = head }: { blockNumber?: bigint } = {}) => ({ number: blockNumber, hash: hash(blockNumber), timestamp: time, baseFeePerGas: 1n }),
      getBalance: async () => 0n,
      getBytecode: async ({ address }: { address: Address }) => { if (address === hook) reads++; return address === hook ? hookCode : undefined; },
      getStorageAt: async () => toHex(0n, { size: 32 }),
      readContract: async ({ address, functionName: fn, args = [] }: { address: Address; functionName: string; args?: unknown[] }) => {
        if (address === registry) {
          if (fn === 'boxCount') return 1n;
          if (fn === 'roleOf') return ({ 0: addr(1), 2: hook, 5: addr(3), 6: addr(6) })[String(args[1]) as '0'] ?? addr(0);
        }
        if (fn === 'q') return addr(0);
        if (fn === 'poolId') return toHex(0n, { size: 32 });
        if (fn === 'poolManager') return addr(7);
        if (fn === 'graduated' || fn === 'gateOpen' || fn === 'closed' || fn === 'graduationSettled') return true;
        if (fn === 'failed') return false;
        if (fn === 'roleAddress') return addr(0);
        if (fn === 'buyersChoice' || fn === 'sellersChoice') return 1;
        return 0n;
      },
    } as unknown as PublicClient;
    return { chain: new ViemChain({ ...options(), boxRegistry: registry }, client, addr(99), { public: null, private: null }, null, quiet), reads: () => reads,
      advance: () => { head += 2n; }, reorg: (replacement: Hex, rewind = false) => { hookCode = replacement; branch += 1000n; if (rewind) head -= 10n; } };
  };
  it.each(['same', 'forward', 'rewind'])('BATCH-3 invalidates hook parameters after a reorg with head movement=%s', async movement => {
    const c = chainWith(code(5n));
    expect((await c.chain.read()).boxes[0]?.v2?.stepMinQ).toBe(5n);
    c.advance();
    expect((await c.chain.read()).boxes[0]?.v2?.stepMinQ).toBe(5n);
    expect(c.reads()).toBe(1);
    c.reorg(code(7n), movement === 'rewind');
    if (movement === 'forward') c.advance();
    expect((await c.chain.read()).boxes[0]?.v2?.stepMinQ).toBe(7n);
    expect(c.reads()).toBe(2);
  });
  it('reads STEP_MIN_Q once per hook, and nothing from a hook that is not a clone', async () => {
    const c = chainWith(code(5n * 10n ** 15n));
    expect((await c.chain.read()).boxes[0]?.v2?.stepMinQ).toBe(5n * 10n ** 15n);
    expect((await c.chain.read()).boxes[0]?.v2?.stepMinQ).toBe(5n * 10n ** 15n);
    expect(c.reads()).toBe(1);
    for (const other of ['0x6080604052', undefined] as const) expect((await chainWith(other).chain.read()).boxes[0]?.v2?.stepMinQ).toBeUndefined();
  });
});
