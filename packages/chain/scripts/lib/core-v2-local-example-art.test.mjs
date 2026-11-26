import '../register-ts.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { localOptions } from './core-v2-local-runtime.mjs';
import { EXAMPLE_ART_SCHEMA, MAX_ART_BYTES, loadExampleArt, resetExampleArt, sha256Hex, writeExampleArt } from './core-v2-local-example-art.mjs';
const { rawCid, loadArt, MemoryArtStore } = await import('../../../indexer/src/core/art.ts');
const { loadLogo } = await import('../../../cards/src/share-art.ts');
const { createLocalArtHandler, exampleArtFiles, loadLocalArt, startLocalArtGateway } = await import('./core-v2-local-art.mjs');

const ZERO = `0x${'0'.repeat(64)}`;
const ORIGIN = 'http://127.0.0.1:5387';
// A real PNG that is in no catalogue: like a browser re-encoding, its bytes (and hash) are new.
function png(seed) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('tEXt', Buffer.from(`Comment\0${seed}`, 'latin1')), chunk('IDAT', deflateSync(Buffer.from([0, 200, 30, 30, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
const directory = () => mkdtempSync(join(tmpdir(), 'sh-example-art-'));
const catalogText = dir => readFileSync(join(dir, 'catalog.json'), 'utf8');
const get = async (handle, path, method = 'GET') => handle(new Request(`${ORIGIN}${path}`, { method }));

test('EXAMPLE-ART-WRITE: only checked, committed PNG bytes enter a catalogue the example stack started', () => {
  const dir = directory();
  const logo = png('logo'); const sha = sha256Hex(logo);
  assert.throws(() => writeExampleArt(dir, 'one-dollar', [{ role: 'logo', sha256: sha, bytes: logo }]), /example stack starts it/);
  resetExampleArt(dir);
  assert.deepEqual(JSON.parse(catalogText(dir)), { schema: EXAMPLE_ART_SCHEMA, pictures: {} });
  const empty = catalogText(dir);
  const refused = [
    [{ role: 'logo', sha256: sha256Hex(png('other')), bytes: logo }, /sha256\/size mismatch/],
    [{ role: 'logo', sha256: sha.toUpperCase().replace('0X', '0x'), bytes: logo }, /invalid sha256/],
    [{ role: 'banner', sha256: sha, bytes: logo }, /unknown picture role/],
    [{ role: 'logo', sha256: sha256Hex(Buffer.alloc(40, 7)), bytes: Buffer.alloc(40, 7) }, /not PNG/],
    [{ role: 'logo', sha256: sha256Hex(logo.subarray(0, 32)), bytes: logo.subarray(0, 32) }, /not PNG/],
  ];
  const big = Buffer.concat([logo, Buffer.alloc(MAX_ART_BYTES + 1 - logo.length)]);
  refused.push([{ role: 'logo', sha256: sha256Hex(big), bytes: big }, /sha256\/size mismatch/]);
  for (const [picture, reason] of refused) {
    // Checked before any write: a refused picture never reaches the folder or the catalogue.
    assert.throws(() => writeExampleArt(dir, 'one-dollar', [{ role: 'logo', sha256: sha, bytes: logo }, picture]), reason);
    assert.equal(catalogText(dir), empty);
    assert.equal(existsSync(join(dir, `art-${sha.slice(2)}.png`)), false);
  }
  for (const id of ['One Dollar', 'link-marines-V2', '2-link-marines', 'link-marines-v2/other', 'link--marines', 'link-marines-']) {
    assert.throws(() => writeExampleArt(dir, id, [{ role: 'logo', sha256: sha, bytes: logo }]), /invalid example id/, id);
  }
  assert.throws(() => writeExampleArt(dir, 'one-dollar', []), /no pictures/);
  assert.equal(catalogText(dir), empty);

  assert.deepEqual(writeExampleArt(dir, 'one-dollar', [{ role: 'logo', sha256: sha, bytes: logo }]),
    [{ role: 'logo', sha256: sha, file: `art-${sha.slice(2)}.png`, bytes: String(logo.length) }]);
  assert.deepEqual(readFileSync(join(dir, `art-${sha.slice(2)}.png`)), logo);
  writeExampleArt(dir, 'gpu-poor', [{ role: 'logo', sha256: sha, bytes: logo }]);
  // A versioned kit id, as the registry allows it (SH-EX-LMV2).
  writeExampleArt(dir, 'link-marines-v2', [{ role: 'logo', sha256: sha, bytes: logo }]);
  assert.deepEqual(JSON.parse(catalogText(dir)).pictures, { [sha]: { file: `art-${sha.slice(2)}.png`, sha256: sha,
    bytes: String(logo.length), type: 'image/png', uses: ['gpu-poor:logo', 'link-marines-v2:logo', 'one-dollar:logo'] } });
  resetExampleArt(dir);
  assert.equal(catalogText(dir), empty, 'a new example stack serves no earlier run');
});

test('EXAMPLE-ART-LOAD: every read re-checks name, size, type and SHA-256, and one bad entry refuses all', () => {
  const dir = directory(); resetExampleArt(dir);
  const logo = png('logo'); const cover = png('cover');
  writeExampleArt(dir, 'bag-holders', [{ role: 'logo', sha256: sha256Hex(logo), bytes: logo }, { role: 'collection cover', sha256: sha256Hex(cover), bytes: cover }]);
  const loaded = loadExampleArt(dir);
  assert.deepEqual([...loaded.keys()].sort(), [sha256Hex(logo), sha256Hex(cover)].sort());
  assert.deepEqual(loaded.get(sha256Hex(cover)), cover);
  assert.throws(() => loadExampleArt(dir, { readBytes: () => Buffer.from('tampered') }), /sha256\/size mismatch/);
  const good = JSON.parse(catalogText(dir));
  const tamper = (mutate, reason) => {
    const catalog = structuredClone(good); mutate(catalog.pictures[sha256Hex(logo)], catalog);
    writeFileSync(join(dir, 'catalog.json'), JSON.stringify(catalog));
    assert.throws(() => loadExampleArt(dir), reason);
  };
  tamper(entry => { entry.bytes = String(logo.length + 1); }, /size mismatch/);
  tamper(entry => { entry.type = 'image/svg+xml'; }, /invalid example art/);
  tamper(entry => { entry.file = '../catalog.json'; }, /invalid example art/);
  tamper(entry => { entry.file = `art-${sha256Hex(cover).slice(2)}.png`; }, /invalid example art/);
  tamper((_entry, catalog) => { catalog.schema = 'sh.local-art.v1'; }, /unknown example art catalogue/);
  writeFileSync(join(dir, 'catalog.json'), JSON.stringify(good));
  assert.equal(loadExampleArt(dir).size, 2);
});

test('EXAMPLE-ART-SERVE: written pictures are served exactly, and the production checkers verify them', async () => {
  const dir = directory(); resetExampleArt(dir);
  const logo = png('logo'); const cover = png('cover');
  const reports = [];
  const handle = createLocalArtHandler({ files: exampleArtFiles(loadLocalArt().files, dir, { report: message => reports.push(message) }) });
  const path = `/ipfs/${rawCid(sha256Hex(logo))}`;
  assert.equal((await get(handle, path)).status, 404, 'nothing is served before the example writes it');
  writeExampleArt(dir, 'bag-holders', [{ role: 'logo', sha256: sha256Hex(logo), bytes: logo }, { role: 'collection cover', sha256: sha256Hex(cover), bytes: cover }]);
  const response = await get(handle, path);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('content-length'), String(logo.length));
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), logo);
  for (const url of [`${path}/extra`, `${path}?download=1`, `/ipfs/${rawCid(ZERO)}`, '/catalog.json', `/art-${sha256Hex(logo).slice(2)}.png`]) {
    assert.equal((await get(handle, url)).status, 404, url);
  }
  assert.equal((await get(handle, path, 'POST')).status, 405);
  const plain = loadLocalArt().catalog.boxes.plain;
  assert.equal((await get(handle, `/ipfs/${rawCid(plain.logo.sha256)}`)).status, 200, 'the catalogue is still served');
  const fetchArt = async (url, init) => handle(new Request(url, init));
  // The indexer's hash-checked loader (art.ts `loadArt`) gets both pictures from this gateway; wrong bytes never pass.
  const store = new MemoryArtStore();
  assert.deepEqual(Buffer.from(await loadArt(sha256Hex(logo), { gateways: [ORIGIN], store, fetch: fetchArt })), logo);
  assert.deepEqual(Buffer.from(await loadArt(sha256Hex(cover), { gateways: [ORIGIN], store, fetch: fetchArt })), cover);
  assert.equal(await loadArt(sha256Hex(png('never served')), { gateways: [ORIGIN], store, fetch: async () => new Response(logo) }), null);
  const card = await loadLogo(sha256Hex(logo), [ORIGIN], fetchArt, 1000);
  assert.equal(card.type, 'image/png'); assert.deepEqual(Buffer.from(card.bytes), logo);
  // A picture changed on disk refuses the next catalogue whole; the bytes already checked stay the committed ones.
  writeFileSync(join(dir, `art-${sha256Hex(cover).slice(2)}.png`), png('swapped'));
  const later = png('later');
  writeExampleArt(dir, 'rent-free', [{ role: 'logo', sha256: sha256Hex(later), bytes: later }]);
  assert.equal((await get(handle, `/ipfs/${rawCid(sha256Hex(later))}`)).status, 404);
  assert.match(reports.join('\n'), /catalogue refused, nothing new is served: local art sha256\/size mismatch/);
  assert.deepEqual(Buffer.from(await (await get(handle, `/ipfs/${rawCid(sha256Hex(cover))}`)).arrayBuffer()), cover);
  assert.equal(reports.length, 1, 'an unchanged refused catalogue is not re-read');
});

test('EXAMPLE-ART-STACKS: only a gateway started with exampleArt serves it; the default local stack is unchanged', async () => {
  const dir = directory(); resetExampleArt(dir);
  const logo = png('logo');
  writeExampleArt(dir, 'staking-snails', [{ role: 'logo', sha256: sha256Hex(logo), bytes: logo }]);
  const art = loadLocalArt(); const ports = localOptions({});
  const served = async options => {
    let serve; const fake = new EventEmitter();
    fake.listen = (_port, _host, ready) => ready();
    await startLocalArtGateway(ports, { art, serverFactory: fn => { serve = fn; return fake; }, ...options });
    let response;
    const sink = { writeHead: status => { response = { status }; }, end: body => { response.body = body; } };
    await serve({ method: 'GET', url: `/ipfs/${rawCid(sha256Hex(logo))}` }, sink);
    return response;
  };
  assert.equal((await served({})).status, 404, 'the founder stack never reads the example catalogue');
  const example = await served({ exampleArt: dir });
  assert.equal(example.status, 200); assert.deepEqual(Buffer.from(example.body), logo);
  // The committed catalogue is checked at startup exactly as before (SH-V2-LOCAL-ART).
  assert.throws(() => loadLocalArt({ readBytes: () => Buffer.from('tampered') }), /sha256|hash/);
});
