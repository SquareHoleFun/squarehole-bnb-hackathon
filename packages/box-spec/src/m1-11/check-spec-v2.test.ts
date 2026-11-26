/** CQ11-D creation-input regression tests and bounded indexer transport. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { modelForV2, checkSpecV2, fetchIndexerAnswer, indexerUrlOk, readShapes, type Twin } from '../../scripts/lib/check-spec-v2.mjs';
import * as twin from '../generated/box-spec.v2';
const answerOf = () => JSON.parse(readFileSync(new URL('../../listings.demo.json', import.meta.url), 'utf8'));
const draft = () => JSON.parse(readFileSync(new URL('../../../../skills/square-hole-launch/references/v2/examples/gm-coin.json', import.meta.url), 'utf8'));
const model = modelForV2({ network: 'demo', twin: twin as unknown as Twin });
it('reads only the frozen enum members and one listing context', () => {
  const shapes = readShapes();
  expect(shapes.enums.get('Leg')?.members.map((m) => m.name)).toEqual(['None', 'AsPaid', 'BuyT', 'RESERVED_3', 'RESERVED_4', 'RESERVED_5']);
  expect(shapes.structs.get('ReleaseContext')?.map((f) => f.name)).toEqual(['listing']);
});
it('rejects retired recipe names at input and reserved numeric ids in the validator', () => {
  const d = draft(); d.spec.buyers.a.leg = 'Convert';
  expect(checkSpecV2(model, d).ok).toBe(false);
  d.spec.buyers.a.leg = 4;
  expect(checkSpecV2(model, d).ok).toBe(false);
});
it('raw amounts remain exact decimal strings through encoding', () => {
  const d = draft(); d.spec.creatorBuy = '12345678901234567';
  const r = checkSpecV2(model, d);
  expect(r.ok, JSON.stringify(r.problems ?? r.explanation)).toBe(true);
  expect(r.wire.creatorBuy).toBe(12_345_678_901_234_567n);
});
describe("the indexer's GET (review round 2, low 4)", () => {
  const url = 'https://indexer.test/v2/listings';
  const body = JSON.stringify(answerOf());

  it('takes https, or http on this computer only', () => {
    for (const ok of ['https://indexer.test/v2/listings', 'http://localhost:8080/v2', 'http://127.0.0.1/v2', 'http://[::1]/v2']) expect(indexerUrlOk(ok), ok).toBe(true);
    for (const no of ['http://indexer.test/v2', 'http://localhost.indexer.test/v2', 'ftp://indexer.test/x', 'not a url']) expect(indexerUrlOk(no), no).toBe(false);
  });

  it('follows no redirect and reads at most 1 MB', async () => {
    const seen: RequestInit[] = [];
    const answers = (response: () => Response) => async (_u: string, init: RequestInit) => (seen.push(init), response());
    await expect(fetchIndexerAnswer(url, { fetch: answers(() => new Response(body)) })).resolves.toMatchObject({ format: 'squarehole.listings/1', network: 'demo' });
    expect(seen[0]?.redirect).toBe('error');
    const moved = { ok: true, redirected: true, status: 200, headers: new Headers(), body: null } as unknown as Response;
    await expect(fetchIndexerAnswer(url, { fetch: answers(() => moved) })).rejects.toThrow('the indexer redirected the request');
    await expect(fetchIndexerAnswer(url, { fetch: answers(() => new Response('{}', { headers: { 'content-length': '2000000' } })) })).rejects.toThrow('the answer is larger than 1 MB');
    await expect(fetchIndexerAnswer(url, { fetch: answers(() => new Response(`"${'x'.repeat(1_000_000)}"`)) })).rejects.toThrow('the answer is larger than 1 MB');
    await expect(fetchIndexerAnswer(url, { fetch: answers(() => new Response('nope', { status: 503 })) })).rejects.toThrow('HTTP 503');
  });

  it('never repeats a body that is not JSON (round 3, low 1)', async () => {
    const error = await fetchIndexerAnswer(url, { fetch: async () => new Response('\u001b]0;pwned\u0007\u001b[2J') }).catch((e: Error) => e);
    expect((error as Error).message).toBe('the answer is not JSON');
  });
});

