/**
 * SH-EXISTING-NFTS-E08C: the add-on's RPC reads ask the node for the block number every time. Found on the first
 * real-chain run: viem caches a client's block number for up to 4 s, so the identity check right after createBox's
 * receipt read the registry at the block before it ("This box is not in the add-on's registry.").
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rpcSetReads } from './set-reads';

afterEach(() => { vi.unstubAllGlobals(); });

describe('the add-on’s RPC reads', () => {
  it('read the latest block number afresh on each call (a read pinned to it follows the newest receipt)', async () => {
    let block = 100;
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { id: number; method: string } | { id: number; method: string }[];
      const one = (request: { id: number; method: string }) => {
        asked.push(request.method);
        if (request.method === 'eth_blockNumber') { block += 1; return { jsonrpc: '2.0', id: request.id, result: `0x${block.toString(16)}` }; }
        return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'not here' } };
      };
      return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { headers: { 'content-type': 'application/json' } });
    });
    const reads = rpcSetReads('http://127.0.0.1:8545');
    expect(await reads.blockNumber()).toBe(101n);
    expect(await reads.blockNumber()).toBe(102n);
    expect(asked).toEqual(['eth_blockNumber', 'eth_blockNumber']);
  });
});
