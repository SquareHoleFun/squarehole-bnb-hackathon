import { describe, expect, it, vi } from 'vitest';
import { createPublicClient, custom, toHex, type LocalAccount } from 'viem';
import { ViemChain } from '../src/chain';
import { pendingFees } from '../src/gas';
import { runTick } from '../src/run';
import { fakeClient, fakeNode } from './support/fake-rpc';
import { addr, keeper, options, time } from './support/v2';

const unavailable: [string, Record<string, unknown>][] = [
  ['missing', {}], ['null', { baseFeePerGas: null }],
  ...[true, false, '', ' ', '\t', 0, 1, 1.5, -1, '0', '123', '-0x1', '0x', '0x00', '0x01',
    '0xgg', ' 0x1', '0x1 ', '0x1\n', '0x0\r', '0x1\r\n', [], {}, 'private provider payload'].map(value =>
    [JSON.stringify(value), { baseFeePerGas: value }] as [string, Record<string, unknown>]),
];

function fixture(fee: Record<string, unknown>) {
  // SH-259: a zero base fee reads eth_gasPrice before anything else of the tick (rule A); this node answers it.
  const node = fakeNode({ block: { number: 100n, timestamp: time, baseFeePerGas: 1n }, gasPrice: () => 100_000_000n });
  const base = fakeClient(node);
  const state = { fee, number: '0x64' as string | null };
  const rpc = vi.fn(async ({ method, params }: { method: string; params?: readonly unknown[] }) => {
    if (method === 'eth_getBlockByNumber' && params?.[0] === 'pending') {
      return { number: state.number, timestamp: toHex(time), gasLimit: '0x1c9c380', transactions: [], ...state.fee };
    }
    return base.transport.request({ method, params });
  });
  const pub = createPublicClient({ transport: custom({ request: rpc }, { retryCount: 0 }) });
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const cfg = { ...options(), dryRun: false };
  const sign = vi.fn<(tx: Record<string, unknown>) => Promise<`0x${string}`>>(async tx => `0x1234${Number(tx.nonce ?? 0).toString(16).padStart(8, '0')}`);
  const signer = { address: keeper, signTransaction: sign } as unknown as LocalAccount;
  const chain = new ViemChain(cfg, pub, keeper, { public: signer, private: null }, null, log);
  return { node, state, rpc, pub, log, cfg, sign, chain };
}

describe('SH-KEEPER-BASEFEE: raw pending fees', () => {
  it.each(unavailable)('pendingFees rejects %s with a fixed error', async (_, fee) => {
    await expect(pendingFees(fixture(fee).pub, 100_000_000n)).rejects.toThrow('fee unavailable');
  });

  it.each(unavailable)('World refuses %s before discovering jobs', async (_, fee) => {
    const f = fixture(fee);
    await expect(f.chain.read()).rejects.toThrow('fee unavailable');
    expect(f.rpc.mock.calls.map(([r]) => r.method)).toEqual(['eth_chainId', 'eth_getBlockByNumber']);
    expect(f.log.warn.mock.calls).toEqual([['fee unavailable']]);
    expect(f.log.error).not.toHaveBeenCalled();
  });

  it.each([['0x0', 0n], ['0x3b9aca00', 1_000_000_000n], ['0x20000000000001', 9_007_199_254_740_993n]] as const)(
    'keeps the exact fee %s in pendingFees and World', async (raw, expected) => {
      const f = fixture({ baseFeePerGas: raw });
      const fees = await pendingFees(f.pub, 100_000_000n);
      expect(fees).toEqual({ baseFeePerGas: expected, maxPriorityFeePerGas: 100_000_000n,
        maxFeePerGas: 2n * expected + 100_000_000n });
      expect((await f.chain.read()).block).toEqual({ number: 100n, timestamp: time, baseFeePerGas: expected });
      expect(f.rpc.mock.calls.filter(([r]) => r.method === 'eth_getBlockByNumber').map(([r]) => r.params))
        .toEqual([['pending', false], ['pending', false]]);
      expect(f.log.warn).not.toHaveBeenCalled();
    });

  it('keeps the pending-number fallback and timestamp-only monitor read without a fee', async () => {
    const f = fixture({ baseFeePerGas: '0x0' });
    f.state.number = null;
    vi.spyOn(f.pub, 'getBlock').mockResolvedValue({ number: 99n, timestamp: time - 12n } as never);
    const chain = new ViemChain({ ...f.cfg, monitorFile: '.cache/keeper-monitor.json' }, f.pub, keeper,
      { public: null, private: null }, null, f.log);
    const w = await chain.read();
    expect(w.block).toEqual({ number: 100n, timestamp: time, baseFeePerGas: 0n });
    expect(w.monitor?.snapshot).toEqual({ number: 99n, timestamp: time - 12n });
  });

  it.each(unavailable)('a cycle with %s sends nothing, then retries with the next fee', async (_, fee) => {
    const f = fixture(fee);
    // These stand for independently due post/draw/write jobs; the real World fee read gates all of them.
    const read = f.chain.read.bind(f.chain);
    f.chain.read = async scan => ({ ...await read(scan), drand: [
      { job: 'drandPostRound', key: 'post', to: addr(1), fn: 'postRound', args: [1n, '0x'] },
      { job: 'drandSettle', key: 'draw', to: addr(2), fn: 'settle', args: [8n] },
      { job: 'drandRequestWord', key: 'request', to: addr(3), fn: 'requestGraduationWord', args: [] },
    ] });
    const prepare = vi.spyOn(f.chain, 'prepare').mockImplementation(async c => c);
    const simulate = vi.spyOn(f.chain, 'simulate').mockResolvedValue({ ok: true, estimate: 100_000n, tipWei: 10n ** 18n });
    const income = vi.spyOn(f.chain, 'readIncome').mockResolvedValue({ at: time, platformWei: 0n, boxes: {}, mined: {} });
    const checkpoint = vi.fn();
    const cfg = { ...f.cfg, checkpoint };
    const state = { m2Scan: {} };
    await expect(runTick(f.chain, state, cfg, f.log)).rejects.toThrow('fee unavailable');
    expect(f.log.warn.mock.calls).toEqual([['fee unavailable']]);
    expect(prepare).not.toHaveBeenCalled();
    expect(simulate).not.toHaveBeenCalled();
    expect(income).not.toHaveBeenCalled();
    expect(checkpoint).not.toHaveBeenCalled();
    expect(f.sign).not.toHaveBeenCalled();
    expect(f.node.sent).toEqual([]);
    expect(state).toEqual({ m2Scan: {} });

    f.state.fee = { baseFeePerGas: '0x3b9aca00' };
    const next = await runTick(f.chain, state, cfg, f.log);
    expect(next.report.sent.map(c => c.key)).toEqual(expect.arrayContaining(['post', 'draw', 'request']));
    expect(f.node.sent).toHaveLength(3);
    expect(f.sign).toHaveBeenCalledTimes(3);
    for (const [tx] of f.sign.mock.calls) {
      expect(tx.maxFeePerGas).toBe(2_000_000_000n + cfg.priorityFeeWei);
    }
    expect(f.log.warn.mock.calls).toEqual([['fee unavailable']]);
  });
});
