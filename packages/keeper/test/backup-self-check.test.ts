import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createPublicClient, custom, zeroHash, type Address } from 'viem';
import { RANDOMNESS_SOURCE as source } from '../../box-spec/src/generated/box-spec.v1';
import { ViemChain } from '../src/chain';
import { buildMonitorView, type MonitorReadings } from '../src/monitor';
import { runTick } from '../src/run';
import { fakeClient, fakeNode } from './support/fake-rpc';
import { fakeHeader } from './support/backup';
import { addr, keeper, options, quiet, time } from './support/v2';

function fixture(mode: 'raw' | 'fields' | 'unknown' | 'mismatch' = 'raw', box0 = true) {
  const node = fakeNode({ block: { number: 1001n, timestamp: time, baseFeePerGas: 1n } });
  const base = fakeClient(node);
  let release: (() => void) | undefined;
  let held: Promise<void> | undefined;
  const rpc = vi.fn(async ({ method, params }: { method: string; params?: unknown }) => {
    const tag = ((params ?? []) as string[])[0];
    if (method === 'debug_getRawHeader') {
      await held;
      if (mode !== 'raw') throw new Error('private provider payload');
      return fakeHeader(BigInt(tag ?? 'invalid block tag'), node.block.timestamp).raw;
    }
    if (method === 'eth_getBlockByNumber') {
      const n = tag === 'pending' ? node.block.number : tag === 'latest' ? node.block.number - 1n : BigInt(tag ?? 'invalid block tag');
      const { block } = fakeHeader(n, node.block.timestamp);
      if (tag === 'pending') return { ...block, parentHash: fakeHeader(n - 1n, node.block.timestamp).block.hash };
      // Corrupt only the diagnostic header, leaving the candidate chain internally consistent.
      if (n === node.block.number - 2n) return mode === 'unknown' ? { ...block, futureHeaderRoot: zeroHash }
        : mode === 'mismatch' ? { ...block, hash: zeroHash } : block;
      return block;
    }
    return base.request({ method, params } as never);
  });
  const diagnosticTransport = custom({ request: rpc }, { retryCount: 0 });
  const pub = createPublicClient({ transport: parameters => {
    const transport = custom({ request: rpc }, { retryCount: 0 })(parameters);
    return { ...transport, value: { ...transport.value, diagnosticTransport } };
  } });
  const on = (address: Address, fn: string, value: unknown) => { node.calls[`${address.toLowerCase()}:${fn}`] = () => value; };
  on(addr(1), 'randomness', source); on(addr(1), 'tickets', addr(7));
  on(addr(7), 'source', source); on(addr(7), 'coordinator', addr(1)); on(addr(7), 'phase', 2);
  on(addr(7), 'status', { minted: 2, slots: 2, wordRequestedAt: 100, wordAcceptedAt: 0, terminalAt: 0, drawsRequested: 0, drawsSettled: 0 });
  on(source, 'requestOf', [time - 100n, 123n]); on(source, 'wordOf', [`0x${'12'.repeat(32)}`, time - 50n]);
  on(source, 'isSilent', false);
  const cfg = { ...options(), dryRun: false, monitorFile: '.cache/self-check-view.json',
    box0: box0 ? { coordinator: addr(1), hook: addr(2), receiver: addr(3), executor: addr(9) } : null };
  const log = { ...quiet, info: vi.fn(), warn: vi.fn() };
  const restart = () => new ViemChain(cfg, pub, keeper, { public: null, private: null }, null, log);
  const chain = restart();
  const headerCalls = () => rpc.mock.calls.filter(([r]) => r.method === 'debug_getRawHeader');
  return { node, rpc, cfg, log, chain, restart, headerCalls,
    hold: () => { held = new Promise<void>(resolve => { release = resolve; }); }, release: () => release?.() };
}
const view = (readings: MonitorReadings | undefined) => {
  if (!readings) throw new Error('missing monitor readings');
  return buildMonitorView({ chainId: 11155111, identity: 'test', readings,
    maxFeePerGas: 1n, queue: {}, income: null, incomeSpend: [] });
};

describe('box 0 header self-check', () => {
  it.each(['raw', 'fields'] as const)('checks latest minus one at startup and each pending-clock day using %s', async path => {
    const f = fixture(path);
    await f.chain.read();
    await vi.waitFor(() => expect(f.log.info).toHaveBeenCalledWith('backup header self-check ok', { block: 999n, path }));
    expect(f.headerCalls()).toHaveLength(1);
    expect(f.headerCalls()[0]?.[0].params).toEqual(['0x3e7']);
    const next = await f.chain.read();
    expect(view(next.monitor)).toHaveProperty('backupHeader', { checkedAt: time.toString(), block: '999', ok: true, path });
    f.node.block.timestamp = time + 86399n; await f.chain.read();
    expect(f.headerCalls()).toHaveLength(1);
    f.node.block.timestamp++; f.node.block.number++;
    await f.chain.read();
    await vi.waitFor(() => expect(f.log.info).toHaveBeenCalledWith('backup header self-check ok', { block: 1000n, path }));
    expect(f.headerCalls()).toHaveLength(2);
    await f.restart().read();
    await vi.waitFor(() => expect(f.headerCalls()).toHaveLength(3));
  });

  it('does not check without box 0 or add a result before a check completes', async () => {
    const f = fixture('raw', false);
    const w = await f.chain.read();
    expect(f.headerCalls()).toHaveLength(0);
    expect(view(w.monitor)).not.toHaveProperty('backupHeader');
  });

  it.each(['unknown', 'mismatch'] as const)('a %s field failure is fixed text and changes no candidates or sends', async mode => {
    const good = fixture(), bad = fixture(mode);
    const run = async (f: ReturnType<typeof fixture>) => {
      const send = vi.fn(async () => 'hash');
      const out = await runTick({ read: () => f.chain.read(), simulate: async () => ({ ok: true, tipWei: null, estimate: 100000n }), send }, {}, f.cfg, f.log);
      return { out, send };
    };
    const expected = await run(good), actual = await run(bad);
    await vi.waitFor(() => expect(bad.log.warn).toHaveBeenCalledWith('backup header self-check failed', { block: 999n }));
    expect(actual.out.report).toEqual(expected.out.report);
    expect(actual.out.report.sent.map(c => c.job)).toContain('drandAcceptWord');
    expect(actual.send.mock.calls).toEqual(expected.send.mock.calls);
    const w = await bad.chain.read();
    expect(w.monitor).toMatchObject({ failedReads: 0, drand: { complete: true } });
    expect(view(w.monitor)).toHaveProperty('backupHeader', { checkedAt: time.toString(), block: '999', ok: false, path: null });
    expect(bad.log.warn.mock.calls.filter(([s]) => s === 'backup header self-check failed')).toEqual([
      ['backup header self-check failed', { block: 999n }],
    ]);
  });

  it('a held header RPC never holds up a read or a send and starts no overlapping check', async () => {
    const f = fixture(); f.hold();
    const send = vi.fn(async () => 'hash');
    const out = await runTick({ read: () => f.chain.read(), simulate: async () => ({ ok: true, tipWei: null, estimate: 100000n }), send }, {}, f.cfg, f.log);
    expect(send).toHaveBeenCalled();
    expect(view(out.observed.readings)).not.toHaveProperty('backupHeader');
    await f.chain.read();
    expect(f.headerCalls()).toHaveLength(1);
    f.release();
    await vi.waitFor(() => expect(f.log.info).toHaveBeenCalledWith('backup header self-check ok', { block: 999n, path: 'raw' }));
  });

  it('lets the service print the fixed self-check warning', () => {
    const text = readFileSync(new URL('../../../infra/server/services/keeper.mjs', import.meta.url), 'utf8');
    expect(text).toContain("'backup header self-check failed'");
  });
});
