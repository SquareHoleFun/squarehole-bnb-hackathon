import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { rawCidV1, rawBlockCar, runPinRaw } from './pin-raw-lib.mjs';
import { runCli } from './pin-raw.mjs';

const digest = (bytes) => `0x${createHash('sha256').update(bytes).digest('hex')}`;
const hello = Buffer.from('hello world');
const helloCid = 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e';
const maxBlock = 1_048_576;
const defaults = { imageSize: 512, imageFormat: 'webp', imageQuality: 90, avatarSize: 256, avatarFormat: 'webp', avatarQuality: 90 };
const manifest = (files = [{ path: 'cover.bin', role: 'cover' }], encoding) => ({ files, ...(encoding ? { encoding } : {}) });

// An independent, read-only decoder of the CARv1 framing and DAG-CBOR types used by its header.
function decodeCar(car) {
  let offset = 0;
  const varint = () => {
    let result = 0;
    let multiplier = 1;
    for (;;) {
      assert.ok(offset < car.length);
      const byte = car[offset++];
      result += (byte & 127) * multiplier;
      if (byte < 128) return result;
      multiplier *= 128;
    }
  };
  const cbor = () => {
    const first = car[offset++];
    const major = first >> 5;
    const additional = first & 31;
    assert.ok(additional <= 24);
    const length = additional === 24 ? car[offset++] : additional;
    if (major === 0) return length;
    if (major === 2 || major === 3) {
      const bytes = car.subarray(offset, offset + length);
      offset += length;
      return major === 2 ? bytes : bytes.toString('utf8');
    }
    if (major === 4) return Array.from({ length }, cbor);
    if (major === 5) return Object.fromEntries(Array.from({ length }, () => [cbor(), cbor()]));
    assert.equal(major, 6);
    return { tag: length, value: cbor() };
  };
  const headerLength = varint();
  const headerStart = offset;
  const header = cbor();
  assert.equal(offset, headerStart + headerLength);
  const records = [];
  while (offset < car.length) {
    const length = varint();
    assert.ok(length >= 36 && offset + length <= car.length);
    records.push({ cid: car.subarray(offset, offset + 36), bytes: car.subarray(offset + 36, offset + length) });
    offset += length;
  }
  return { header, records };
}

function harness(contents = { 'cover.bin': hello }) {
  const reads = [];
  const calls = [];
  const results = [];
  const key = randomBytes(32).toString('base64url');
  const files = new Map(Object.entries(contents).map(([path, bytes]) => [resolve(path), Buffer.from(bytes)]));
  const deps = {
    env: { TEST_PIN_KEY: key },
    readBytes: async (path, limit) => {
      reads.push(path);
      const bytes = files.get(resolve(path));
      if (!bytes) throw new Error(`untrusted filesystem detail ${key}`);
      if (bytes.length > limit) throw new Error(`oversize ${key}`);
      return bytes;
    },
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (options.method === 'GET') return new Response(hello);
      const car = Buffer.from(await options.body.get('file').arrayBuffer());
      const { records } = decodeCar(car);
      return Response.json({ IpfsHash: rawCidV1(digest(records[0].bytes)) });
    },
    onResult: (result) => results.push(result),
  };
  return { deps, files, key, reads, calls, results };
}

test('raw CID agrees with the artwork library shared Solidity vectors', async () => {
  const vectors = JSON.parse(await readFile(new URL('../../packages/contracts/test/vectors/misfits-commitment.json', import.meta.url), 'utf8'));
  assert.equal(digest(hello), vectors.helloWorld.sha256);
  assert.equal(rawCidV1(digest(hello)), helloCid);
  for (const entry of vectors.entries) {
    assert.equal(rawCidV1(entry.imageSha256), entry.imageCid);
    assert.equal(rawCidV1(entry.modelSha256), entry.modelCid);
  }
  for (const invalid of ['0x1234', 'z'.repeat(64), null, Buffer.alloc(32)]) {
    assert.throws(() => rawCidV1(invalid), /32-byte/);
  }
});

test('CARv1 has a tagged raw CID root and exactly one whole-file block across chunk boundaries', () => {
  for (const size of [0, 1, 91, 92, 127, 128, 262_144, 262_145, maxBlock]) {
    const bytes = Buffer.alloc(size, 0xab);
    const before = Buffer.from(bytes);
    const cidBytes = Buffer.concat([Buffer.from([1, 0x55, 0x12, 0x20]), Buffer.from(digest(bytes).slice(2), 'hex')]);
    const { header, records } = decodeCar(rawBlockCar(bytes));
    assert.equal(header.version, 1);
    assert.deepEqual(header.roots, [{ tag: 42, value: Buffer.concat([Buffer.from([0]), cidBytes]) }]);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0], { cid: cidBytes, bytes });
    assert.deepEqual(bytes, before);
  }
  assert.throws(() => rawBlockCar(Buffer.alloc(maxBlock + 1)), /1 MiB/);
});

test('CAR hello-world bytes match the fixed CARv1 wire vector', () => {
  const cidHex = `01551220${digest(hello).slice(2)}`;
  assert.equal(rawBlockCar(hello).toString('hex'), `3aa265726f6f747381d82a582500${cidHex}6776657273696f6e012f${cidHex}68656c6c6f20776f726c64`);
});

test('dry run hashes every id image and avatar offline, without reading a supplied key', async () => {
  const h = harness({ '1.webp': hello, '1-avatar.webp': Buffer.from('avatar') });
  const input = manifest([{ id: '1', role: 'image', path: '1.webp' }, { id: '1', role: 'avatar', path: '1-avatar.webp' }]);
  await runPinRaw({ manifest: input, mode: 'dry-run', keyFile: 'must-not-read' }, h.deps);
  assert.equal(h.calls.length, 0);
  assert.equal(h.reads.length, 2);
  assert.deepEqual(h.results.map(({ id, role, status }) => ({ id, role, status })), [
    { id: '1', role: 'image', status: 'computed' }, { id: '1', role: 'avatar', status: 'computed' },
  ]);
  assert.equal(h.results[0].cid, helloCid);
  assert.equal(h.results[1].sha256, digest(Buffer.from('avatar')));
  assert.deepEqual(h.results[0].encoding, defaults);
  assert.ok(!JSON.stringify(h.results).includes('1.webp'));
  assert.ok(!JSON.stringify(h.results).includes(h.key));
});

test('all MF-9 and MF-10 encoding fields are parameters, with no byte conversion', async () => {
  const h = harness();
  const encoding = { imageSize: 1024, imageFormat: 'png', imageQuality: 95, avatarSize: 128, avatarFormat: 'jpeg', avatarQuality: 80 };
  await runPinRaw({ manifest: manifest(undefined, encoding), mode: 'dry-run' }, h.deps);
  assert.deepEqual(h.results[0].encoding, encoding);
  assert.equal(h.results[0].cid, helloCid);
});

test('reject malformed lists, duplicate id roles, incomplete id pairs and invalid encoding before HTTP', async () => {
  const bad = [
    {}, manifest([]), { ...manifest(), salt: 'not-an-art-field' },
    manifest([{ path: 'cover.bin', id: '1', role: 'image' }]),
    manifest([{ path: 'cover.bin', role: 'seed' }]),
    manifest([{ path: 'cover.bin', id: 1, role: 'image' }]),
    manifest([{ path: 'cover.bin', sha256: 'wrong' }]),
    manifest([{ path: 'cover.bin', key: 'not-an-art-field' }]),
    manifest([{ path: 'cover.bin', id: '1', role: 'image' }, { path: 'cover.bin', id: '1', role: 'image' }]),
    manifest(undefined, { imageSize: 0 }), manifest(undefined, { imageQuality: 101 }),
    manifest(undefined, { avatarSize: 1.5 }), manifest(undefined, { avatarQuality: '90' }),
    manifest(undefined, { imageFormat: 'gif' }), manifest(undefined, { unexpected: true }),
  ];
  for (const input of bad) {
    const h = harness();
    await assert.rejects(runPinRaw({ manifest: input, mode: 'pin', keyEnv: 'TEST_PIN_KEY' }, h.deps));
    assert.equal(h.calls.length, 0);
  }
});

test('preflight the entire list before pinning: missing, oversized or wrong committed bytes stop all uploads', async () => {
  for (const second of [undefined, Buffer.alloc(maxBlock + 1), Buffer.from('wrong committed art')]) {
    const h = harness({ 'cover.bin': hello, ...(second ? { 'later.bin': second } : {}) });
    const input = manifest([{ path: 'cover.bin' }, { path: 'later.bin', sha256: digest(hello) }]);
    await assert.rejects(runPinRaw({ manifest: input, mode: 'pin', keyEnv: 'TEST_PIN_KEY' }, h.deps));
    assert.equal(h.calls.length, 0);
  }
});

test('Pinata gets CAR import, one raw root, no local name, and the JWT only in Authorization', async () => {
  const bytes = Buffer.alloc(300_000, 0xcd);
  const h = harness({ 'cover.bin': bytes });
  await runPinRaw({ manifest: manifest(), mode: 'pin', keyEnv: 'TEST_PIN_KEY' }, h.deps);
  assert.equal(h.calls.length, 1);
  const { url, options } = h.calls[0];
  assert.equal(url, 'https://api.pinata.cloud/pinning/pinFileToIPFS?car=true');
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  assert.ok(options.signal instanceof AbortSignal);
  assert.deepEqual(options.headers, { Authorization: `Bearer ${h.key}` });
  const file = options.body.get('file');
  assert.equal(file.name, 'block.car');
  assert.equal(file.type, 'application/vnd.ipld.car');
  assert.deepEqual(JSON.parse(options.body.get('pinataOptions')), { cidVersion: 1, wrapWithDirectory: false });
  assert.deepEqual([...options.body.keys()], ['file', 'pinataOptions']);
  assert.deepEqual(decodeCar(Buffer.from(await file.arrayBuffer())).records[0].bytes, bytes);
  assert.equal(h.results[0].cid, rawCidV1(digest(bytes)));
  assert.equal(h.results[0].status, 'pinned');
});

test('key file accepts a trailing newline and is never sent to the gateway or output', async () => {
  const h = harness();
  h.files.set(resolve('credential'), Buffer.from(`${h.key}\n`));
  await runPinRaw({ manifest: manifest(), mode: 'pin', keyFile: 'credential', gateway: 'https://gateway.example' }, h.deps);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].options.headers.Authorization, `Bearer ${h.key}`);
  assert.equal(h.calls[1].url, `https://gateway.example/ipfs/${helloCid}`);
  assert.equal(h.calls[1].options.method, 'GET');
  assert.equal(h.calls[1].options.redirect, 'error');
  assert.equal(h.calls[1].options.headers?.Authorization, undefined);
  assert.equal(h.results[0].status, 'verified');
  assert.ok(!JSON.stringify(h.results).includes(h.key));
});

test('a different, missing or malformed returned CID stops the batch before gateway or next upload', async () => {
  for (const value of ['bafy-not-the-raw-root', undefined, null, 42]) {
    const h = harness();
    h.deps.fetch = async () => { h.calls.push('upload'); return Response.json({ IpfsHash: value }); };
    await assert.rejects(runPinRaw({ manifest: manifest([{ path: 'cover.bin' }, { path: 'cover.bin' }]), mode: 'pin', keyEnv: 'TEST_PIN_KEY', gateway: 'https://gateway.example' }, h.deps), /CID mismatch/);
    assert.equal(h.calls.length, 1);
    assert.equal(h.results.length, 0);
  }
});

test('re-read before upload detects file changes after preflight', async () => {
  const h = harness();
  const read = h.deps.readBytes;
  h.deps.readBytes = async (...args) => {
    const bytes = await read(...args);
    if (h.reads.length === 1) h.files.set(resolve('cover.bin'), Buffer.from('changed'));
    return bytes;
  };
  await assert.rejects(runPinRaw({ manifest: manifest(), mode: 'pin', keyEnv: 'TEST_PIN_KEY' }, h.deps), /changed/);
  assert.equal(h.calls.length, 0);
});

test('gateway-only check needs no key and rejects wrong bytes, oversize, redirects and HTTP errors', async () => {
  for (const response of [new Response('wrong'), new Response(Buffer.alloc(maxBlock + 1)), new Response('', { status: 302 }), new Response('', { status: 404 })]) {
    const h = harness();
    h.deps.fetch = async (url, options) => {
      assert.equal(options.method, 'GET');
      assert.equal(options.headers?.Authorization, undefined);
      return response;
    };
    await assert.rejects(runPinRaw({ manifest: manifest(), mode: 'check', gateway: 'https://gateway.example' }, h.deps), /gateway/);
    assert.equal(h.results.length, 0);
  }
  const h = harness();
  await runPinRaw({ manifest: manifest(), mode: 'check', gateway: 'https://gateway.example' }, h.deps);
  assert.equal(h.results[0].status, 'verified');
});

test('unsafe gateway URLs, ambiguous credentials and invalid runtime options never make requests', async () => {
  const variants = [
    { gateway: 'http://gateway.example' }, { gateway: 'https://user:pass@gateway.example' },
    { gateway: 'https://gateway.example?token=bad' }, { gateway: 'https://gateway.example/path' },
    { keyFile: 'credential' }, { keyEnv: undefined }, { keyEnv: 'bad-name' },
    { mode: 'check', gateway: undefined }, { mode: 'unknown' }, { timeoutMs: 0 },
  ];
  for (const variant of variants) {
    const h = harness();
    await assert.rejects(runPinRaw({ manifest: manifest(), mode: 'pin', keyEnv: 'TEST_PIN_KEY', ...variant }, h.deps));
    assert.equal(h.calls.length, 0);
  }
});

test('reject empty, newline-injected or oversized credentials before HTTP', async () => {
  for (const key of ['', 'header\ninjection', 'a'.repeat(16_385)]) {
    const h = harness();
    h.deps.env.TEST_PIN_KEY = key;
    await assert.rejects(runPinRaw({ manifest: manifest(), mode: 'pin', keyEnv: 'TEST_PIN_KEY' }, h.deps), /credential/);
    assert.equal(h.calls.length, 0);
  }
});

test('CLI never prints reflected keys, file paths, option values, remote bodies or nested transport errors', async () => {
  for (const failure of ['transport', 'http', 'json', 'cid', 'gateway', 'filesystem', 'manifest', 'argv']) {
    const h = harness();
    let stdout = '';
    let stderr = '';
    h.files.set(resolve('list.json'), Buffer.from(JSON.stringify(manifest())));
    h.deps.fetch = async (url, options) => {
      if (failure === 'transport') throw new Error(`transport ${h.key}`, { cause: new Error(h.key) });
      if (failure === 'http') return new Response(h.key, { status: 401, statusText: h.key });
      if (failure === 'json') return new Response(h.key);
      if (failure === 'cid') return Response.json({ IpfsHash: h.key });
      if (options.method === 'GET') throw new Error(h.key);
      return Response.json({ IpfsHash: helloCid });
    };
    if (failure === 'filesystem') h.deps.readBytes = async () => { throw new Error(h.key); };
    if (failure === 'manifest') h.files.set(resolve('list.json'), Buffer.from(h.key));
    const args = ['--manifest', 'list.json', '--pin', '--key-env', 'TEST_PIN_KEY', '--gateway', 'https://gateway.example'];
    if (failure === 'argv') args.push('--key', h.key);
    const code = await runCli(args, { ...h.deps, stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; } });
    assert.equal(code, 1, failure);
    assert.equal(stdout, '');
    assert.ok(stderr.startsWith('pin-raw: '));
    assert.ok(!stderr.includes(h.key));
    assert.ok(!stderr.includes('list.json'));
    assert.ok(!stderr.includes('at run'));
  }
});

test('CLI requires exactly one explicit mode, rejects duplicate/unknown arguments, and has offline help', async () => {
  for (const args of [[], ['--manifest', 'x'], ['--manifest', 'x', '--pin', '--dry-run'], ['--manifest', 'x', '--dry-run', '--manifest', 'y'], ['--dry-run', '--manifest'], ['--help', '--pin']]) {
    const h = harness();
    assert.equal(await runCli(args, { ...h.deps, stdout: () => {}, stderr: () => {} }), 1);
    assert.equal(h.calls.length, 0);
  }
  let help = '';
  assert.equal(await runCli(['--help'], { stdout: (text) => { help += text; }, stderr: () => {} }), 0);
  assert.match(help, /--key-env/);
  assert.match(help, /--key-file/);
});

test('real CLI reads paths relative to the manifest, reports JSON lines, and leaves fixtures only in cache', async () => {
  await mkdir('.cache/pin-raw-tests', { recursive: true });
  const directory = await mkdtemp('.cache/pin-raw-tests/run-');
  await writeFile(join(directory, 'art.bin'), hello);
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest([{ path: 'art.bin', role: 'cover', sha256: digest(hello) }])));
  const child = spawnSync(process.execPath, ['scripts/ipfs/pin-raw.mjs', '--manifest', join(directory, 'manifest.json'), '--dry-run'], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  const result = JSON.parse(child.stdout.trim());
  assert.equal(result.cid, helloCid);
  assert.equal(result.status, 'computed');
  assert.equal(result.bytes, hello.length);
});

// The reveal worker needs provider-level checkpoints and safe retry after a lost response.
test('ensureRawPin imports the same single raw-block CAR into Kubo and Pinata', async () => {
  const { ensureRawPin } = await import('./pin-raw-lib.mjs');
  assert.equal(typeof ensureRawPin, 'function', 'provider-level raw pin operation is required');
  for (const provider of ['kubo', 'pinata']) {
    const calls = [];
    const bytes = Buffer.alloc(300_000, 0x61);
    const cid = rawCidV1(digest(bytes));
    await ensureRawPin({ provider, api: 'https://node.example', token: 'fake-token', bytes, sha256: digest(bytes), fetch: async (url, options) => {
      calls.push({ url, options });
      assert.equal(options.redirect, 'error');
      if (options.method === 'GET') return Response.json({ rows: [] });
      const car = Buffer.from(await options.body.get('file').arrayBuffer());
      assert.deepEqual(decodeCar(car).records[0].bytes, bytes);
      assert.equal(options.body.get('file').name, 'block.car');
      return provider === 'kubo'
        ? new Response(JSON.stringify({ Root: { Cid: { '/': cid }, PinErrorMsg: '' } }) + '\n')
        : Response.json({ IpfsHash: cid });
    } });
    assert.equal(calls.at(-1).options.method, 'POST');
    if (provider === 'kubo') assert.equal(calls[0].url, 'https://node.example/api/v0/dag/import?pin-roots=true&silent=false');
  }
});

test('Pinata retry finds an exact existing pin without another upload', async () => {
  const { ensureRawPin } = await import('./pin-raw-lib.mjs');
  assert.equal(typeof ensureRawPin, 'function');
  let calls = 0;
  await ensureRawPin({ provider: 'pinata', token: 'fake-token', bytes: hello, sha256: digest(hello), fetch: async (url, options) => {
    calls++;
    assert.equal(options.method, 'GET');
    assert.match(url, /status=pinned/);
    assert.match(url, new RegExp(helloCid));
    return Response.json({ rows: [{ ipfs_pin_hash: helloCid, date_unpinned: null }] });
  } });
  assert.equal(calls, 1);
});

test('provider failures, wrong roots and Kubo pin errors never count as success', async () => {
  const { ensureRawPin } = await import('./pin-raw-lib.mjs');
  assert.equal(typeof ensureRawPin, 'function');
  for (const value of [{}, { Root: { Cid: { '/': 'wrong' } } }, { Root: { Cid: { '/': helloCid }, PinErrorMsg: 'private detail' } }]) {
    await assert.rejects(ensureRawPin({ provider: 'kubo', api: 'https://node.example', bytes: hello, sha256: digest(hello), fetch: async () => Response.json(value) }), /Kubo/);
  }
  let calls = 0;
  await assert.rejects(ensureRawPin({ provider: 'pinata', token: 'fake-token', bytes: hello, sha256: digest(Buffer.from('other')), fetch: async () => { calls++; } }), /sha256/);
  assert.equal(calls, 0);
});

test('Kubo accepts an omitted empty error field and refuses an explicit error', async () => {
  const { ensureRawPin } = await import('./pin-raw-lib.mjs');
  await ensureRawPin({ provider: 'kubo', api: 'http://127.0.0.1:5001', bytes: hello, sha256: digest(hello), fetch: async () => Response.json({ Root: { Cid: { '/': helloCid } } }) });
});

test('lookup and Kubo transport failures are bounded, sanitized and never followed by an upload', async () => {
  const { ensureRawPin } = await import('./pin-raw-lib.mjs');
  for (const provider of ['kubo', 'pinata']) {
    for (const kind of ['http', 'transport', 'malformed', 'oversize', 'redirect']) {
      let calls = 0;
      await assert.rejects(ensureRawPin({ provider, api: 'https://node.example', token: 'fake-secret', bytes: hello, sha256: digest(hello), fetch: async () => {
        calls++;
        if (kind === 'transport') throw new Error('fake-secret');
        if (kind === 'http') return new Response('fake-secret', { status: 403 });
        if (kind === 'redirect') return new Response('fake-secret', { status: 302 });
        if (kind === 'oversize') return new Response('a'.repeat(65_537));
        return new Response('fake-secret');
      } }), (error) => !error.message.includes('fake-secret'));
      assert.equal(calls, 1);
    }
  }
});
