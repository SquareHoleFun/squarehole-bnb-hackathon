import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';
import { ClaimsGatewayV2 } from '../../../src/core/v2/claims-gateway-v2';
import { readAllWalletClaimsV2, readWalletClaimsPageV2 } from '../../../../chain/src/core/v2/claims-reader';
import type { CoreGatewayOptions } from '../../../src/core/core-gateway';
import { H, A, B, m2Fixture } from '../../../src/core/v2/m2-fixture.test-support';
import type { WalletClaimV2, WalletClaimsPageV2 } from '../../../../chain/src/core/v2/claims-types';
import type { Address } from 'viem';

const f = m2Fixture(false);
const lower = (a: string) => a.toLowerCase() as Address;
const asOf = { block: '100', hash: H(100), timestamp: '1000', tier: 'head' as const };
const row: WalletClaimV2 = { id: 'holder:1', kind: 'holder', status: 'claimable', batchId: '1', wallet: lower(A),
  box: { registry: lower(f.row.registry), boxId: '52', token: lower(f.at(1)) },
  roleAddress: lower(f.at(17)), asset: f.row.q, amountP: '900719925474099300000001', asOf, payment: null, payout: 'unverified' };
const page: WalletClaimsPageV2 = { schema: 'sh.core-claims.v2', chainId: f.row.chainId, wallet: lower(A), asOf, recentFromBlock: '0', items: [row], next: null };
const options = { source: { chainId: f.row.chainId, health: () => ({ following: true, reason: null, history: null }), feed: () => ({ asOf }) }, port: 5391, host: '127.0.0.1' } as unknown as CoreGatewayOptions;

async function request(gateway: ClaimsGatewayV2, path: string, method = 'GET') {
  const response = { status: 0, headers: {} as Record<string, string>, body: '', writeHead(status: number, headers: Record<string, string>) { this.status = status; this.headers = headers; }, end(body = '') { this.body = body; } };
  await gateway.route({ url: path, method } as IncomingMessage, response as unknown as ServerResponse);
  return response;
}

it('CLAIMS-03 serves read-only no-store JSON without a localhost listener and keeps existing routes', async () => {
  const claims = { page: vi.fn(async () => page) };
  const gateway = new ClaimsGatewayV2(options, claims);
  const path = `/v2/wallets/${f.row.chainId}/${A}/claims`;
  const got = await request(gateway, `${path}?limit=3`);
  expect(got.status).toBe(200); expect(JSON.parse(got.body)).toEqual(page);
  expect(got.headers['Cache-Control']).toBe('no-store');
  expect(got.headers['Access-Control-Allow-Origin']).toBe('*');
  expect(claims.page).toHaveBeenCalledWith(A.toLowerCase(), { after: null, limit: 3 });
  expect((await request(gateway, path, 'POST')).status).toBe(405);
  expect((await request(gateway, path, 'OPTIONS')).status).toBe(204);
  expect((await request(gateway, `${path}?limit=101`)).status).toBe(400);
  expect((await request(gateway, `/v2/wallets/999/${A}/claims`)).status).toBe(404);
  expect((await request(gateway, '/v1/feed')).status).toBe(200);
});

it('CLAIMS-04 reader follows even empty pages, preserving one snapshot and decimal strings', async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ ...page, items: [], next: 'opaque' })))
    .mockResolvedValueOnce(new Response(JSON.stringify(page)));
  const got = await readAllWalletClaimsV2({ baseUrl: 'https://index.example', chainId: f.row.chainId, wallet: A, fetch: fetcher });
  expect(got.items).toEqual([row]); expect(got.next).toBeNull();
  expect(String(fetcher.mock.calls[1]?.[0])).toContain('after=opaque');
  expect(got.items[0]?.amountP).toBe('900719925474099300000001');
});

it.each([
  { ...page, wallet: B }, { ...page, chainId: 999 },
  { ...page, items: [{ ...row, amountP: 9007199254740992 }] },
  { ...page, items: [{ ...row, amountP: '1e18' }] },
  { ...page, items: [{ ...row, amountP: '-1' }] },
  { ...page, items: [{ ...row, asOf: { ...asOf, hash: H(999) } }] },
  { ...page, items: [{ ...row, status: 'claimed' }] },
])('CLAIMS-04 rejects untrusted or mismatched transport data %#', async bad => {
  await expect(readWalletClaimsPageV2({ baseUrl: 'https://index.example', chainId: f.row.chainId, wallet: A, fetch: async () => new Response(JSON.stringify(bad)) })).rejects.toThrow();
});

it('CLAIMS-04 refuses page loops, mixed hashes, and HTTP errors instead of returning partial Claim all', async () => {
  const args = { baseUrl: 'https://index.example', chainId: f.row.chainId, wallet: A };
  await expect(readAllWalletClaimsV2({ ...args, fetch: async () => new Response(JSON.stringify({ ...page, items: [], next: 'same' })) })).rejects.toThrow(/cursor|repeat|loop/i);
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ...page, items: [], next: 'next' })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ...page, asOf: { ...asOf, hash: H(999) }, items: [] })));
  await expect(readAllWalletClaimsV2({ ...args, fetch: fetcher })).rejects.toThrow(/snapshot|hash/i);
  await expect(readWalletClaimsPageV2({ ...args, fetch: async () => new Response('{}', { status: 409 }) })).rejects.toThrow(/409/);
});
