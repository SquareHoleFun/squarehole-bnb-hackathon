import { Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { keccak256, type Hex } from 'viem';
import { afterEach, expect, it, vi } from 'vitest';
import { startCoreService } from '../../src/core/core-service';
import { m2Fixture } from '../../src/core/v2/m2-fixture.test-support';
import { encodeBoxSpecV2 } from '../../src/core/v2/chain-v2';
import { PictureCopiesService } from '../../src/pictures/service';
import { MemoryPictureCopies } from '../../src/pictures/store';
import { pictureCopiesSchema } from '../../src/pictures/types';
import { GRAPHQL_ENDPOINTS } from '../../src/pictures/discovery';
import { World } from '../core/core-synth';
import { boxLogsV2, serviceChainV2 } from '../core/scripted-core-chain';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it.each(['discovery', 'hint'])('real service publishes %s copies in feed and box responses, never bytes', async mode => {
  vi.useFakeTimers();
  const listen = vi.spyOn(Server.prototype, 'listen').mockImplementation(function (this: Server, ...args: unknown[]) {
    const callback = args.at(-1); if (typeof callback === 'function') callback(); return this;
  });
  const request = (url: string, method = 'GET', value?: unknown, peer = '192.0.2.1', forwarded = ''): Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, string> }> => new Promise(resolve => {
    const server = listen.mock.contexts[0] as Server; let status = 0;
    let headers: Record<string, string> = {};
    const req = Object.assign(Readable.from(value === undefined ? [] : [JSON.stringify(value)]),
      { method, url, headers: { 'content-type': 'application/json', 'x-forwarded-for': forwarded }, socket: { remoteAddress: peer }, complete: true });
    server.emit('request', req as unknown as IncomingMessage, {
      writeHead(code: number, values: Record<string, string>) { status = code; headers = values; }, end(body: string) { resolve({ status, body: body ? JSON.parse(body) : {}, headers }); },
    } as unknown as ServerResponse);
  });
  const bytes = 'the picture body'; const digest = createHash('sha256').update(bytes).digest('hex'); const id = 'z'.repeat(43);
  const base = m2Fixture(false);
  const spec = { ...base.spec, coverSha256: `0x${digest}` as Hex, collectionCoverSha256: `0x${digest}` as Hex };
  const encodedSpec = encodeBoxSpecV2(spec); const record = { ...base.record, specHash: keccak256(encodedSpec) };
  const f = { ...base, spec, encodedSpec, record, row: { ...base.row, ...record, record, spec, encodedSpec, contracts: base.row.contracts } };
  const world = new World('picture-enrichment'); world.block(10n); world.block(100n, [boxLogsV2(f)]); world.to(105n);
  const chain = serviceChainV2(world, [f], (_box, key) => key === 'receiver.buyersChoice' ? 4 : undefined);
  const fetcher = vi.fn<typeof fetch>(async input => GRAPHQL_ENDPOINTS.includes(String(input))
    ? Response.json({ data: { transactions: { edges: mode === 'hint' ? [] : [{ node: { id, block: { height: 1 } } }] } } }) : new Response(bytes));
  const pictures = new PictureCopiesService(new MemoryPictureCopies(), { fetch: fetcher });
  const service = await startCoreService({ reader: chain, manifest: f.manifest, host: '127.0.0.1', port: 5391, pictures });
  try {
    const path = `/v2/boxes/${f.row.chainId}/${f.at(1)}`;
    expect((await request(path)).status).toBe(200);
    expect((await request(path)).body).not.toHaveProperty('pictureCopies');
    expect(((await request('/v2/feed')).body.cards as unknown[])).toHaveLength(1);
    if (mode === 'hint') {
      await vi.advanceTimersByTimeAsync(0); await service.indexer.idle(); fetcher.mockClear();
      const hint = { chainId: f.row.chainId, box: f.at(0), kind: 'logo', arweaveId: id };
      const preflight = await request('/v2/pictures/hint', 'OPTIONS');
      expect(preflight.headers['Access-Control-Allow-Headers']).toContain('Content-Type');
      expect(preflight.headers['Access-Control-Allow-Methods']).toContain('POST');
      expect((await request('/v2/pictures/hint', 'GET')).status).toBe(405);
      for (const alias of ['/v2/pictures/hint/', '/v2/pictures/hint?x=1', '/v2/pictures/%68int']) {
        expect((await request(alias, 'POST', hint)).status).toBe(405);
      }
      // A token address is not the coordinator address accepted by this API.
      expect((await request('/v2/pictures/hint', 'POST', { ...hint, box: f.at(1) })).status).toBe(404);
      const accepted = await request('/v2/pictures/hint', 'POST', hint);
      expect(accepted.status).toBe(200); expect(accepted.body).toEqual({ arweaveId: id });
      expect(accepted.headers['Cache-Control']).toBe('no-store');
      for (let n = 0; n < 8; n++) expect((await request('/v2/pictures/hint', 'POST', hint)).status).toBe(200);
      const limited = await request('/v2/pictures/hint', 'POST', hint, '192.0.2.1', '192.0.2.99');
      expect(limited.status).toBe(429); expect(limited.headers['Retry-After']).toBe('60');
      for (let n = 0; n < 10; n++) expect((await request('/v2/pictures/hint', 'POST', hint, `2001:db8:0:1::${n}`)).status).toBe(200);
      expect((await request('/v2/pictures/hint', 'POST', hint, '2001:db8:0:1::ffff')).status).toBe(429);
    } else { await vi.advanceTimersByTimeAsync(0); await service.indexer.idle(); }
    const box = (await request(path)).body;
    const card = ((await request('/v2/feed')).body.cards as Record<string, unknown>[])[0];
    const copies = { logo: { arweaveId: id }, cover: { arweaveId: id } };
    expect(box.pictureCopies).toEqual(copies); expect(card?.pictureCopies).toEqual(copies);
    expect(pictureCopiesSchema.parse(box.pictureCopies)).toEqual(copies);
    expect(pictureCopiesSchema.parse(card?.pictureCopies)).toEqual(copies);
    expect(JSON.stringify([box, card])).not.toContain(bytes);
    expect((await request(`${path}/pictures`)).status).toBe(404);
    expect(fetcher).toHaveBeenCalledTimes(mode === 'hint' ? 1 : 4);
  } finally { await service.stop(); }
  expect(vi.getTimerCount()).toBe(0);
});

it('validates the exact optional wire shape', () => {
  expect(pictureCopiesSchema.safeParse({ logo: { arweaveId: 'a'.repeat(43) } }).success).toBe(true);
  for (const invalid of [{}, { logo: { arweaveId: '../x' } }, { cover: { arweaveId: 'a'.repeat(43), bytes: 'bad' } }, { url: 'https://example.com' }]) {
    expect(pictureCopiesSchema.safeParse(invalid).success).toBe(false);
  }
});
