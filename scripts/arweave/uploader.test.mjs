import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { boxCollectionAbi } from '../../packages/chain/src/abi/boxCollection.ts';
import { rawCidV1 } from '../ipfs/pin-raw-lib.mjs';
import { runArchive } from './arweave-lib.mjs';
import { runCli } from './upload.mjs';
import { fileStateStore } from './common.mjs';

const { encodeEventTopics, encodeAbiParameters, decodeFunctionData, encodeFunctionResult } = createRequire(new URL('../../packages/indexer/package.json', import.meta.url))('viem');
const hash = (b) => `0x${createHash('sha256').update(b).digest('hex')}`;
const id64 = (s) => createHash('sha256').update(s).digest('base64url');
const arBlock = createHash('sha384').update('fake Arweave block').digest('base64url');
const address = `0x${'12'.repeat(20)}`;
const block = hash('fake block');
const tx = hash('fake reveal transaction');
const roles = ['image', 'avatar', 'model'];
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 4096 });

function harness() {
  const art = { image: Buffer.from('fake image'), avatar: Buffer.from('fake avatar'), model: Buffer.alloc(300_000, 97) };
  const metadata = Buffer.from(`{ "name": "Fake #1", "image":"ipfs://${rawCidV1(hash(art.image))}", "animation_url":"ipfs://${rawCidV1(hash(art.model))}", "attributes": [] }\n`);
  const event = { transactionHash: tx, logIndex: '9007199254740993', blockNumber: '10', blockHash: block };
  const log = { address, transactionHash: tx, logIndex: '0x20000000000001', blockNumber: '0xa', blockHash: block, removed: false,
    topics: encodeEventTopics({ abi: boxCollectionAbi, eventName: 'Revealed', args: { id: 1n } }),
    data: encodeAbiParameters([{ type: 'uint128' }, ...roles.map(() => ({ type: 'bytes32' }))], [1n, ...roles.map((r) => hash(art[r]))]) };
  const h = { art, metadata, event, log, calls: [], output: [], state: null, keyReads: 0, price: '9007199254740993', accepted: new Map(), depth: 20, corruptGateway: false, shallow: false, failPost: false, chain: '0x2', revealed: true, head: '0xa', canonical: block, badMetadata: false };
  h.env = { SH_ARWEAVE_CHAIN_ID: '2', SH_ARWEAVE_COLLECTION: address, SH_ARWEAVE_RPC_URL: 'https://rpc.example/fake-token',
    SH_ARWEAVE_IPFS_GATEWAY: 'https://ipfs.example', SH_ARWEAVE_UPLOAD_ORIGIN: 'https://upload.example', SH_ARWEAVE_PAYMENT_ORIGIN: 'https://payment.example',
    SH_ARWEAVE_GATEWAY_1: 'https://ar-one.example', SH_ARWEAVE_GATEWAY_2: 'https://ar-two.example', SH_ARWEAVE_MIN_CONFIRMATIONS: '20',
    SH_ARWEAVE_MAX_WINC: '36028797018963972', SH_ARWEAVE_KEY_FILE: 'fake-key-do-not-read.json' };
  h.publicFile = { format: 'squarehole.box0-commitment/1', n: 2, depth: 1, root: hash('fake root') };
  h.feed = { format: 'squarehole.reveal-pin-feed/1', chainId: '2', collection: address, events: [{ transactionHash: tx, logIndex: event.logIndex }] };
  h.pinState = { format: 'squarehole.reveal-pin-state/1', scope: { chainId: '2', collection: address, root: h.publicFile.root, kubo: hash('kubo'), pinata: hash('pinata'), gateway: hash('gateway') },
    items: { '1': { event, files: Object.fromEntries(roles.map((r) => [r, { sha256: hash(art[r]), cid: rawCidV1(hash(art[r])), bytes: String(art[r].length), pins: { kubo: 'pinned', pinata: 'pinned' }, gateway: 'verified' }])) } } };
  h.store = { load: async () => structuredClone(h.state), save: async (s) => { h.state = structuredClone(s); } };
  h.fetch = async (url, options = {}) => {
    h.calls.push({ url, options });
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers?.Authorization, undefined);
    if (url.startsWith('https://rpc.example/')) {
      const { method, params, id } = JSON.parse(options.body);
      let result;
      if (method === 'eth_chainId') result = h.chain;
      else if (method === 'eth_getBlockByNumber') result = { number: params[0] === 'finalized' ? h.head : '0xa', hash: h.canonical };
      else if (method === 'eth_getTransactionReceipt') result = { status: '0x1', transactionHash: params[0], blockNumber: '0xa', blockHash: block, logs: [h.extraLogs?.get(params[0]) ?? h.log] };
      else if (method === 'eth_call') {
        assert.deepEqual(params[1], { blockHash: h.canonical, requireCanonical: true });
        const { functionName } = decodeFunctionData({ abi: boxCollectionAbi, data: params[0].data });
        const values = { revealRoot: h.publicFile.root, collectionSize: BigInt(h.publicFile.n), firstId: 1n, isRevealed: h.revealed,
          tokenURI: `data:application/json;base64,${(h.badMetadata ? Buffer.from('{}') : h.metadata).toString('base64')}` };
        assert.ok(Object.hasOwn(values, functionName));
        result = encodeFunctionResult({ abi: boxCollectionAbi, functionName, result: values[functionName] });
      } else assert.fail('unexpected RPC method');
      return Response.json({ jsonrpc: '2.0', id, result });
    }
    if (url.startsWith('https://ipfs.example/ipfs/')) {
      const role = roles.find((r) => url.endsWith(rawCidV1(h.pinState.items['1'].files[r].sha256)));
      return new Response(h.missing === role ? null : h.art[role], { status: h.missing === role ? 404 : 200 });
    }
    if (url.startsWith('https://payment.example/v1/price/bytes/')) return Response.json({ winc: h.price });
    if (url === 'https://upload.example/v1/tx/arweave') {
      const b = Buffer.from(options.body);
      const id = createHash('sha256').update(b.subarray(2, 514)).digest('base64url');
      assert.ok(Object.values(h.state.items['1'].files).some((f) => f.intent?.id === id), 'intent persisted before spending');
      h.accepted.set(id, b.subarray(1044 + Number(b.readBigUInt64LE(1036))));
      if (h.failPost) throw new Error('FAKE_SECRET_PROVIDER_RESPONSE');
      return Response.json({ id: h.wrongId ? id64('wrong') : id });
    }
    if (url.startsWith('https://ar-one.example/') || url.startsWith('https://ar-two.example/')) {
      const path = new URL(url).pathname;
      if (path === '/graphql') {
        const { variables } = JSON.parse(options.body);
        const found = h.accepted.has(variables.id) && !h.unindexed;
        return Response.json({ data: { transactions: { edges: found ? [{ node: { id: variables.id, bundledIn: { id: h.otherBundle && url.includes('ar-two') ? id64('other') : id64('bundle') } } }] : [] } } });
      }
      if (path === `/tx/${id64('bundle')}/status` || path === `/tx/${id64('other')}/status`) return Response.json({ block_height: 100, block_indep_hash: h.badBlockHash ? id64('short hash') : arBlock, number_of_confirmations: h.shallow ? 19 : h.depth });
      if (path === '/height') return new Response(String(h.shallow ? 118 : 99 + h.depth));
      if (path === '/block/height/100') return Response.json({ height: 100, indep_hash: h.badBlockHash ? id64('short hash') : arBlock, txs: h.noBundleInBlock ? [] : [id64('bundle')] });
      const bytes = h.accepted.get(path.slice(1));
      return new Response(bytes ? h.corruptGateway && url.includes('ar-two') ? 'bad' : bytes : null, { status: bytes ? 200 : 404 });
    }
    assert.fail('unexpected request');
  };
  h.run = (mode = 'upload', extra = {}) => runArchive({ mode, env: h.env, publicFile: h.publicFile, feed: h.feed, pinState: h.pinState, store: h.store,
    fetch: h.fetch, loadKey: async () => { h.keyReads++; return privateKey; }, now: () => new Date('2026-10-13T00:00:00Z'), onResult: (r) => h.output.push(r), ...extra });
  h.posts = () => h.calls.filter((c) => c.url === 'https://upload.example/v1/tx/arweave');
  h.prices = () => h.calls.filter((c) => c.url.startsWith('https://payment.example/'));
  return h;
}

test('four exact published payloads, preflight prices, durable receipts, two gateways and chain depth; replay skips prices/key/uploads', async () => {
  const h = harness();
  assert.equal(await h.run(), true);
  assert.equal(h.posts().length, 4);
  assert.equal(h.prices().length, 4);
  assert.ok(h.calls.indexOf(h.prices().at(-1)) < h.calls.indexOf(h.posts()[0]));
  assert.equal(h.output[0].estimateWinc, '36028797018963972');
  for (const [role, f] of Object.entries(h.state.items['1'].files)) {
    assert.deepEqual(h.accepted.get(f.receipt.id), role === 'metadata' ? h.metadata : h.art[role]);
    assert.equal(f.receipt.sha256, f.sha256);
    assert.equal(f.receipt.size, f.size);
    assert.equal(f.receipt.time, '2026-10-13T00:00:00.000Z');
    assert.equal(f.verification.status, 'final');
    assert.equal(f.verification.confirmations, '20');
  }
  const reads = h.keyReads;
  assert.equal(await h.run(), true);
  assert.equal(h.keyReads, reads);
  assert.equal(h.posts().length, 4);
  assert.equal(h.prices().length, 4);
});

test('dry-run quotes only readable, matching bytes and writes/signs/uploads nothing', async () => {
  const h = harness(); h.missing = 'avatar';
  assert.equal(await h.run('dry-run'), false);
  assert.equal(h.prices().length, 3);
  assert.equal(h.posts().length, 0);
  assert.equal(h.state, null);
  assert.equal(h.keyReads, 0);
  assert.equal(h.output[0].files.avatar.status, 'unreadable');
  assert.equal(h.output[0].estimateWinc, null);
});

test('ceiling is exact bigint, cumulative across retries and checked before any signing or upload', async () => {
  const h = harness(); h.env.SH_ARWEAVE_MAX_WINC = '36028797018963971';
  await assert.rejects(h.run(), /ceiling/);
  assert.equal(h.keyReads, 0); assert.equal(h.posts().length, 0);
  h.env.SH_ARWEAVE_MAX_WINC = '36028797018963972';
  await h.run();
  h.env.SH_ARWEAVE_MAX_WINC = '1';
  await assert.rejects(h.run(), /ceiling/);
  assert.equal(h.posts().length, 4);
});

test('mainnet requires an explicit flag before any RPC or provider request', async () => {
  const h = harness(); h.env.SH_ARWEAVE_CHAIN_ID = '1';
  await assert.rejects(h.run(), /allow-mainnet/);
  assert.equal(h.calls.length, 0);
  h.chain = '0x1'; h.feed.chainId = '1'; h.pinState.scope.chainId = '1';
  assert.equal(await h.run('dry-run', { allowMainnet: true }), true);
});

test('unfinalized, unrevealed, removed, foreign, reorged and unpinned inputs expose no files or quotes', async () => {
  for (const change of [
    (h) => { h.head = '0x9'; }, (h) => { h.revealed = false; }, (h) => { h.log.removed = true; },
    (h) => { h.log.address = `0x${'34'.repeat(20)}`; }, (h) => { h.canonical = hash('other'); },
    (h) => { h.pinState.items['1'].files.image.pins = { kubo: 'pinned' }; },
    (h) => { h.chain = '0x3'; }, (h) => { h.pinState.scope.root = hash('wrong'); },
    (h) => { h.log.topics[0] = hash('not revealed'); }, (h) => { h.badMetadata = true; },
    (h) => { h.pinState.items['1'].files.avatar.sha256 = hash('wrong'); },
  ]) {
    const h = harness(); change(h);
    await assert.rejects(h.run());
    assert.equal(h.prices().length, 0); assert.equal(h.posts().length, 0);
    assert.ok(h.calls.every((c) => c.url.startsWith('https://rpc.example/')));
  }
});

test('missing/corrupt payload refuses the entire upload batch before spend', async () => {
  for (const change of [(h) => { h.missing = 'model'; }, (h) => { h.art.avatar = Buffer.from('corrupt'); }]) {
    const h = harness(); change(h);
    await assert.rejects(h.run());
    assert.equal(h.posts().length, 0); assert.equal(h.keyReads, 0);
  }
});

test('price endpoint rejects numeric, fractional, negative and oversized amounts', async () => {
  for (const price of [123, '1.5', '-1', '01', '1'.repeat(100)]) {
    const h = harness(); h.price = price;
    await assert.rejects(h.run(), /price/);
    assert.equal(h.posts().length, 0);
  }
});

test('check requires both gateways and canonical chain depth; never signs, prices or uploads', async () => {
  const h = harness(); h.shallow = true;
  assert.equal(await h.run(), false);
  for (const f of Object.values(h.state.items['1'].files)) assert.equal(f.verification.status, 'pending');
  h.shallow = false; h.corruptGateway = true;
  assert.equal(await h.run('check'), false);
  h.corruptGateway = false;
  assert.equal(await h.run('check'), true);
  h.noBundleInBlock = true;
  assert.equal(await h.run('check'), false);
  assert.equal(h.posts().length, 4); assert.equal(h.prices().length, 4);
});

test('disagreeing bundle membership cannot become final', async () => {
  const h = harness(); h.otherBundle = true;
  assert.equal(await h.run(), false);
  assert.ok(Object.values(h.state.items['1'].files).every((f) => f.verification.status === 'pending'));
});

test('Arweave block hashes must be 48 bytes, not transaction ids', async () => {
  const h = harness(); h.badBlockHash = true;
  assert.equal(await h.run(), false);
});

test('bounded batch refuses more than 64 MiB before payload fetching or quoting', async () => {
  const h = harness(); h.publicFile.n = 32; h.publicFile.depth = 5;
  const pinned = structuredClone(h.pinState.items['1']);
  h.extraLogs = new Map(); h.feed.events = []; h.pinState.items = {};
  for (let i = 1; i <= 23; i++) {
    const transactionHash = hash(`fake transaction ${i}`);
    const event = { ...h.event, transactionHash };
    const log = { ...h.log, transactionHash, topics: encodeEventTopics({ abi: boxCollectionAbi, eventName: 'Revealed', args: { id: BigInt(i) } }) };
    h.extraLogs.set(transactionHash, log);
    h.feed.events.push({ transactionHash, logIndex: event.logIndex });
    h.pinState.items[String(i)] = { ...structuredClone(pinned), event };
    for (const f of Object.values(h.pinState.items[String(i)].files)) f.bytes = '1048576';
  }
  await assert.rejects(h.run(), /64 MiB/);
  assert.ok(h.calls.every((c) => c.url.startsWith('https://rpc.example/')));
});

test('stale quotes refuse new uploads and reserve nothing for unsigned work', async () => {
  const h = harness(); let ticks = 0;
  await assert.rejects(h.run('upload', { now: () => new Date(1791849600000 + ticks++ * 61_000) }), /expired/);
  assert.equal(h.posts().length, 0); assert.equal(h.keyReads, 0);
  assert.ok(Object.values(h.state.items['1'].files).every((f) => f.intent === null));
});

test('redirects, rate limits, malformed price JSON and oversized bodies make no upload', async () => {
  for (const response of [
    () => new Response(null, { status: 302, headers: { Location: 'https://unexpected.example' } }),
    () => new Response('FAKE_SECRET', { status: 429 }),
    () => new Response('FAKE_SECRET'),
    () => new Response('x'.repeat(16_385)),
  ]) {
    const h = harness(); const fetch = h.fetch;
    await assert.rejects(h.run('upload', { fetch: async (url, options) => url.startsWith('https://payment.example/') ? response() : fetch(url, options) }), (error) => !error.message.includes('FAKE_SECRET'));
    assert.equal(h.posts().length, 0);
  }
});

test('wrong acceptance id remains an unresolved intent with no receipt', async () => {
  const h = harness(); h.wrongId = true;
  await assert.rejects(h.run(), /id mismatch/);
  assert.equal(h.state.items['1'].files.image.receipt, null);
  assert.ok(h.state.items['1'].files.image.intent);
});

test('ambiguous accepted POST is reconciled by id; an unresolved intent is never re-uploaded', async () => {
  const h = harness(); h.failPost = true;
  await assert.rejects(h.run(), /upload/);
  assert.equal(h.posts().length, 1);
  const accepted = new Map(h.accepted); h.accepted.clear();
  assert.equal(await h.run('check'), false);
  await assert.rejects(h.run(), /unresolved/);
  assert.equal(h.posts().length, 1);
  h.accepted = accepted; h.failPost = false;
  assert.equal(await h.run('check'), false); // remaining three have no receipts yet
  assert.ok(h.state.items['1'].files.image.receipt);
  assert.equal(await h.run(), true);
  assert.equal(h.posts().length, 4);
});

test('receipt write failure leaves the persisted intent and prevents a second POST', async () => {
  const h = harness(); const save = h.store.save;
  h.store.save = async (s) => { if (s.items['1']?.files.image.receipt) throw new Error('fake disk error'); await save(s); };
  await assert.rejects(h.run());
  assert.equal(h.posts().length, 1); assert.ok(h.state.items['1'].files.image.intent);
  h.store.save = save;
  await h.run();
  assert.equal(h.posts().length, 4);
});

test('changed scope, corrupt receipt, duplicate gateway host and HTTP origins fail closed', async () => {
  const h = harness(); await h.run();
  const saved = structuredClone(h.state);
  for (const change of [
    () => { h.state.scope.collection = `0x${'34'.repeat(20)}`; },
    () => { h.state.items['1'].files.image.receipt.sha256 = hash('wrong'); },
    () => { h.state.items['1'].files.image.intent.id = 'invalid'; },
  ]) { h.state = structuredClone(saved); change(); await assert.rejects(h.run()); }
  const other = harness(); other.env.SH_ARWEAVE_GATEWAY_2 = 'https://ar-one.example:444';
  await assert.rejects(other.run(), /independent/);
  other.env.SH_ARWEAVE_GATEWAY_2 = 'http://ar-two.example';
  await assert.rejects(other.run(), /HTTPS/);
});

test('the reveal watcher\'s /2 feed is read like /1; its scan must bind this root and nothing else is added', async () => {
  const scan = (root) => ({ root, n: '2', depth: '1', startBlock: '1', through: { number: '10', hash: block } });
  const h = harness(); h.feed = { ...h.feed, format: 'squarehole.reveal-pin-feed/2', scan: scan(h.publicFile.root) };
  assert.equal(await h.run(), true);
  assert.equal(h.posts().length, 4);
  for (const change of [
    (feed) => { feed.scan = scan(hash('another root')); }, (feed) => { feed.scan = null; }, (feed) => { delete feed.scan; },
    (feed) => { feed.extra = true; }, (feed) => { feed.format = 'squarehole.reveal-pin-feed/3'; },
  ]) {
    const bad = harness(); bad.feed = { ...bad.feed, format: 'squarehole.reveal-pin-feed/2', scan: scan(bad.publicFile.root) }; change(bad.feed);
    await assert.rejects(bad.run(), /invalid reveal feed binding/);
    assert.equal(bad.calls.length, 0);
  }
  const v1 = harness(); v1.feed.scan = scan(v1.publicFile.root);
  await assert.rejects(v1.run(), /invalid reveal feed binding/);
});

test('empty feed does not read key or use provider or IPFS', async () => {
  const h = harness(); h.feed.events = [];
  assert.equal(await h.run(), true);
  assert.equal(h.calls.length, 0); assert.equal(h.keyReads, 0);
});

test('CLI strict modes, sanitized failures, file checkpoint durability and crash locks', async () => {
  await mkdir('.cache/arweave-tests', { recursive: true });
  const dir = await mkdtemp('.cache/arweave-tests/run-');
  const path = join(dir, 'state.json');
  await fileStateStore(path, async (s) => { assert.equal(await s.load(), null); await s.save({ test: 'fake' }); });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { test: 'fake' });
  await writeFile(`${path}.lock`, 'fake crash lock');
  await assert.rejects(fileStateStore(path, async () => {}), /lock/);
  for (const argv of [[], ['--upload', '--check'], ['--key', 'FAKE_SECRET'], ['--upload']]) {
    const output = [];
    const code = await runCli(argv, { env: {}, stdout: (s) => output.push(s), stderr: (s) => output.push(s) });
    assert.equal(code, 1); assert.ok(!output.join('').includes('FAKE_SECRET'));
  }
});

test('CLI full offline upload writes only public receipt fields; check works with key env getter forbidden', async () => {
  const h = harness();
  await mkdir('.cache/arweave-tests', { recursive: true });
  const dir = await mkdtemp('.cache/arweave-tests/cli-');
  for (const [envName, value] of [['SH_REVEAL_PUBLIC', h.publicFile], ['SH_REVEAL_FEED', h.feed], ['SH_REVEAL_STATE', h.pinState]]) {
    h.env[envName] = join(dir, `${envName}.json`); await writeFile(h.env[envName], JSON.stringify(value));
  }
  h.env.SH_ARWEAVE_STATE = join(dir, 'archive.json');
  const fetch = async (url, options) => {
    if (url === 'https://upload.example/v1/tx/arweave') h.state = JSON.parse(await readFile(h.env.SH_ARWEAVE_STATE, 'utf8'));
    return h.fetch(url, options);
  };
  const output = [];
  const deps = { env: h.env, fetch, loadKey: async () => privateKey, stdout: (s) => output.push(s), stderr: (s) => output.push(s) };
  assert.equal(await runCli(['--upload'], deps), 0, output.join(''));
  Object.defineProperty(h.env, 'SH_ARWEAVE_KEY_FILE', { get() { throw new Error('FAKE_SECRET_KEY_ACCESS'); } });
  assert.equal(await runCli(['--check'], deps), 0, output.join(''));
  const persisted = await readFile(h.env.SH_ARWEAVE_STATE, 'utf8');
  assert.ok(!persisted.includes('fake-token')); assert.ok(!persisted.includes(dir));
  assert.ok(!output.join('').includes('FAKE_SECRET'));
});
