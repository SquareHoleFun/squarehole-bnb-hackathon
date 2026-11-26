import { describe, expect, it, vi } from 'vitest';
import { BaseError, type Address, type Hex, type PublicClient } from 'viem';
import { RANDOMNESS_SOURCE as source } from '../../box-spec/src/generated/box-spec.v1';
import { ViemChain } from '../src/chain';
import { loadConfig } from '../src/config';
import { DrandReader } from '../src/drand';
import { readFailed } from '../src/read-failure';
import { REVERT, fakeClient, fakeNode } from './support/fake-rpc';
import { addr, keeper, options, quiet } from './support/v2';

// Offline doubles only: the completeness flags of keeper-view.md, from the reads the keeper already makes.
const coordinator = addr(1), tickets = addr(7);
const revert = () => new BaseError('call reverted', { details: 'execution reverted' });

function drandFixture(fromBlock = 10n) {
  const reads: Record<string, (args: readonly unknown[]) => unknown> = {};
  const on = (a: Address, fn: string, result: (args: readonly unknown[]) => unknown) => { reads[`${a.toLowerCase()}:${fn}`] = result; };
  on(coordinator, 'randomness', () => source); on(coordinator, 'tickets', () => tickets);
  on(tickets, 'source', () => source); on(tickets, 'coordinator', () => coordinator); on(tickets, 'phase', () => 3);
  on(tickets, 'status', () => ({ slots: 2, wordRequestedAt: 100, wordAcceptedAt: 113, terminalAt: 0, drawsRequested: 1, drawsSettled: 0 }));
  on(source, 'requestOf', () => [1_000n, 5n]); on(source, 'wordOf', () => [`0x${'00'.repeat(32)}`, 0n]);
  on(source, 'isSilent', () => false); on(source, 'roundTime', () => 2_000n);
  const pub = {
    readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args?: readonly unknown[] }) => {
      const handler = reads[`${address.toLowerCase()}:${functionName}`];
      if (!handler) throw revert();
      return handler(args ?? []);
    },
    getBlock: async ({ blockNumber = 50_000n }: { blockNumber?: bigint }) => ({ number: blockNumber,
      hash: `0x${blockNumber.toString(16).padStart(64, '0')}` as Hex,
      parentHash: `0x${(blockNumber - 1n).toString(16).padStart(64, '0')}` as Hex }),
    getContractEvents: async () => [],
  };
  const cfg = { ...options(), fromBlock, boxRegistry: null, box0: { coordinator, hook: addr(2), receiver: addr(3), executor: addr(9) } };
  return { on, reader: new DrandReader(cfg, pub as unknown as PublicClient, keeper, quiet) };
}

describe('read failures for the view\'s complete flags', () => {
  it('counts node and consistency failures, not reverts or empty returns', () => {
    expect(readFailed(new Error('node down'))).toBe(true);
    expect(readFailed(revert())).toBe(false);
  });
});

describe('the drand observation (keeper-view.md drand)', () => {
  it('lists each read request with its 604,800-second deadline once the Requested scan reaches the block', async () => {
    const f = drandFixture();
    await f.reader.read(19n, 1_500n);
    expect(f.reader.observation()).toEqual({ complete: true,
      requests: [{ requestedAt: 1_000n, deadline: 605_800n, usable: false, silent: false }] });
  });

  it('includes a silent head that blocks its consumer and stays incomplete during historical backfill', async () => {
    const f = drandFixture(0n);
    f.on(source, 'isSilent', () => true);
    await f.reader.read(20_000n, 700_000n);
    expect(f.reader.observation()).toEqual({ complete: false,
      requests: [{ requestedAt: 1_000n, deadline: 605_800n, usable: false, silent: true }] });
    // Eight 2,000-block pages a tick: the second read finishes the backfill.
    await f.reader.read(20_000n, 700_000n);
    expect(f.reader.observation().complete).toBe(true);
  });

  it('is incomplete after a failed request read, and an unreadable bounty (a revert) does not count', async () => {
    const f = drandFixture();
    f.on(source, 'requestOf', () => { throw new Error('node down'); });
    await f.reader.read(19n, 1_500n);
    expect(f.reader.observation()).toEqual({ complete: false, requests: [] });
  });
});

describe('the chain adapter\'s monitor readings', () => {
  function chain(roleOf: () => unknown, monitorFile?: string) {
    const node = fakeNode();
    node.calls = { [`${addr(50)}:boxCount`]: () => 1n, [`${addr(50)}:roleOf`]: roleOf };
    const pub = fakeClient(node);
    const getBlock = pub.getBlock.bind(pub);
    // The fake node answers every block query with its pending block; return the asked-for height and its own time.
    const header = vi.fn(async (a?: Parameters<typeof getBlock>[0]) => a && 'blockNumber' in a && a.blockNumber !== undefined
      ? { ...(await getBlock(a)), number: a.blockNumber, timestamp: 777n } : getBlock(a));
    Object.assign(pub, { getBlock: header });
    const cfg = loadConfig({ SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216', SH_KEEPER_RPC_URL: 'http://fake.invalid',
      SH_KEEPER_BOX_REGISTRY: addr(50), ...(monitorFile ? { SH_KEEPER_MONITOR_FILE: monitorFile } : {}) });
    return { header, port: new ViemChain(cfg, pub, keeper, { public: null, private: null }, null, quiet) };
  }

  it('reports the snapshot header but keeps a reverted consumer discovery incomplete', async () => {
    const c = chain(() => { throw REVERT; }, '/state/monitor.json');
    const w = await c.port.read();
    expect(w.block.number).toBe(1_000n);
    expect(w.monitor).toEqual({ complete: true, failedReads: 0, snapshot: { number: 999n, timestamp: 777n }, drand: { complete: false, requests: [] } });
  });

  it('marks the read and drand incomplete when the node fails a guarded read', async () => {
    const w = await chain(() => { throw new Error('node down'); }, '/state/monitor.json').port.read();
    expect(w.monitor).toMatchObject({ complete: false, failedReads: 1, drand: { complete: false } });
  });

  it('adds no reading and no header request without a configured view', async () => {
    const c = chain(() => { throw REVERT; });
    expect((await c.port.read()).monitor).toBeUndefined();
    expect(c.header.mock.calls.some(([a]) => a !== undefined && 'blockNumber' in a)).toBe(false);
  });
});
