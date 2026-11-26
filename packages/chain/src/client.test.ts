/**
 * The HTTP transport stack with a mocked `fetch`: ordered fallback across the configured keyless RPCs, per-request
 * timeouts, JSON-RPC batching, and the chain-id guard.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChainClient, createChainIdGuard } from './client';
import { createChainConfig } from './config/config';
import { ChainDataError, ChainUnavailableError } from './errors';

type RpcBody = { id: number; method: string } | { id: number; method: string }[];

function rpcResponse(body: RpcBody, chainIdHex: string): Response {
  const answer = (request: { id: number; method: string }) => ({ jsonrpc: '2.0', id: request.id, result: request.method === 'eth_chainId' ? chainIdHex : '0x10' });
  return new Response(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)), { status: 200, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createChainClient (viem http fallback transport)', () => {
  it('falls back to the next keyless RPC when the first fails, in the configured order', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      seen.push(url);
      if (url.startsWith('https://first.example')) return new Response('bad gateway', { status: 502 });
      return rpcResponse(JSON.parse(String(init?.body)) as RpcBody, '0xaa36a7');
    });
    const config = createChainConfig({ chainId: 11_155_111, rpcUrls: ['https://first.example/rpc', 'https://second.example/rpc'] });
    const client = createChainClient(config, { retryCount: 0 });
    expect(await client.getChainId()).toBe(11_155_111);
    expect(seen[0]).toBe('https://first.example/rpc');
    expect(seen.at(-1)).toBe('https://second.example/rpc');
  });

  it('times out a hanging endpoint and moves on', async () => {
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('http://127.0.0.1:8558')) {
        return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      }
      return Promise.resolve(rpcResponse(JSON.parse(String(init?.body)) as RpcBody, '0x7a69'));
    });
    const config = createChainConfig({ chainId: 31_337, rpcUrls: ['http://127.0.0.1:8558', 'http://127.0.0.1:8559'], requestTimeoutMs: 50 });
    const client = createChainClient(config, { retryCount: 0 });
    expect(await client.getChainId()).toBe(31_337);
  });

  it('batches concurrent JSON-RPC requests into one HTTP call', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as RpcBody;
      bodies.push(body);
      return rpcResponse(body, '0x7a69');
    });
    const client = createChainClient(createChainConfig({ chainId: 31_337, rpcUrls: ['http://127.0.0.1:8557'] }), { retryCount: 0 });
    await Promise.all([client.getBlockNumber({ cacheTime: 0 }), client.getChainId(), client.request({ method: 'eth_gasPrice' })]);
    expect(bodies.some((body) => Array.isArray(body) && body.length >= 2)).toBe(true);
  });

  it('the chain-id guard refuses an RPC serving another chain and reports an unreachable one as unavailable', async () => {
    vi.stubGlobal('fetch', async (_input: string | URL | Request, init?: RequestInit) => rpcResponse(JSON.parse(String(init?.body)) as RpcBody, '0x1'));
    const config = createChainConfig({ chainId: 11_155_111, rpcUrls: ['https://wrong.example/rpc'] });
    const guard = createChainIdGuard(createChainClient(config, { retryCount: 0 }), 11_155_111);
    await expect(guard()).rejects.toBeInstanceOf(ChainDataError);

    vi.stubGlobal('fetch', async () => new Response('down', { status: 503 }));
    const down = createChainIdGuard(createChainClient(config, { retryCount: 0 }), 11_155_111);
    await expect(down()).rejects.toBeInstanceOf(ChainUnavailableError);
  });
});
