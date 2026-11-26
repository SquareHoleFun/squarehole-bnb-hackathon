// @vitest-environment node
/**
 * SH-278: Create's reads before the wallet is asked (`rpcCreateReads`) under an endpoint that says "later": a read
 * refused with HTTP 429 goes again to the same endpoint (three more tries at most); a read refused four times fails
 * within the pauses (about 3.1 s), so the page's "could not be read" line follows at once; nothing else is retried.
 */
import { describe, expect, it } from 'vitest';
import type { FetchLike } from '@squarehole/chain/write';
import { rpcCreateReads } from './useCreateSend';

const RPC = 'https://rpc.example.org/';

/** An endpoint answering eth_chainId (0x61) by `plan`: a status per request, then 200 for the rest. */
function endpoint(plan: number[]) {
  const seen: string[] = [];
  const fetchFn: FetchLike = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { id: number; method: string };
    seen.push(body.method);
    const status = plan.shift() ?? 200;
    if (status !== 200) return new Response('later', { status });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x61' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchFn, seen };
}

describe('rpcCreateReads under refusals', () => {
  it('429 then 200: the chain id, after two requests', async () => {
    const { fetchFn, seen } = endpoint([429]);
    await expect(rpcCreateReads(RPC, 1_000, fetchFn).chainId()).resolves.toBe(97);
    expect(seen).toEqual(['eth_chainId', 'eth_chainId']);
  });

  it('four 429: the read fails after four requests, within the pauses', async () => {
    const { fetchFn, seen } = endpoint([429, 429, 429, 429]);
    const started = Date.now();
    await expect(rpcCreateReads(RPC, 1_000, fetchFn).chainId()).rejects.toThrow(/429|HTTP request failed/);
    expect(seen).toHaveLength(4);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('HTTP 500: one request (viem\'s own retries stay off)', async () => {
    const { fetchFn, seen } = endpoint([500]);
    await expect(rpcCreateReads(RPC, 1_000, fetchFn).chainId()).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });
});
