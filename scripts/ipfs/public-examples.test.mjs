import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { bundleAssets, exportExamples } from '../../infra/server/ipfs/export-examples.mjs';
import { exportKit } from '../../infra/server/ipfs/export-kit.mjs';
import { createArtHandler } from '../../infra/server/ipfs/gateway.mjs';
import { contentType } from '../../infra/server/ipfs/content.mjs';
import { checkGateway } from './check-gateway.mjs';
import { rawCidV1 } from './pin-raw-lib.mjs';

const digest = bytes => `0x${createHash('sha256').update(bytes).digest('hex')}`;
const record = bytes => ({ cid: rawCidV1(digest(bytes)), sha256: digest(bytes), bytes: bytes.length });
const png = Buffer.from('89504e470d0a1a0a', 'hex');
const zero = `0x${'0'.repeat(64)}`;
const listFor = (image, model) => Buffer.from(JSON.stringify({ format: 'squarehole.box-reveal-list/1', items: [
  { avatarSha256: zero, id: '1', imageSha256: digest(image), modelSha256: model ? digest(model) : zero, salt: zero, traitsPacked: '0' },
], n: '1' }));

// In-process public route backed by CAR raw blocks: no listener, Kubo, DNS or network.
function gatewayFetch(blocks) {
  const handler = createArtHandler({ fetch: async (url, options) => {
    assert.equal(options.redirect, 'error');
    const bytes = blocks.get(new URL(url).pathname.split('/').at(-1));
    return bytes ? new Response(bytes) : new Response(null, { status: 404 });
  } });
  return async (url, options) => {
    assert.equal(options.redirect, 'error');
    const response = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
    await handler({ url: new URL(url).pathname, method: options.method }, response);
    return new Response(response.body, { status: response.status, headers: response.headers });
  };
}

test('L2 Bent Cans mint plan and Solidity CID expectations agree with the generated catalog for ids 1..14', async () => {
  const catalog = JSON.parse(await readFile('examples/boxes/junkyard/test-collections/catalog.json'));
  const plan = JSON.parse(await readFile('examples/boxes/one-collection-shop/mint-plan.json'));
  const fixture = await readFile('packages/contracts/test/sepolia-v2/BentCansCatalog.sol', 'utf8');
  assert.deepEqual([...fixture.matchAll(/"(bafkrei[a-z2-7]+)"/g)].map(match => match[1]), catalog.collections[0].items.map(item => item.cid));
  assert.equal(plan.items.length, 14);
  for (const [index, item] of plan.items.entries()) {
    const id = BigInt(index) + 1n;
    assert.equal(item.id, String(id));
    assert.equal(item.picture, id % 2n === 1n ? '1' : '2');
    assert.equal(item.cid, catalog.collections[0].items.find(picture => picture.id === item.picture).cid);
    assert.equal(item.recipient, id <= 12n ? 'creator-safe' : 'tester');
    assert.equal(item.use, id <= 2n ? 'junkyard' : id <= 12n ? 'one-collection-shop' : 'sell-back-test');
  }
});

// Independent framing check: each image must occur as a complete raw block AND a pinned CAR root.
function carBlocks(bytes) {
  let offset = 0;
  const varint = () => {
    let value = 0; let shift = 0; let byte;
    do { assert.ok(offset < bytes.length); byte = bytes[offset++]; value += (byte & 127) * 2 ** shift; shift += 7; } while (byte & 128);
    return value;
  };
  const headerLength = varint();
  const header = bytes.subarray(offset, offset += headerLength);
  assert.equal(header.subarray(0, 7).toString('hex'), 'a265726f6f7473');
  let at = 7;
  const array = header[at++];
  const count = array < 0x98 ? array - 0x80 : array === 0x98 ? header[at++] : header.readUInt16BE(at);
  if (array === 0x99) at += 2;
  assert.ok(count > 0);
  const roots = [];
  for (let i = 0; i < count; i++) {
    assert.equal(header.subarray(at, at += 5).toString('hex'), 'd82a582500');
    roots.push(header.subarray(at, at += 36).toString('hex'));
  }
  assert.equal(header.subarray(at).toString('hex'), '6776657273696f6e01');
  const result = new Map();
  while (offset < bytes.length) {
    const length = varint();
    const cid = bytes.subarray(offset, offset += 36);
    const block = bytes.subarray(offset, offset += length - 36);
    assert.equal(cid.subarray(0, 4).toString('hex'), '01551220');
    assert.equal(digest(block), `0x${cid.subarray(4).toString('hex')}`);
    assert.ok(roots.includes(cid.toString('hex')), 'every block is pinned as a root');
    result.set(rawCidV1(digest(block)), block);
  }
  assert.equal(offset, bytes.length);
  assert.equal(result.size, roots.length);
  return result;
}

test('L2 exports thirteen open kits and all ten distinct Junk images without hidden art or overwrites', async () => {
  await mkdir('.cache/tmp', { recursive: true });
  const parent = await mkdtemp('.cache/tmp/l2-public-');
  const directory = resolve(parent, 'export');
  const inventory = await exportExamples(directory);
  assert.equal(inventory.format, 'squarehole.public-example-pins/1');
  // Link Marines in both versions (F151): version 2 is the Sepolia example, version 1 the archival Eat kit.
  assert.deepEqual(inventory.kits, ['dragons-hoard', 'one-dollar', 'gpu-poor', 'bag-holders', 'exit-liquidity',
    'link-marines', 'link-marines-v2', 'rent-free', 'junkyard', 'the-alchemist', 'one-collection-shop', 'lake-house', 'card-shop']); // SH-262 adds the card shop
  assert.equal(inventory.cars.filter(car => car.endsWith('/pictures.car')).length, 13);
  assert.equal(inventory.cars.filter(car => car.startsWith('test-junk/')).length, 10);
  const catalog = JSON.parse(await readFile('examples/boxes/junkyard/test-collections/catalog.json'));
  for (const collection of catalog.collections) for (const item of collection.items) {
    assert.ok(inventory.files.some(file => file.cid === item.cid && file.sha256 === item.sha256 && file.bytes === item.bytes));
  }
  assert.ok(inventory.files.length > 80);
  assert.equal(new Set(inventory.files.map(file => file.cid)).size, inventory.files.length);
  assert.ok(inventory.files.some(file => file.mime === 'image/webp'), 'WebP logos/covers must enter pins.json');
  assert.equal(inventory.files.filter(file => file.role === 'public reveal list').length, 5);
  for (const file of inventory.files) {
    assert.ok(!file.path.includes('frog-kiln') && !file.path.includes('paper-certificates'));
    assert.deepEqual(record(await readFile(resolve(directory, file.path))), { cid: file.cid, sha256: file.sha256, bytes: file.bytes });
    assert.equal(contentType(await readFile(resolve(directory, file.path))), file.mime);
  }
  const blocks = new Map();
  for (const car of inventory.cars) for (const [cid, bytes] of carBlocks(await readFile(resolve(directory, car)))) blocks.set(cid, bytes);
  for (const file of inventory.files) assert.deepEqual(blocks.get(file.cid), await readFile(resolve(directory, file.path)));
  assert.deepEqual(JSON.parse(await readFile(resolve(directory, 'pins.json'))), inventory);
  const checked = await checkGateway(inventory, 'http://127.0.0.1:8080', {
    fetch: gatewayFetch(blocks),
  });
  assert.equal(checked, inventory.files.length);
  await assert.rejects(exportExamples(directory));
});

test('L2 gateway checks preflight every CID and reject corrupt, short, oversized, missing and redirected bytes', async () => {
  const bytes = png;
  const inventory = { format: 'squarehole.public-example-pins/1', files: [{ ...record(bytes), role: 'image', mime: 'image/png' }] };
  let calls = 0;
  const route = gatewayFetch(new Map([[rawCidV1(digest(bytes)), bytes]]));
  const good = async (url, options) => { calls++; return route(url, options); };
  assert.equal(await checkGateway(inventory, 'https://images.example', { fetch: good }), 1);
  assert.equal(calls, 2, 'GET and HEAD must both be checked');
  for (const response of [new Response('wrong'), new Response(Buffer.alloc(bytes.length)), new Response(bytes.subarray(1)),
    new Response(Buffer.alloc(1_048_577)), new Response(null, { status: 404 }),
    new Response(null, { status: 302, headers: { location: 'https://elsewhere.example' } })]) {
    await assert.rejects(checkGateway(inventory, 'http://localhost:8080', { fetch: async () => response }));
  }
  calls = 0;
  await assert.rejects(checkGateway({ ...inventory, files: [...inventory.files, { ...record(bytes), cid: 'bad' }] },
    'http://127.0.0.1:8080', { fetch: good }));
  assert.equal(calls, 0, 'invalid later entries must stop before requests');
  for (const origin of ['http://remote.example', 'https://user:pass@images.example', 'https://images.example/path']) {
    await assert.rejects(checkGateway(inventory, origin, { fetch: good }));
  }
});

test('T04 avatar-free GLBs, PNG/WebP and the final canonical list export as pinned raw roots and round-trip exactly', async () => {
  const parent = await mkdtemp('.cache/tmp/t04-public-');
  const model = await readFile('examples/boxes/rent-free/unique/samples/model-1.glb');
  const bag = await readFile('examples/boxes/bag-holders/unique/samples/model-1.glb');
  const webp = Buffer.from('524946461000000057454250565038200400000000000000', 'hex');
  const assets = [['picture.bin', 'image', png], ['rent.bin', 'model', model], ['bags.bin', 'model', bag],
    ['logo.bin', 'logo', webp], ['final.bin', 'public reveal list', listFor(png, model)]];
  const files = [];
  for (const [path, role, bytes] of assets) {
    await writeFile(resolve(parent, path), bytes);
    files.push({ path, role, sha256: digest(bytes) });
  }
  const bundle = { format: 'squarehole.kit-bundle/1', status: 'bound-offline', files: assets.map(([path, role, bytes]) => ({ path, role, ...record(bytes) })) };
  const listHash = digest(assets.at(-1)[2]);
  const bundleRecords = await bundleAssets(parent, bundle, listHash);
  assert.deepEqual(bundleRecords.map(file => file.mime), ['image/png', 'model/gltf-binary', 'model/gltf-binary', 'image/webp', 'application/json']);
  await assert.rejects(bundleAssets(parent, bundle, zero), /final spec/);
  await assert.rejects(bundleAssets(parent, { ...bundle, files: bundle.files.filter(file => file.path !== 'rent.bin') }, listHash), /missing required model/);
  await assert.rejects(bundleAssets(parent, { ...bundle, files: bundle.files.filter(file => file.role !== 'public reveal list') }, listHash), /list missing/);
  await assert.rejects(bundleAssets(parent, { ...bundle, hiddenPlan: {} }, listHash), /invalid public bundle/);
  await assert.rejects(bundleAssets(parent, { ...bundle, files: [...bundle.files, { path: 'secret.png', role: 'hidden item' }] }, listHash), /unsupported bundle asset/);
  await writeFile(resolve(parent, 'manifest.json'), JSON.stringify({ files }));
  const output = resolve(parent, 'cars');
  const records = await exportKit(resolve(parent, 'manifest.json'), output);
  assert.equal(records.length, assets.length);
  const blocks = new Map();
  for (const record of records) {
    assert.equal(record.mime, contentType(assets.find(([, , bytes]) => digest(bytes) === record.sha256)[2]));
    for (const [cid, bytes] of carBlocks(await readFile(resolve(output, `${record.cid}.car`)))) blocks.set(cid, bytes);
  }
  for (const [, , bytes] of assets) assert.deepEqual(blocks.get(rawCidV1(digest(bytes))), bytes);
  assert.deepEqual(JSON.parse(await readFile(resolve(output, 'pins.json'))), records);
  assert.equal(await checkGateway(records, 'https://public.example', { fetch: gatewayFetch(blocks) }), assets.length);
});

test('T04 checks MIME, public-list dependencies and HEAD metadata as well as GET hash/size', async () => {
  const bytes = png;
  const file = { ...record(bytes), role: 'image', mime: 'image/png' };
  const inventory = { format: 'squarehole.public-example-pins/1', files: [file] };
  const good = gatewayFetch(new Map([[file.cid, bytes]]));
  for (const patch of [{ mime: 'text/html' }, { mime: 'model/gltf-binary' }, { role: 'model' }, { role: 'private' }]) {
    await assert.rejects(checkGateway({ ...inventory, files: [{ ...file, ...patch }] }, 'https://public.example', { fetch: good }));
  }
  for (const method of ['GET', 'HEAD']) for (const header of ['Content-Type', 'Content-Length']) {
    await assert.rejects(checkGateway(inventory, 'https://public.example', { fetch: async (url, options) => {
      const response = await good(url, options);
      if (options.method === method) response.headers.set(header, header === 'Content-Type' ? 'text/html' : '99');
      return response;
    } }));
  }
  for (const status of [206, 302]) await assert.rejects(checkGateway(inventory, 'https://public.example', { fetch: async (url, options) => {
    if (options.method === 'GET') return good(url, options);
    return new Response(null, { status, headers: { 'Content-Type': file.mime, 'Content-Length': String(file.bytes), Location: 'https://elsewhere.invalid' } });
  } }));
  await assert.rejects(checkGateway(inventory, 'https://public.example', { fetch: async (url, options) => {
    const response = await good(url, options);
    return options.method === 'HEAD' ? new Response(bytes, { headers: response.headers }) : response;
  } }), /HEAD returned a body/);
  const list = listFor(bytes);
  const listRecord = { ...record(list), role: 'public reveal list', mime: 'application/json' };
  await assert.rejects(checkGateway({ ...inventory, files: [listRecord] }, 'https://public.example', {
    fetch: gatewayFetch(new Map([[listRecord.cid, list]])),
  }), /missing.*image/);
  const malformed = Buffer.from('{}');
  await assert.rejects(checkGateway({ ...inventory, files: [{ ...record(malformed), role: 'public reveal list', mime: 'application/json' }] },
    'https://public.example', { fetch: async () => new Response(malformed, { headers: { 'Content-Type': 'application/json', 'Content-Length': String(malformed.length) } }) }));
});

test('T04 verifier cancels over-limit and stalled GET streams even with plausible headers', async () => {
  const file = { ...record(png), role: 'image', mime: 'image/png' };
  const headers = { 'Content-Type': file.mime, 'Content-Length': String(file.bytes) };
  let cancelled = false;
  await assert.rejects(checkGateway([file], 'https://public.example', { fetch: async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(Buffer.alloc(600_000)); }, cancel() { cancelled = true; },
  }), { headers }) }), /oversize/);
  assert.equal(cancelled, true);
  cancelled = false;
  // AbortSignal.timeout is unref'ed; keep this offline test alive until its short deadline fires.
  const alive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(checkGateway([file], 'https://public.example', { timeoutMs: 20,
      fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers }),
    }));
    assert.equal(cancelled, true);
  } finally { clearInterval(alive); }
});
