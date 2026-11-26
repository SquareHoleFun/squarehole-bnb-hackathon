import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import { decompressQuicknet, fetchQuicknet, QUICKNET_HASH, QUICKNET_RELAYS } from '../src/drand-relays';

const vectors = JSON.parse(readFileSync(new URL('../../contracts/test/vectors/drand-quicknet.json', import.meta.url), 'utf8')) as {
  chainHash: string; rounds: number[]; signatures: Hex[]; signaturesXY: Hex[]; randomness: Hex[];
};
function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('missing test input');
  return value;
}
const round = BigInt(required(vectors.rounds[1]));
const body = (i = 1) => ({ round: String(vectors.rounds[i]), signature: required(vectors.signatures[i]).slice(2), randomness: required(vectors.randomness[i]).slice(2) });
const response = (value: unknown) => new Response(JSON.stringify(value));

describe('quicknet public relay boundary (DRAND-01)', () => {
  it('pins the contract chain and decompresses every committed public vector', () => {
    expect(`0x${QUICKNET_HASH}`).toBe(vectors.chainHash);
    expect(new Set(QUICKNET_RELAYS.map(u => new URL(u).host)).size).toBeGreaterThanOrEqual(2);
    vectors.signatures.forEach((sig, i) => expect(decompressQuicknet(sig)).toBe(vectors.signaturesXY[i]));
    for (const sig of ['0x', `0x${'00'.repeat(48)}`, `0x${'ff'.repeat(48)}`, `0xc0${'00'.repeat(47)}`]) {
      expect(() => decompressQuicknet(sig as Hex)).toThrow();
    }
  });

  it('lets the first cryptographically valid simulated answer win, not the first HTTP response', async () => {
    const checked: Hex[] = [];
    const urls: string[] = [];
    const fetcher: typeof fetch = async input => {
      const url = String(input); urls.push(url);
      return response(url.startsWith(QUICKNET_RELAYS[0]) ? { ...body(2), round: String(round) } : body());
    };
    const valid = await fetchQuicknet(round, async signature => {
      checked.push(signature);
      if (signature !== vectors.signaturesXY[1]) throw new Error('fake chain: invalid signature');
    }, fetcher);
    expect(valid).toBe(vectors.signaturesXY[1]);
    expect(checked).toContain(vectors.signaturesXY[2]);
    expect(urls).toHaveLength(4);
    expect(urls.every(u => u.endsWith(`/${QUICKNET_HASH}/public/${round}`))).toBe(true);
  });

  it.each(['wrong round', 'wrong randomness', 'malformed', 'http failure', 'oversized'])('rejects %s and continues to the second relay', async fault => {
    const validate = vi.fn(async () => {});
    const fetcher: typeof fetch = async input => {
      if (!String(input).startsWith(QUICKNET_RELAYS[0])) return response(body());
      if (fault === 'http failure') return new Response('', { status: 503 });
      if (fault === 'oversized') return new Response('x'.repeat(8193));
      if (fault === 'malformed') return new Response('{');
      return response({ ...body(), ...(fault === 'wrong round' ? { round: '1' } : { randomness: '00'.repeat(32) }) });
    };
    expect(await fetchQuicknet(round, validate, fetcher)).toBe(vectors.signaturesXY[1]);
    expect(validate).toHaveBeenCalledTimes(3);
  });

  it('bounds slow relays, including a fake transport that ignores abort, and masks transport errors', async () => {
    const hang: typeof fetch = () => new Promise(() => {});
    await expect(fetchQuicknet(round, async () => {}, hang, 10)).rejects.toThrow('no valid quicknet relay answer');
    const broken: typeof fetch = async () => { throw new Error('untrusted relay text'); };
    await expect(fetchQuicknet(round, async () => {}, broken)).rejects.toThrow(/^no valid quicknet relay answer$/);
  });

  it('aborts the losing relay when another answer validates', async () => {
    const signals: AbortSignal[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      signals.push(required(init?.signal));
      return response(body());
    };
    await fetchQuicknet(round, async () => {}, fetcher);
    expect(signals.every(s => s.aborted)).toBe(true);
  });
});


it.each([2, 3])('four relays start together with both headers; only relay %s wins', async winner => {
  expect(QUICKNET_RELAYS).toEqual(['https://api.drand.sh', 'https://api2.drand.sh', 'https://api3.drand.sh', 'https://drand.cloudflare.com']);
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input); calls.push(url);
    expect(init?.headers).toEqual({ accept: 'application/json', 'user-agent': 'curl/8 (squarehole keeper)' });
    expect(init?.redirect).toBe('error');
    if (url.startsWith(required(QUICKNET_RELAYS[winner]))) return response(body());
    if (url.startsWith(QUICKNET_RELAYS[1])) return response({ ...body(), round: '1' });
    return new Response('', { status: 500 });
  };
  expect(await fetchQuicknet(round, async () => {}, fetcher)).toBe(vectors.signaturesXY[1]);
  expect(calls).toHaveLength(4);
});
