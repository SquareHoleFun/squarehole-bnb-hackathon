// @vitest-environment node
/**
 * SH-258 round 3: the box page's reads on BNB Chain testnet's public RPCs, counted at the fetch boundary. 40 view calls
 * at once (a box page's 36 items, four reads each, came to 144 single requests on the live site, 47 of 183 answered
 * 429): one HTTP request for the Multicall3 code check, then one for all 40 folded into `aggregate3`. Without
 * Multicall3's code at the address: no folding, the 40 calls in one JSON-RPC batch. A 429 from the first RPC: the
 * profile's second public RPC answers. Sepolia's box page: its own plain client, as before.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPublicClient, decodeFunctionData, encodeFunctionResult, encodeAbiParameters, erc20Abi, http, multicall3Abi, type Hex } from 'viem';

vi.mock('viem', async (actual) => {
  const real = await actual<typeof import('viem')>();
  // The real Multicall3 bytes are 1,904 bytes long; this stand-in has its hash.
  return { ...real, keccak256: (value: Hex, ...rest: unknown[]) => (value === '0x6001' ? '0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891' : (real.keccak256 as (...a: unknown[]) => unknown)(value, ...rest)) };
});

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

const TOKEN = '0x00000000000000000000000000000000000000a1';
const holder = (i: number) => `0x${(i + 1).toString(16).padStart(40, '0')}` as const;

/** A JSON-RPC endpoint that answers getCode with `code`, every eth_call with 7, aggregate3 call by call; `status` first. */
function endpoint(code: Hex, log: { url: string; methods: string[] }[], status: Record<string, number> = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: [{ to: string; data: Hex }] } | { id: number; method: string; params: [{ to: string; data: Hex }] }[];
    const list = Array.isArray(body) ? body : [body];
    log.push({ url, methods: list.map((r) => r.method) });
    if (status[url]) return new Response('rate limited', { status: status[url] });
    const answer = (r: (typeof list)[number]) => {
      if (r.method === 'eth_chainId') return '0x61';
      if (r.method === 'eth_getCode') return code;
      if (r.method === 'eth_call' && r.params[0].to.toLowerCase() === '0xca11bde05977b3631167028862be2a173976ca11') {
        const { args } = decodeFunctionData({ abi: multicall3Abi, data: r.params[0].data });
        const calls = args[0] as readonly unknown[];
        return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: calls.map(() => ({ success: true, returnData: encodeAbiParameters([{ type: 'uint256' }], [7n]) })) });
      }
      if (r.method === 'eth_call') return encodeAbiParameters([{ type: 'uint256' }], [7n]);
      throw new Error(`unexpected ${r.method}`);
    };
    const replies = list.map((r) => ({ jsonrpc: '2.0', id: r.id, result: answer(r) }));
    return new Response(JSON.stringify(Array.isArray(body) ? replies : replies[0]), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

async function fortyReads(code: Hex, status: Record<string, number> = {}) {
  vi.stubEnv('SH_TESTNET', 'bnb');
  vi.resetModules();
  const { pageClient } = await import('./view-client');
  const log: { url: string; methods: string[] }[] = [];
  const fetchFn = endpoint(code, log, status) as unknown as typeof fetch;
  const plain = vi.fn(() => createPublicClient({ transport: http('https://bsc-testnet-rpc.publicnode.com', { retryCount: 0, fetchFn }) }));
  const client = pageClient('https://bsc-testnet-rpc.publicnode.com', 97, plain, fetchFn);
  const values = await Promise.all(Array.from({ length: 40 }, (_, i) => client.readContract({ address: TOKEN, abi: erc20Abi, functionName: 'balanceOf', args: [holder(i)] })));
  return { values, log, plain };
}

describe('the box page reads on BNB Chain testnet', () => {
  it('40 view calls: the code check, then ONE request carrying all 40 in aggregate3', async () => {
    const { values, log, plain } = await fortyReads('0x6001');
    expect(values).toEqual(Array.from({ length: 40 }, () => 7n));
    expect(plain).not.toHaveBeenCalled();
    expect(log.map((entry) => entry.methods)).toEqual([['eth_getCode'], ['eth_call']]);
  });

  it('no Multicall3 code at the address: never folded, the 40 calls go in one JSON-RPC batch', async () => {
    const { values, log } = await fortyReads('0x');
    expect(values).toHaveLength(40);
    expect(log).toHaveLength(2);
    expect(log[1]?.methods).toEqual(Array.from({ length: 40 }, () => 'eth_call'));
  });

  it('the first public RPC answers 429: the second one answers the reads', async () => {
    const { values, log } = await fortyReads('0x6001', { 'https://bsc-testnet-rpc.publicnode.com/': 429, 'https://bsc-testnet-rpc.publicnode.com': 429 });
    expect(values).toHaveLength(40);
    expect(log.some((entry) => entry.url.startsWith('https://bsc-prebsc-dataseed.bnbchain.org'))).toBe(true);
  });

  it('Sepolia: the page keeps its own plain client (one request per read, as before)', async () => {
    vi.resetModules();
    const { pageClient } = await import('./view-client');
    const plain = vi.fn(() => createPublicClient({ transport: http('https://ethereum-sepolia-rpc.publicnode.com') }));
    pageClient('https://ethereum-sepolia-rpc.publicnode.com', 11_155_111, plain);
    expect(plain).toHaveBeenCalledOnce();
  });
});
