import { afterEach, expect, it, vi } from 'vitest';
import { holderActionIO } from './actions-v2';
import { parseSnapshotV2 } from './indexer-v2';
import { publishedM2, A, H } from './test-support/m2-published';
import { m2RpcFixture, type RpcCall } from './test-support/m2-rpc';

afterEach(() => vi.unstubAllGlobals());
it.each(['available', 'paused', 'offline'] as const)('M253-RPC: the real reader uses one canonical hash and distinguishes %s', async payout => {
  const { source, body } = await publishedM2(true); const view = parseSnapshotV2(body, source);
  const rpc = m2RpcFixture({ payout }); const wallet = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    const call = JSON.parse(String(init.body)) as RpcCall & { id: number };
    let answer;
    try { answer = { result: await rpc.request(call) }; }
    catch (error) { answer = { error: { code: (error as { code: number }).code, message: (error as Error).message } }; }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, ...answer }), { headers: { 'content-type': 'application/json' } });
  }));
  const read = await holderActionIO(source, view, wallet).claim(1n, A);
  expect(read).toMatchObject({ hash: view.blockHash, claimableP: 60000001n, failedBox: true, payout: payout === 'paused' ? 'unavailable' : payout === 'offline' ? 'unverified' : 'available' });
  const calls = rpc.calls.filter(c => c.method === 'eth_call');
  expect(calls).toHaveLength(7);
  for (const call of calls) expect(call.params?.[1]).toEqual({ blockHash: view.blockHash, requireCanonical: true });
  expect(calls.at(-1)?.params?.[0]).toMatchObject({ from: A, to: view.claimRow?.contracts.holderLedger });
  expect(wallet).not.toHaveBeenCalled();
});

// FE1: claim confirmation compares block numbers only (holder-claims.ts), so the receipt check by block hash is gone.
it('M253-AF1-RPC: preserves the successful receipt hash and height', async () => {
  const { source, body } = await publishedM2(true); const view = parseSnapshotV2(body, source);
  const wallet = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    const call = JSON.parse(String(init.body)) as RpcCall & { id: number };
    if (call.method !== 'eth_getTransactionReceipt') throw new Error(`Unexpected RPC: ${call.method}`);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: {
      transactionHash: H(80), blockNumber: `0x${(view.block + 2n).toString(16)}`, blockHash: H(82), status: '0x1', logs: [],
      transactionIndex: '0x0', cumulativeGasUsed: '0x1', gasUsed: '0x1', effectiveGasPrice: '0x1', type: '0x2',
    } }), { headers: { 'content-type': 'application/json' } });
  }));
  expect(await holderActionIO(source, view, wallet).receipt(H(80))).toMatchObject({
    transactionHash: H(80), blockNumber: view.block + 2n, blockHash: H(82), status: 'success',
  });
  expect(wallet).not.toHaveBeenCalled();
});
