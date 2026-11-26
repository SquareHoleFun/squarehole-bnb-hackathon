import '../register-ts.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { decodeAbiParameters } from 'viem';
import { ROOT, assertLocalRpc, localOptions } from './core-v2-local-runtime.mjs';
const { rawCid, loadArt, MemoryArtStore } = await import('../../../indexer/src/core/art.ts');
const { loadLogo } = await import('../../../cards/src/share-art.ts');

const artModule = () => import('./core-v2-local-art.mjs');
const digest = bytes => `0x${createHash('sha256').update(bytes).digest('hex')}`;
const zero = `0x${'0'.repeat(64)}`;
const names = ['plain', 'holders', 'shop', 'failure', 'everyItem', 'coinPile', 'usdc', 'stock', 'gold'];

test('LOCAL-ART-PORT: isolated default, all reserved ports and service collisions refused', () => {
  assert.equal(localOptions({}).artPort, 5387);
  for (const port of [8547, 8548, 8549, 8552, 8562, 8564, 5391, 5392, 4173, 4174, 4175, 5173,
    8566, 5396, 5395, 0, 65536, 1.5, 'nope', '']) {
    assert.throws(() => localOptions({ SH_CORE_V2_ART_PORT: String(port) }), /port/);
  }
  assert.equal(localOptions({ SH_CORE_V2_ART_PORT: '5388' }).artPort, 5388);
  for (const key of ['DEV_PORT', 'SH_CORE_V2_CHAIN_PORT', 'SH_CORE_V2_GATEWAY_PORT']) {
    assert.throws(() => localOptions({ [key]: '5387' }), /ports must differ/);
  }
});

test('LOCAL-ART-PORT: a reassigned art port does not reserve its default for RPC validation', async () => {
  const ports = localOptions({ SH_CORE_V2_CHAIN_PORT: '5387', SH_CORE_V2_ART_PORT: '5388' });
  await assertLocalRpc(`http://127.0.0.1:${ports.chainPort}`, async (_url, method) =>
    method === 'eth_chainId' ? '0xaa36a7' : 'anvil/local-test');
});

test('LOCAL-ART-SERVER: loopback binding, actual HTTP adapter and occupied-port failure without sockets', async () => {
  const { startLocalArtGateway, loadLocalArt } = await artModule();
  const art = loadLocalArt(); const ports = localOptions({});
  let serve;
  const fake = new EventEmitter();
  fake.listen = (port, host, ready) => { assert.equal(port, 5387); assert.equal(host, '127.0.0.1'); ready(); };
  assert.equal(await startLocalArtGateway(ports, { art, serverFactory: fn => { serve = fn; return fake; } }), fake);
  assert.equal(fake.listenerCount('error'), 0);
  assert.equal(fake.requestTimeout, 5000); assert.equal(fake.headersTimeout, 5000);
  let response;
  const sink = { writeHead: (status, headers) => { response = { status, headers }; }, end: body => { response.body = body; } };
  await serve({ method: 'GET', url: `/ipfs/${rawCid(art.catalog.boxes.plain.logo.sha256)}`, headers: { host: 'example.invalid' } }, sink);
  assert.equal(response.status, 200); assert.equal(digest(response.body), art.catalog.boxes.plain.logo.sha256);
  assert.equal(response.headers['access-control-allow-origin'], '*');
  const occupied = new EventEmitter();
  occupied.listen = () => occupied.emit('error', Object.assign(new Error('occupied'), { code: 'EADDRINUSE' }));
  await assert.rejects(startLocalArtGateway(ports, { art, serverFactory: () => occupied }), { code: 'EADDRINUSE' });
});

test('LOCAL-ART-FILES: every local spec has small, distinct, hash-committed PNG art', async () => {
  const { loadLocalArt } = await artModule();
  const { catalog } = loadLocalArt();
  assert.deepEqual(Object.keys(catalog.boxes).sort(), ['misfits', ...names].sort());
  const hashes = new Set();
  for (const [mode, name] of names.entries()) {
    const box = catalog.boxes[name];
    assert.equal(box.mode, mode);
    for (const [role, side] of [['logo', 512], ['cover', 1024]]) {
      const art = box[role];
      const bytes = readFileSync(join(ROOT, 'packages/chain/scripts/local-art', art.file));
      assert.equal(digest(bytes), art.sha256);
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.equal(bytes.readUInt32BE(16), side); assert.equal(bytes.readUInt32BE(20), side);
      assert.ok(bytes.length < 100_000, `${name} ${role} must stay small`);
      assert.ok(!hashes.has(art.sha256), `${name} ${role} must be distinct`); hashes.add(art.sha256);
    }
    assert.equal(box.spec.coverSha256, box.logo.sha256);
    assert.equal(box.spec.collectionCoverSha256, mode === 4 ? box.cover.sha256 : zero);
  }
});

test('LOCAL-ART-MISFITS: exact repository FIT logo, Sorter cover and approved banner', async () => {
  const { loadLocalArt } = await artModule();
  const { catalog } = loadLocalArt();
  const misfits = catalog.boxes.misfits;
  const sources = {
    logo: 'packages/design/art/fit/fit-icon-512.png',
    cover: 'docs/design/misfits-v2/banner/final/misfits-collection-sorter-1024.png',
    banner: 'docs/design/misfits-v2/banner/final/misfits-banner-a-1600x400.png',
  };
  for (const [role, source] of Object.entries(sources)) {
    const entry = misfits[role];
    assert.equal(entry.source, source);
    const original = readFileSync(join(ROOT, source));
    assert.deepEqual(readFileSync(join(ROOT, 'packages/chain/scripts/local-art', entry.file)), original);
    assert.equal(entry.sha256, digest(original));
  }
  assert.equal(misfits.spec.coverSha256, misfits.logo.sha256);
  assert.equal(misfits.spec.collectionCoverSha256, misfits.cover.sha256);
  assert.equal(misfits.spec.addOns[0].id, 6);
  const [banner, teasers, link] = decodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32[]' }, { type: 'string' }], misfits.spec.addOns[0].params);
  assert.equal(banner, misfits.banner.sha256); assert.deepEqual(teasers, []); assert.equal(link, '');
});

test('LOCAL-ART-VERIFY: production indexer and card loader verify every actual file through the handler', async () => {
  const { loadLocalArt, createLocalArtHandler, localArtEnvironment } = await artModule();
  const art = loadLocalArt();
  const env = localArtEnvironment(localOptions({}));
  const origin = 'http://127.0.0.1:5387';
  for (const key of ['SH_CORE_ART_GATEWAYS', 'SH_CARDS_ART_GATEWAYS', 'SH_CORE_LOCAL_ART_GATEWAYS']) assert.equal(env[key], origin);
  const handle = createLocalArtHandler(art);
  const fetchArt = async (url, init) => handle(new Request(url, init));
  // The indexer's hash-checked loader (art.ts `loadArt`; since SH-NO-PICTURE-GATE no picture decides a listing).
  const options = { gateways: [origin], store: new MemoryArtStore(), fetch: fetchArt };
  const committed = (sha) => sha && !/^0x0{64}$/i.test(sha);
  for (const box of Object.values(art.catalog.boxes)) {
    for (const sha of [box.spec.coverSha256, box.spec.collectionCoverSha256].filter(committed)) {
      const bytes = await loadArt(sha, options);
      assert.ok(bytes, `${box.spec.tokenSymbol ?? 'box'}: ${sha} loads`);
      assert.equal(digest(bytes), sha.toLowerCase());
    }
    for (const role of ['logo', 'cover', 'banner']) {
      if (!box[role]) continue;
      const response = await fetchArt(`${origin}/ipfs/${rawCid(box[role].sha256)}`);
      assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
      assert.equal(response.headers.get('access-control-allow-origin'), '*');
      assert.equal(digest(new Uint8Array(await response.arrayBuffer())), box[role].sha256);
    }
    assert.ok(await loadLogo(box.logo.sha256, [origin], fetchArt, 1000));
  }
  // Wrong bytes are refused and nothing is kept.
  const store = new MemoryArtStore();
  assert.equal(await loadArt(art.catalog.boxes.plain.spec.coverSha256, { gateways: [origin], store, fetch: async () => new Response('wrong bytes') }), null);
  assert.equal(await store.get(art.catalog.boxes.plain.spec.coverSha256), null);
  assert.equal(await loadLogo(art.catalog.boxes.plain.logo.sha256, [origin], async () => new Response('wrong bytes'), 1000), null);
});

test('LOCAL-ART-HTTP: only committed raw CIDs, GET/HEAD, CORS and bounded startup reads', async () => {
  const { loadLocalArt, createLocalArtHandler } = await artModule();
  const art = loadLocalArt(); const handle = createLocalArtHandler(art);
  const path = `/ipfs/${rawCid(art.catalog.boxes.plain.logo.sha256)}`;
  for (const url of ['/catalog.json', '/../../CLAUDE.md', '/ipfs/../CLAUDE.md', '/ipfs/%2e%2e%2fCLAUDE.md',
    '/ipfs/not-a-cid', `/ipfs/${rawCid(zero)}`, `${path}/extra`, `${path}?download=1`]) {
    assert.equal((await handle(new Request(`http://127.0.0.1:5387${url}`))).status, 404);
  }
  assert.equal((await handle(new Request(`http://127.0.0.1:5387${path}`, { method: 'POST' }))).status, 405);
  const head = await handle(new Request(`http://127.0.0.1:5387${path}`, { method: 'HEAD' }));
  assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.ok(BigInt(head.headers.get('content-length')) > 0n);
  assert.match(head.headers.get('cache-control'), /immutable/);
  const ready = await handle(new Request('http://127.0.0.1:5387/health'));
  assert.equal(ready.status, 200);
  assert.throws(() => loadLocalArt({ readBytes: () => Buffer.from('tampered') }), /sha256|hash/);
});
