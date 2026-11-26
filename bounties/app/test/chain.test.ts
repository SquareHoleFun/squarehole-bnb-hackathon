import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkReadChain, publicClientFor } from '../src/lib/chain';
import type { AppConfig } from '../src/lib/config';

// Local endpoints: one on chain 97, one on chain 1, one that redirects to the chain-97 one, one that is closed.
const servers: http.Server[] = [];
const hits: Record<string, number> = { good: 0, other: 0, redirect: 0 };
async function serve(name: string, answer: (res: http.ServerResponse, id: unknown) => void): Promise<string> {
  const s = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d)).on('end', () => {
      hits[name] = (hits[name] ?? 0) + 1;
      const j = JSON.parse(body || '{}');
      answer(res, Array.isArray(j) ? j[0]?.id : j.id);
    });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
const chainAnswer = (hex: string) => (res: http.ServerResponse, id: unknown) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ jsonrpc: '2.0', id, result: hex }));
};
let good = '';
let other = '';
let redirect = '';
const closed = 'http://127.0.0.1:9';
beforeAll(async () => {
  good = await serve('good', chainAnswer('0x61'));
  other = await serve('other', chainAnswer('0x1'));
  redirect = await serve('redirect', (res) => {
    res.statusCode = 307;
    res.setHeader('location', good);
    res.end();
  });
});
afterAll(() => servers.forEach((s) => s.close()));

const cfg = (rpcUrls: string[]) => ({ rpcUrls, explorer: 'https://testnet.bscscan.com' }) as AppConfig;

describe('read endpoints (re-read findings 6 and 7)', () => {
  it('only endpoints that answered 97 read for the page, in the file’s order', async () => {
    expect(await checkReadChain(cfg([closed, good]))).toEqual({ ok: true, rpcUrls: [good] });
  });
  it('an endpoint on another chain stops the page', async () => {
    expect(await checkReadChain(cfg([good, other]))).toMatchObject({ ok: false });
  });
  it('a redirect is not followed, at the start probe and on the reading client', async () => {
    const before = hits.good!;
    expect(await checkReadChain(cfg([redirect]))).toEqual({ ok: false, problem: 'no read endpoint answered' });
    await expect(publicClientFor(cfg([redirect])).getChainId()).rejects.toThrow();
    expect(hits.good).toBe(before);
    expect(hits.redirect).toBeGreaterThan(0);
  });
  it('no off-chain lookup (CCIP Read) on the reading client', () => {
    expect(publicClientFor(cfg([good])).ccipRead).toBe(false);
  });
});
