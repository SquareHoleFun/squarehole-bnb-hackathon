import { mkdirSync, mkdtempSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { CoreGateway, type CoreGatewaySource } from '../../src/core/core-gateway';
import { createWithheldPictures } from '../../src/withheld/list.mjs';
import { request, ResponseDouble } from '../links/fixture';

it('W4: v2 serves sorted domain-separated hashes only, with 60 s cache and normal CORS, without chain reads', async () => {
  mkdirSync('.cache/tmp', { recursive: true });
  const dir = mkdtempSync(resolve('.cache/tmp/withheld-api-'));
  const file = join(dir, 'pictures.json');
  const ids = [`ar:${'A'.repeat(43)}`, `ipfs:bafkreia${'a'.repeat(51)}`, `ar:${'B'.repeat(42)}A`];
  writeFileSync(file, JSON.stringify(ids.map(id => ({ id, reason: 'illegal', since: '2026-10-28' }))));
  let now = 0;
  const gw = new CoreGateway({ source: {} as CoreGatewaySource, port: 0, host: '127.0.0.1', withheld: createWithheldPictures({ file, now: () => now }) });
  const send = async (url = '/v2/withheld', method = 'GET') => {
    const res = new ResponseDouble(); await gw.route(request(undefined, { url, method }).req, res.asResponse()); return res;
  };
  const res = await send();
  expect(res.status).toBe(200);
  expect(res.json()).toEqual({ version: 1, hashes: ids.map(id => createHash('sha256').update(`sh-withheld-v1:${id}`).digest('hex')).sort() });
  expect(res.headers).toMatchObject({ 'cache-control': 'max-age=60', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'If-None-Match' });
  for (const answer of [res, await send('/v2/withheld', 'OPTIONS'), await send('/v2/withheld', 'POST'), await send('/v2/withheld?raw=1')]) {
    for (const id of ids) expect(answer.body).not.toContain(id);
    expect(answer.body).not.toMatch(/illegal|since|legal-notice/);
  }
  expect((await send('/v2/withheld', 'POST')).status).toBe(405);
  renameSync(file, join(dir, 'saved.json')); now += 10_000;
  expect((await send()).json()).toEqual({ version: 1, hashes: [] });
});
it('W2: the older v1 item-picture byte route cannot bypass a listed CID, including an in-flight read', async () => {
  mkdirSync('.cache/tmp', { recursive: true });
  const dir = mkdtempSync(resolve('.cache/tmp/withheld-item-')); const file = join(dir, 'pictures.json');
  const cid = `bafkreia${'a'.repeat(51)}`; const id = `ipfs:${cid}`; let now = 0;
  const publish = () => { writeFileSync(file, JSON.stringify([{ id, reason: 'illegal', since: '2026-10-28' }])); now += 10_000; };
  const itemArt = vi.fn(async () => new Uint8Array([7, 8]));
  const source = { chainId: 11155111, box: () => ({}), item: () => ({ art: { image: { cid }, avatar: { cid } } }), itemArt } as unknown as CoreGatewaySource;
  const gw = new CoreGateway({ source, port: 0, host: '127.0.0.1', withheld: createWithheldPictures({ file, now: () => now }) });
  const send = async (role = 'image') => {
    const res = new ResponseDouble();
    await gw.route(request(undefined, { method: 'GET', url: `/v1/boxes/11155111/0x${'12'.repeat(20)}/items/1/art/${role}` }).req, res.asResponse()); return res;
  };
  expect((await send()).status).toBe(200); itemArt.mockClear(); publish();
  for (const role of ['image', 'avatar']) {
    const res = await send(role); expect(res.status).toBe(451); expect(res.headers['cache-control']).toBe('no-store'); expect(res.body).not.toContain(id);
  }
  expect(itemArt).not.toHaveBeenCalled();
  writeFileSync(file, '[]'); now += 10_000;
  itemArt.mockImplementationOnce(async () => { publish(); return new Uint8Array([7, 8]); });
  expect((await send()).status).toBe(451);
});
