// @vitest-environment node
/**
 * SH-283b: a card's picture read (`tokenURI`) under a busy public endpoint. HTTP 429 ("later") goes again to the same
 * endpoint by the site's rule (refusedRetryFetch: 429 only, three more tries at 400, 900 and 1,800 ms); any other answer,
 * a 500 included, is sent once. The endpoint here is a fetch double; nothing leaves the test.
 */
import { describe, expect, it } from 'vitest';
import { encodeFunctionResult, type Address } from 'viem';
import { ERC721_ABI } from '../../set/set-calls';
import { pictureReadsV2 } from './ShopCardsV2';

const RPC = 'https://rpc.test.invalid';
const CARDS = '0x675A3eCDd3e46eC716Af19179B36e6f4d6a2A174' as Address;
const URI = 'data:application/json;base64,eyJpbWFnZSI6ImlwZnM6Ly9iYWZrcmVpIn0=';

/** An endpoint that answers `statuses` in turn, then the token's URI; every request counted. */
function endpoint(statuses: readonly number[]) {
  const seen: string[] = [];
  const fetchFn = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call = JSON.parse(String(init?.body)) as { id: number; method: string };
    seen.push(call.method);
    const status = statuses[seen.length - 1];
    if (status !== undefined) return new Response(status === 429 ? 'Too Many Requests' : 'Internal Server Error', { status });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: encodeFunctionResult({ abi: ERC721_ABI, functionName: 'tokenURI', result: URI }) }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { seen, fetchFn };
}

describe('SH-283b: a card picture read and a refusing endpoint', () => {
  it('two HTTP 429 answers, then the token URI: the read succeeds on the third try, to the same endpoint', async () => {
    const { seen, fetchFn } = endpoint([429, 429]);
    const reads = pictureReadsV2(RPC, fetchFn);
    await expect(reads.read(CARDS, ERC721_ABI, 'tokenURI', [3n])).resolves.toBe(URI);
    expect(seen).toEqual(['eth_call', 'eth_call', 'eth_call']);
  });

  it('a 500 is sent once: no second try', async () => {
    const { seen, fetchFn } = endpoint([500]);
    const reads = pictureReadsV2(RPC, fetchFn);
    await expect(reads.read(CARDS, ERC721_ABI, 'tokenURI', [3n])).rejects.toThrow();
    expect(seen).toEqual(['eth_call']);
  });

  it('refused four times: three more tries, then the refusal stands', async () => {
    const { seen, fetchFn } = endpoint([429, 429, 429, 429]);
    const reads = pictureReadsV2(RPC, fetchFn);
    await expect(reads.read(CARDS, ERC721_ABI, 'tokenURI', [3n])).rejects.toThrow();
    expect(seen).toHaveLength(4);
  }, 10_000);
});
