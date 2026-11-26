import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadBoxSpecLibrary } from '../../packages/box-spec/scripts/lib/load-generated.mjs';
import { runCli } from './launch-check.mjs';

const { keccak256, toHex, parseAbi, encodeFunctionData, encodeFunctionResult } =
  createRequire(new URL('../../packages/chain/package.json', import.meta.url))('viem');
const lib = await loadBoxSpecLibrary();
const { BOX_0_MISFITS } = await import('../../packages/box-spec/src/generated/fixtures.v1.ts');
const zero = `0x${'0'.repeat(40)}`;
const addr = (n) => `0x${BigInt(n).toString(16).padStart(40, '0')}`;
const hash = (s) => keccak256(toHex(s));
const sha = (s) => `0x${createHash('sha256').update(s).digest('hex')}`;
const generator = `0x1a29e4a78b7ace9c3ffe5dff2b6fd4e6a7db0416${'0'.repeat(24)}`;
const block = { number: '0x100', hash: hash('block'), timestamp: '0x6b49d200' };
const now = 1800000000n;
const code = '0x60006000f3';
const codeHash = keccak256(code);
const platform = BOX_0_MISFITS.marketplaceOwner.toLowerCase();
const gates = ['edition-sealed', 'counsel-terms', 'q16', 'box0-review', 'box0-rehearsal', 'v2-sepolia', 'v2-m3', 'hosting'];
// F143: box 0's source is the pinned BoxBackedSource and rounds live on the pinned DrandSource it names. Both runtimes
// are committed fixtures whose keccak is the spec's pin (the second poster's and the indexer's offline tests read them).
const runtime = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')).runtime;
const backedSource = lib.RANDOMNESS_SOURCE.toLowerCase();
const drandSource = lib.DRAND_SOURCE.toLowerCase();
const sourceCode = [[backedSource, runtime('./drand-rescue/test/backed-runtime.json')],
  [drandSource, runtime('../../packages/indexer/test/fixtures/f143-drand-runtime.json')]];
assert.equal(keccak256(sourceCode[0][1]), lib.RANDOMNESS_SOURCE_CODE_HASH);
assert.equal(keccak256(sourceCode[1][1]), lib.DRAND_SOURCE_CODE_HASH);

async function fixture(n = 4269, phase = 2) {
  await mkdir('.cache/mainnet-launch-tests', { recursive: true });
  const dir = await mkdtemp(resolve('.cache/mainnet-launch-tests/case-'));
  const m = {
    format: 'squarehole.mainnet-launch/1', chainId: '1', candidate: 'a'.repeat(40),
    editionCount: String(n), files: {}, gates: {},
    // F151 R68-SAFE: the founder, the bot and the backup by role; the platform's other two owners are the founder's picks.
    owners: { founder: addr(5), bot: addr(4), backup: addr(6) },
    safes: {},
    box0: { registry: addr(10), coordinator: addr(11), factory: addr(12), hook: addr(13),
      collection: addr(14), token: addr(15), receiver: addr(16), executor: addr(17), randomness: backedSource, poolManager: addr(19) },
    v2: { factory: addr(30), registry: addr(31), listingRegistry: addr(32), versionCodeHash: hash('version'),
      implementations: Array.from({ length: 24 }, (_, i) => [0,1,2,3,4,5,6,7,8,16,17,19,20,21,22].includes(i) ? addr(100 + i) : zero) },
    code: {},
  };
  const put = async (name, value) => {
    const text = JSON.stringify(value);
    await writeFile(join(dir, `${name}.json`), text);
    return { path: `${name}.json`, sha256: sha(text) };
  };
  const table = '0x0100045465737401044b696e64010141';
  const spec = { ...BOX_0_MISFITS, n, openAt: 1800003600, metadataTable: table,
    revealRoot: hash('synthetic curated root'), generatorHash: generator };
  const specDoc = { format: 'squarehole.box0-spec/1', chainId: 1, build: 'mainnet',
    specHash: lib.specHash(spec), encoded: lib.encodeBoxSpecV1(spec) };
  const commitment = { format: 'squarehole.box0-commitment/1', n, depth: Math.ceil(Math.log2(n)),
    root: spec.revealRoot, generatorHash: generator, generatorTree: generator.slice(2,42), renderGeneratorTree: generator.slice(2,42),
    metadataTable: { hash: keccak256(table), bytes: (table.length - 2) / 2 },
    encoding: { image: { format: 'webp', size: 512, quality: 90 }, avatar: { format: 'webp', size: 256 }, model: { format: 'glb' } },
    archive: { escrowIntent: 'trustees-2-of-3', keySplit: 'shamir-2-of-3', sha256: hash('archive'), keyId: hash('key-id') } };
  const receipt = { format: 'squarehole.box0-key-split-receipt/1', scheme: 'shamir-2-of-3', threshold: 2,
    archiveSha256: commitment.archive.sha256, keyId: commitment.archive.keyId,
    shareFiles: [1,2,3].map((trustee) => ({ trustee, sha256: hash(`share-${trustee}`) })), verified: ['pair 1+2', 'pair 1+3', 'pair 2+3'] };
  m.files.commitment = await put('commitment', commitment);
  m.files.table = await put('table', { format: 'squarehole.box-trait-table/1', table });
  m.files.spec = await put('spec', specDoc);
  m.files.trustees = await put('trustees', receipt);
  for (const id of gates) m.gates[id] = await put(id, { id, result: 'pass', candidate: m.candidate,
    specHash: specDoc.specHash, reviewer: 'synthetic test only', evidence: 'fixture, not launch evidence' });
  const replies = new Map();
  function view(address, signature, result, args = []) {
    const abi = parseAbi([`function ${signature}`]);
    const functionName = abi[0].name;
    const data = encodeFunctionData({ abi, functionName, args });
    replies.set(`${address.toLowerCase()}:${data}`, encodeFunctionResult({ abi, functionName, result }));
  }
  for (const [name, address] of [['fit',addr(1)], ['platform',platform]]) {
    const owners = name === 'platform' ? [addr(5),addr(7),addr(8)] : [addr(4),addr(5),addr(6)];
    const s = m.safes[name] = { address, owners, threshold: '2', version: '1.4.1',
      singleton: addr(3), codeHash, singletonCodeHash: codeHash, guard: zero, handler: zero };
    // Safe's getOwners() lists the newest owner first: after the runbook's two addOwnerWithThreshold calls the founder is last.
    view(address, 'getOwners() view returns (address[])', name === 'platform' ? [addr(8),addr(7),addr(5)] : owners);
    view(address, 'getThreshold() view returns (uint256)', BigInt(s.threshold));
    view(address, 'VERSION() view returns (string)', s.version);
    view(address, 'masterCopy() view returns (address)', s.singleton);
    view(address, 'getModulesPaginated(address,uint256) view returns (address[],address)', [[], addr(1)], [addr(1), 1n]);
  }
  const b = m.box0;
  view(b.registry, 'coordinatorOf(uint256) view returns (address)', b.coordinator, [0n]);
  for (const field of ['factory','hook','collection','token','receiver','executor','randomness','poolManager'])
    view(b.coordinator, `${field}() view returns (address)`, b[field]);
  view(b.coordinator, 'kind() view returns (uint8)', 1);
  view(b.coordinator, 'boxId() view returns (uint256)', 0n);
  view(b.coordinator, 'q() view returns (address)', zero);
  view(b.coordinator, 'raise() view returns (uint256)', spec.raise);
  view(b.coordinator, 'specHash() view returns (bytes32)', specDoc.specHash);
  view(b.hook, 'openAt() view returns (uint256)', BigInt(spec.openAt));
  view(b.hook, 'windowEndsAt() view returns (uint256)', BigInt(spec.openAt) + 384n);
  view(b.hook, 'phase() view returns (uint8)', phase);
  view(b.coordinator, 'phase() view returns (uint8)', phase);
  // V1 retains the curve's closed flag after successful graduation.
  view(b.hook, 'closed() view returns (bool)', phase === 4 || phase === 5);
  view(b.coordinator, 'graduated() view returns (bool)', phase === 5);
  view(b.collection, 'collectionSize() view returns (uint256)', BigInt(n));
  view(b.collection, 'revealRoot() view returns (bytes32)', spec.revealRoot);
  view(b.collection, 'generatorHash() view returns (bytes32)', generator);
  view(b.collection, 'metadataTableHash() view returns (bytes32)', keccak256(table));
  view(b.collection, 'owner() view returns (address)', platform);
  view(b.receiver, 'platformSafe() view returns (address)', platform);
  view(b.randomness, 'DRAND() view returns (address)', lib.DRAND_SOURCE);
  const v = m.v2;
  view(v.factory, 'VERSION() view returns (uint16)', 2);
  for (const field of ['registry','listingRegistry']) view(v.factory, `${field}() view returns (address)`, v[field]);
  view(v.factory, 'versionCodeHash() view returns (bytes32)', v.versionCodeHash);
  view(v.registry, 'factory() view returns (address)', v.factory);
  view(v.registry, 'directory() view returns (address[])', [b.registry]);
  view(v.listingRegistry, 'lister() view returns (address)', platform);
  for (const [i, a] of v.implementations.entries()) view(v.factory, 'implementation(uint256) view returns (address)', a, [BigInt(i)]);
  for (const [name, safe] of Object.entries(m.safes))
    view(v.implementations[5], `${name.toUpperCase()}_SAFE() view returns (address)`, safe.address);
  // RC6 inbox wiring: mainnet's ComposableCoW, settlement and domain separator (synthetic code pins).
  const cow = v.cow = { composableCow: addr(0xc0), settlement: addr(0xc1), handler: addr(0xc2), minimumLot: '50000000000000000',
    domainSeparator: `0x${'c0'.repeat(32)}` };
  for (const [field, value] of [['composableCow', cow.composableCow], ['settlement', cow.settlement], ['cowHandler', cow.handler], ['vaultRelayer', addr(0xc3)]])
    view(v.implementations[8], `${field}() view returns (address)`, value);
  view(v.implementations[8], 'minimumLot() view returns (uint256)', 50000000000000000n);
  view(cow.settlement, 'vaultRelayer() view returns (address)', addr(0xc3));
  view(cow.settlement, 'domainSeparator() view returns (bytes32)', cow.domainSeparator);
  for (const a of [cow.composableCow, cow.settlement, addr(0xc3), cow.handler]) m.code[a] = codeHash;
  for (const a of [...Object.values(b), v.factory,v.registry,v.listingRegistry,...v.implementations]) if (a !== zero) m.code[a] = codeHash;
  const codes = new Map(sourceCode);
  for (const [a, bytes] of codes) if (m.code[a]) m.code[a] = keccak256(bytes);
  const lotToken = addr(0xd1), weth = addr(0xd0);
  const lotPrice = { tokenAmount: '1000000', wethAmount: '500000000000000',
    source: 'synthetic USDC/WETH spot, 2000 USDC per WETH', blockNumber: '256', blockHash: block.hash, timestamp: now.toString() };
  const lots = { format: 'squarehole.royalty-lots/1', chainId: '1', registry: v.listingRegistry, weth,
    entries: [{ token: lotToken, listingId: '1', lot: '100000000', price: lotPrice }] };
  v.royaltyLots = await put('royalty-lots', lots);
  view(v.listingRegistry, 'weth() view returns (address)', weth);
  view(v.factory, 'weth() view returns (address)', weth);
  view(v.listingRegistry, 'sellableVersion() view returns (uint256)', 3n);
  view(v.listingRegistry, 'sellableCount(uint256) view returns (uint256)', 2n, [3n]);
  view(v.listingRegistry, 'sellableToken(uint256) view returns (address)', weth, [0n]);
  view(v.listingRegistry, 'sellableToken(uint256) view returns (address)', lotToken, [1n]);
  view(v.listingRegistry, 'sellableLotAt(address,uint256) view returns (uint256)', 50000000000000000n, [weth, 3n]);
  view(v.listingRegistry, 'sellableLotAt(address,uint256) view returns (uint256)', 100000000n, [lotToken, 3n]);
  view(v.listingRegistry, 'newestListingOf(address) view returns (bool,uint32)', [true, 1], [lotToken]);
  const lotRow = { id: 1, token: lotToken, decimals: 6, class: 3, kind: 1, listedAt: now,
    raise: 1000000000n, q: { bootstrapQ: 1n, batchMinQ: 1n, tipMaxQ: 1n, swapStepMinQ: 1n } };
  const lotSignature = 'listing(uint32) view returns ((uint32 id,address token,uint8 decimals,uint8 class,uint8 kind,uint64 listedAt,uint256 raise,(uint256 bootstrapQ,uint256 batchMinQ,uint256 tipMaxQ,uint256 swapStepMinQ) q))';
  view(v.listingRegistry, lotSignature, lotRow, [1]);
  const calls = [];
  const transport = async (url, options) => {
    assert.equal(url, 'https://rpc.invalid/');
    assert.equal(options.redirect, 'error');
    const req = JSON.parse(options.body); calls.push(req);
    let result;
    if (req.method === 'eth_chainId') result = '0x1';
    else if (req.method === 'eth_getBlockByNumber') result = block;
    else if (req.method === 'eth_getCode') result = codes.get(req.params[0].toLowerCase()) ?? code;
    else if (req.method === 'eth_getStorageAt') result = `0x${'0'.repeat(64)}`;
    else if (req.method === 'eth_call') {
      assert.deepEqual(req.params[1], { blockHash: block.hash, requireCanonical: true });
      result = replies.get(`${req.params[0].to.toLowerCase()}:${req.params[0].data}`);
      assert.ok(result, `unexpected call ${req.params[0].data}`);
    } else assert.fail(`forbidden method ${req.method}`);
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: req.id, result }) };
  };
  const run = async (step, fetch = transport, extra = [], clock = now) => {
    await writeFile(join(dir,'launch.json'), JSON.stringify(m));
    let stdout = '', stderr = '';
    const status = await runCli(['--step',step,'--manifest',join(dir,'launch.json'),
      ...(step === 'edition' ? [] : ['--rpc-url','https://rpc.invalid/']), ...extra],
    { fetch, now: () => clock, stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; } });
    return { status, stdout, stderr };
  };
  return { m, run, view, put, calls, transport, spec, specDoc, commitment, receipt, lots, lotRow, lotSignature, codes, replies };
}

test('LR-01: sealed public edition passes offline; founder count is not hard-coded', async () => {
  for (const n of [4269, 4201]) {
    const f = await fixture(n); const r = await f.run('edition');
    assert.equal(r.status,0,r.stderr); assert.equal(f.calls.length,0);
    assert.equal(JSON.parse(r.stdout).editionCount,String(n));
  }
});
for (const [name, mutate] of [
  ['count drift', async (f) => { f.m.editionCount = '4200'; }],
  ['file tamper', async (f) => { f.m.files.spec.sha256 = hash('wrong'); }],
  ['summary does not hide encoded spec drift', async (f) => { f.m.files.spec = await f.put('spec', { ...f.specDoc, specHash: hash('wrong') }); }],
  ['old generator', async (f) => { f.commitment.generatorHash = hash('old'); f.m.files.commitment = await f.put('commitment',f.commitment); }],
  ['wrong trustee archive', async (f) => { f.receipt.archiveSha256 = hash('other'); f.m.files.trustees = await f.put('trustees',f.receipt); }],
  ['missing gate', async (f) => { delete f.m.gates['edition-sealed']; }],
  ['stale gate', async (f) => { f.m.gates['edition-sealed'] = await f.put('gate', { id:'edition-sealed', result:'pass', candidate:'b'.repeat(40), specHash:f.specDoc.specHash }); }],
  ['path escape', async (f) => { f.m.files.spec.path = '../secret.json'; }],
]) test(`LR-02: refuses ${name}`, async () => { const f = await fixture(); await mutate(f); assert.equal((await f.run('edition')).status,1); });

test('LR-03: preflight checks all human gates, time and Safe owners without a signer', async () => {
  const f = await fixture(); const r = await f.run('preflight'); assert.equal(r.status,0,r.stderr);
  assert.ok(f.calls.some((c) => c.method === 'eth_getStorageAt'));
  assert.ok(f.calls.every((c) => ['eth_chainId','eth_getBlockByNumber','eth_getCode','eth_getStorageAt','eth_call'].includes(c.method)));
});
for (const [name, mutate] of [
  ['one-signature FIT Safe', (f) => f.view(addr(1),'getThreshold() view returns (uint256)',1n)],
  ['wrong owner', (f) => f.view(addr(1),'getOwners() view returns (address[])',[addr(4),addr(5),addr(9)])],
  ['a third Safe', (f) => { f.m.safes.conversion = { ...f.m.safes.fit, address: addr(2) }; }],
  ['module enabled', (f) => f.view(addr(1),'getModulesPaginated(address,uint256) view returns (address[],address)',[[addr(9)],addr(1)],[addr(1),1n])],
  ['missing Sepolia', (f) => { delete f.m.gates['v2-sepolia']; }],
  ['missing M3', (f) => { delete f.m.gates['v2-m3']; }],
]) test(`LR-04: refuses ${name}`, async () => { const f = await fixture(); mutate(f); assert.equal((await f.run('preflight')).status,1); });

// SH-188 (F151 R68-SAFE): the mainnet platform Safe is 2-of-3, its expected owners taken from the public manifest, the
// founder among them in any order and never the bot; a manifest without the roles, or a 1-of-1 Safe, is refused.
const PLATFORM_OWNERS = 'getOwners() view returns (address[])';
for (const [name, mutate, reason] of [
  ['the 1-of-1 platform Safe on chain (threshold 1)', (f) => f.view(platform,'getThreshold() view returns (uint256)',1n), /Safe threshold mismatch/],
  ['a platform pin at threshold 1', (f) => { f.m.safes.platform.threshold = '1'; }, /Safe threshold pin mismatch/],
  ['a platform Safe at threshold 3', (f) => f.view(platform,'getThreshold() view returns (uint256)',3n), /Safe threshold mismatch/],
  ['the founder alone as the platform owner (the 1-of-1 shape)', (f) => {
    f.m.safes.platform.owners = [addr(5)]; f.view(platform,PLATFORM_OWNERS,[addr(5)]);
  }, /invalid Safe owners/],
  ['four platform owners', (f) => {
    f.m.safes.platform.owners = [addr(5),addr(7),addr(8),addr(9)]; f.view(platform,PLATFORM_OWNERS,[addr(9),addr(8),addr(7),addr(5)]);
  }, /invalid Safe owners/],
  ['two platform owners', (f) => {
    f.m.safes.platform.owners = [addr(5),addr(7)]; f.view(platform,PLATFORM_OWNERS,[addr(7),addr(5)]);
  }, /invalid Safe owners/],
  ['a repeated platform owner', (f) => { f.m.safes.platform.owners = [addr(5),addr(7),addr(7)]; }, /invalid Safe owners/],
  ['a chain owner set other than the manifest\'s', (f) => f.view(platform,PLATFORM_OWNERS,[addr(9),addr(7),addr(5)]), /Safe owners mismatch/],
  ['the bot as a platform owner', (f) => {
    f.m.safes.platform.owners = [addr(5),addr(4),addr(8)]; f.view(platform,PLATFORM_OWNERS,[addr(8),addr(4),addr(5)]);
  }, /bot is never a platform Safe owner/],
  ['a platform Safe without the founder', (f) => {
    f.m.safes.platform.owners = [addr(9),addr(7),addr(8)]; f.view(platform,PLATFORM_OWNERS,[addr(8),addr(7),addr(9)]);
  }, /founder missing from the platform Safe/],
  ['a manifest without the owners roles', (f) => { delete f.m.owners; }, /owners roles required/],
  ['owners roles without the backup', (f) => { delete f.m.owners.backup; }, /owners roles required/],
  ['owners roles with an extra role', (f) => { f.m.owners.second = addr(7); }, /owners roles required/],
  ['owners roles naming one account twice', (f) => { f.m.owners.backup = addr(4); }, /three distinct accounts/],
  ['FIT owners other than the roles', (f) => { f.m.owners.backup = addr(9); }, /FIT owners \(bot, founder, backup\) mismatch/],
]) test(`LR-18: preflight refuses ${name}`, async () => {
  const f = await fixture(); mutate(f); const r = await f.run('preflight');
  assert.equal(r.status, 1, r.stdout); assert.equal(r.stdout, ''); assert.match(r.stderr, reason);
});
test('LR-18: the 2-of-3 platform Safe passes with the founder first, last or between the two new owners', async () => {
  for (const order of [[addr(5),addr(7),addr(8)], [addr(8),addr(7),addr(5)], [addr(7),addr(5),addr(8)]]) {
    const f = await fixture(); f.view(platform, PLATFORM_OWNERS, order); f.m.safes.platform.owners = [...order].reverse();
    const r = await f.run('preflight'); assert.equal(r.status, 0, r.stderr);
  }
});

test('LR-05: box0 and complete release identities pass at one canonical block', async () => {
  const f = await fixture();
  for (const step of ['box0','v2']) { const r = await f.run(step); assert.equal(r.status,0,r.stderr); }
});
for (const [name, mutate] of [
  ['wrong root', (f) => f.view(f.m.box0.collection,'revealRoot() view returns (bytes32)',hash('wrong'))],
  ['wrong raw raise', (f) => f.view(f.m.box0.coordinator,'raise() view returns (uint256)',f.spec.raise + 1n)],
  ['wrong immutable Safe', (f) => f.view(f.m.v2.implementations[5],'FIT_SAFE() view returns (address)',addr(99))],
  ['wrong inbox ComposableCoW', (f) => f.view(f.m.v2.implementations[8],'composableCow() view returns (address)',addr(99))],
  ['wrong CoW domain', (f) => f.view(f.m.v2.cow.settlement,'domainSeparator() view returns (bytes32)',hash('other chain'))],
  ['wrong WETH minimum', (f) => f.view(f.m.v2.implementations[8],'minimumLot() view returns (uint256)',1n)],
  ['another relayer', (f) => f.view(f.m.v2.implementations[8],'vaultRelayer() view returns (address)',addr(99))],
  ['missing CoW inputs', (f) => { delete f.m.v2.cow; }],
  ['M1/M2-only release', (f) => { f.m.v2.implementations[16] = zero; }],
  ['uncommitted code', (f) => { f.m.code = Object.fromEntries(Object.entries(f.m.code).filter(([a]) => a !== f.m.v2.factory)); }],
]) test(`LR-06: refuses ${name}`, async () => { const f = await fixture(); mutate(f); assert.equal((await f.run('v2')).status,1); });

// rc8 open item 76 (F143): box 0's source must be the pinned BoxBackedSource, and the DrandSource its DRAND() names the
// pinned one, each by address and runtime code at the checked finalized block.
const DRAND_CALL = encodeFunctionData({ abi: parseAbi(['function DRAND() view returns (address)']), functionName: 'DRAND' });
test('LR-16: box0 reads the backed source\'s DRAND() once at the finalized block and checks the DrandSource\'s code', async () => {
  const f = await fixture(); const r = await f.run('box0'); assert.equal(r.status, 0, r.stderr);
  const reads = f.calls.filter((c) => c.method === 'eth_call' && c.params[0].to.toLowerCase() === backedSource
    && c.params[0].data === DRAND_CALL);
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0].params[1], { blockHash: block.hash, requireCanonical: true });
  const codeReads = f.calls.filter((c) => c.method === 'eth_getCode' && c.params[0].toLowerCase() === drandSource);
  assert.equal(codeReads.length, 1);
  assert.deepEqual(codeReads[0].params[1], { blockHash: block.hash, requireCanonical: true });
});
for (const [name, mutate, reason] of [
  ['a backed source naming another DrandSource', (f) => f.view(backedSource, 'DRAND() view returns (address)', addr(77)),
    /backed source DRAND mismatch/],
  ['other code at the pinned DrandSource', (f) => f.codes.set(drandSource, code), /runtime code mismatch/],
  ['a backed source that answers no DRAND()', (f) => f.replies.delete(`${backedSource}:${DRAND_CALL}`), /RPC read failed/],
  ['box 0 on the plain DrandSource (a drand-only deploy)', (f) => {
    f.m.box0.randomness = drandSource; f.m.code[drandSource] = lib.DRAND_SOURCE_CODE_HASH;
    f.view(f.m.box0.coordinator, 'randomness() view returns (address)', drandSource);
    f.view(drandSource, 'DRAND() view returns (address)', lib.DRAND_SOURCE);
  }, /box 0 randomness source mismatch/],
  ['the backed source\'s address with other code, pinned so in the manifest', (f) => {
    f.codes.set(backedSource, code); f.m.code[backedSource] = codeHash;
  }, /runtime code mismatch/],
]) for (const step of ['box0', 'v2']) test(`LR-17: ${step} refuses ${name}`, async () => {
  const f = await fixture(); mutate(f); const r = await f.run(step);
  assert.equal(r.status, 1, r.stdout); assert.equal(r.stdout, ''); assert.match(r.stderr, reason);
});

test('LR-07: cannot call an upcoming box open; open requires published release evidence', async () => {
  const f = await fixture(); assert.equal((await f.run('open')).status,1);
  f.m.gates['release-published'] = await f.put('published',{ id:'release-published', result:'pass', candidate:f.m.candidate,
    specHash:f.specDoc.specHash, reviewer:'fixture', evidence:'fixture' });
  const early = await f.run('open');
  assert.equal(early.status,1); assert.match(early.stderr,/not open/);
  const openTransport = async (url, opts) => {
    const response = await f.transport(url,opts); const json = await response.json();
    if (JSON.parse(opts.body).method === 'eth_getBlockByNumber' && JSON.parse(opts.body).params[0] !== '0x100') json.result = { ...block, number: '0x101', timestamp:`0x${(now+3600n).toString(16)}` };
    return { ok:true, json:async () => json };
  };
  const r = await f.run('open',openTransport,[],now+3600n); assert.equal(r.status,0,r.stderr);
});

async function openFixture(phase, secondsAfterOpen = 0n) {
  const f = await fixture(4269, phase);
  f.m.gates['release-published'] = await f.put('published', { id:'release-published', result:'pass', candidate:f.m.candidate,
    specHash:f.specDoc.specHash, reviewer:'fixture', evidence:'fixture' });
  const timestamp = BigInt(f.spec.openAt) + secondsAfterOpen;
  const transport = async (url, opts) => {
    const response = await f.transport(url, opts); const json = await response.json();
    if (JSON.parse(opts.body).method === 'eth_getBlockByNumber' && JSON.parse(opts.body).params[0] !== '0x100') json.result = { ...block, number: '0x101', timestamp:`0x${timestamp.toString(16)}` };
    return { ok:true, json:async () => json };
  };
  return { ...f, runOpen: (fetch = transport) => f.run('open', fetch, [], timestamp), openTransport:transport };
}

for (const [name, phase, seconds] of [
  ['filled but ungraduated at opening', 4, 0n],
  ['filled but ungraduated after the window', 4, 384n],
  ['uninitialized', 0, 0n],
  ['unlaunched', 1, 0n],
  ['failed', 6, 384n],
  ['unknown phase', 255, 0n],
]) test(`LR-12: open refuses ${name} despite elapsed openAt`, async () => {
  const f = await openFixture(phase, seconds); const r = await f.runOpen();
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.stdout, ''); assert.match(r.stderr, /box 0 phase .* not tradable/);
});

for (const [name, phase, seconds] of [['Window', 2, 0n], ['Bonding', 3, 384n], ['Graduated', 5, 384n]])
  test(`LR-13: open accepts and reports ${name} at the pinned finalized block`, async () => {
    const f = await openFixture(phase, seconds); const r = await f.runOpen();
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(r.stdout);
    assert.equal(report.box0Phase, name); assert.equal(report.blockHash, block.hash);
    const abi = parseAbi(['function phase() view returns (uint8)']);
    const data = encodeFunctionData({ abi, functionName:'phase' });
    for (const to of [f.m.box0.hook, f.m.box0.coordinator]) {
      const reads = f.calls.filter((c) => c.method === 'eth_call' && c.params[0].to === to && c.params[0].data === data);
      assert.equal(reads.length, 1);
      assert.deepEqual(reads[0].params[1], { blockHash:block.hash, requireCanonical:true });
    }
  });

for (const member of ['hook', 'coordinator']) test(`LR-14: open refuses a disagreeing ${member} phase`, async () => {
  const f = await openFixture(2);
  f.view(f.m.box0[member], 'phase() view returns (uint8)', 3);
  const r = await f.runOpen();
  assert.equal(r.status, 1, r.stdout); assert.equal(r.stdout, ''); assert.match(r.stderr, /box 0 phase mismatch/);
});

for (const fault of ['empty', 'error']) test(`LR-15: open refuses ${fault} lifecycle reads`, async () => {
  const f = await openFixture(2);
  const abi = parseAbi(['function phase() view returns (uint8)']);
  const data = encodeFunctionData({ abi, functionName:'phase' });
  const transport = async (url, opts) => {
    const req = JSON.parse(opts.body); const response = await f.openTransport(url, opts); const json = await response.json();
    if (req.method === 'eth_call' && req.params[0].data === data) {
      if (fault === 'empty') json.result = '0x';
      else json.error = { code:-32000, message:'lifecycle unavailable' };
    }
    return { ok:true, json:async () => json };
  };
  const r = await f.runOpen(transport);
  assert.equal(r.status, 1, r.stdout); assert.equal(r.stdout, '');
});

test('LR-08: wrong chain, RPC failure, malformed bytes, reorg and redirects fail closed', async () => {
  for (const fault of ['chain','error','empty','reorg','redirect']) {
    const f = await fixture(); let blocks = 0;
    const transport = async (url,opts) => {
      const req = JSON.parse(opts.body); const response = await f.transport(url,opts); const json = await response.json();
      if (fault === 'chain' && req.method === 'eth_chainId') json.result = '0xaa36a7';
      if (fault === 'error') return { ok:true, json: async () => ({ ...json, error:{ message:'credential must not leak' } }) };
      if (fault === 'empty' && req.method === 'eth_call') json.result = '0x';
      if (fault === 'reorg' && req.method === 'eth_getBlockByNumber' && ++blocks > 2) json.result = { ...block, hash:hash('reorg') };
      if (fault === 'redirect') return { ok:false, status:302 };
      return { ok:true, json:async () => json };
    };
    const r = await f.run('preflight',transport); assert.equal(r.status,1,fault); assert.doesNotMatch(r.stderr,/credential/);
  }
});

test('LR-09: invalid options never read a key or touch the network', async () => {
  const f = await fixture(); const r = await f.run('preflight',() => assert.fail('network'),['--private-key','not-a-key']);
  assert.equal(r.status,1); assert.doesNotMatch(r.stderr,/not-a-key/);
});


test('LR-10: a correctly pinned oversized v2 runtime is still refused', async () => {
  const f = await fixture(); const big = `0x${'60'.repeat(22119)}`;
  f.m.code[f.m.v2.factory] = keccak256(big);
  const transport = async (url,opts) => {
    const req = JSON.parse(opts.body);
    if (req.method === 'eth_getCode' && req.params[0] === f.m.v2.factory)
      return { ok:true, json:async () => ({ jsonrpc:'2.0',id:req.id,result:big }) };
    return f.transport(url,opts);
  };
  const r = await f.run('v2',transport);
  assert.equal(r.status,1); assert.match(r.stderr,/22,118/);
});

test('LR-11: known test root cannot pass even with matching spec and public hashes', async () => {
  const f = await fixture();
  f.spec.revealRoot = BOX_0_MISFITS.revealRoot; f.commitment.root = f.spec.revealRoot;
  f.m.files.commitment = await f.put('commitment',f.commitment);
  f.m.files.spec = await f.put('spec',{ ...f.specDoc,encoded:lib.encodeBoxSpecV1(f.spec),specHash:lib.specHash(f.spec) });
  const r = await f.run('edition'); assert.equal(r.status,1); assert.match(r.stderr,/test root/);
});

for (const step of ['v2', 'open', 'listing']) test(`LL-02: ${step} refuses a default whole-coin lot even with matching notes`, async () => {
  const f = step === 'open' ? await openFixture(2) : await fixture();
  f.lots.entries[0].lot = '1000000';
  f.m.v2.royaltyLots = await f.put('royalty-lots', f.lots);
  f.view(f.m.v2.listingRegistry, 'sellableLotAt(address,uint256) view returns (uint256)', 1000000n, [f.lots.entries[0].token, 3n]);
  const r = step === 'open' ? await f.runOpen() : await f.run(step);
  assert.equal(r.status, 1); assert.match(r.stderr, /default whole-coin lot/);
});

for (const [lot, pass] of [['50000000', true], ['200000000', true], ['49999999', false], ['200000001', false]])
  test(`LL-03: exact inclusive value bounds at raw lot ${lot}`, async () => {
    const f = await fixture(); f.lots.entries[0].lot = lot;
    f.m.v2.royaltyLots = await f.put('royalty-lots', f.lots);
    f.view(f.m.v2.listingRegistry, 'sellableLotAt(address,uint256) view returns (uint256)', BigInt(lot), [f.lots.entries[0].token, 3n]);
    const r = await f.run('v2'); assert.equal(r.status, pass ? 0 : 1, r.stderr);
    if (!pass) assert.match(r.stderr, /lot outside/);
  });

test('LL-04: STOCK class comes from the registry and requires the larger lot', async () => {
  const f = await fixture(); f.lotRow.class = 4;
  f.view(f.m.v2.listingRegistry, f.lotSignature, f.lotRow, [1]);
  const r = await f.run('v2'); assert.equal(r.status, 1); assert.match(r.stderr, /lot outside/);
});

for (const [name, change] of [
  ['missing coin', f => { f.lots.entries = []; }],
  ['duplicate coin', f => { f.lots.entries.push(f.lots.entries[0]); }],
  ['wrong registry', f => { f.lots.registry = addr(999); }],
  ['wrong WETH', f => { f.lots.weth = addr(999); }],
  ['wrong chain', f => { f.lots.chainId = '11155111'; }],
  ['missing source', f => { f.lots.entries[0].price.source = ''; }],
  ['zero price', f => { f.lots.entries[0].price.wethAmount = '0'; }],
  ['numeric price', f => { f.lots.entries[0].price.wethAmount = 5; }],
  ['future price', f => { f.lots.entries[0].price.timestamp = (now + 1n).toString(); }],
  ['wrong price block hash', f => { f.lots.entries[0].price.blockHash = hash('wrong price block'); }],
  ['wrong price block time', f => { f.lots.entries[0].price.timestamp = (now - 1n).toString(); }],
  ['wrong listing ID', f => { f.lots.entries[0].listingId = '2'; }],
  ['lot mismatch', f => { f.lots.entries[0].lot = '110000000'; }],
]) test(`LL-05: refuses ${name} in the price receipt`, async () => {
  const f = await fixture(); change(f); f.m.v2.royaltyLots = await f.put('royalty-lots', f.lots);
  const r = await f.run('v2'); assert.equal(r.status, 1, r.stdout);
});

test('LL-07: listing passes at the captured sale version; STOCK accepts 0.25 WETH', async () => {
  const f = await fixture(); f.lotRow.class = 4;
  f.view(f.m.v2.listingRegistry, f.lotSignature, f.lotRow, [1]);
  f.lots.entries[0].lot = '500000000';
  f.view(f.m.v2.listingRegistry, 'sellableLotAt(address,uint256) view returns (uint256)', 500000000n, [f.lots.entries[0].token, 3n]);
  f.m.v2.royaltyLots = await f.put('royalty-lots', f.lots);
  const r = await f.run('listing'); assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).sellableVersion, '3');
});

test('LL-08: a missing receipt, an extra coin and an unreadable lot all fail closed', async () => {
  const missing = await fixture(); delete missing.m.v2.royaltyLots;
  assert.equal((await missing.run('v2')).status, 1);
  const extra = await fixture(); extra.lots.entries.push({ ...extra.lots.entries[0], token: addr(999) });
  extra.m.v2.royaltyLots = await extra.put('royalty-lots', extra.lots);
  assert.equal((await extra.run('v2')).status, 1);
  const f = await fixture();
  const abi = parseAbi(['function sellableLotAt(address,uint256) view returns (uint256)']);
  const data = encodeFunctionData({ abi, functionName: 'sellableLotAt', args: [f.lots.entries[0].token, 3n] });
  const transport = async (url, opts) => {
    const response = await f.transport(url, opts), json = await response.json();
    if (JSON.parse(opts.body).params[0]?.data === data) json.result = '0x';
    return { ok: true, json: async () => json };
  };
  assert.equal((await f.run('v2', transport)).status, 1);
});

test('LL-09: WETH wiring uses the factory, never clone arguments on the bare inbox implementation', async () => {
  const f = await fixture(); const r = await f.run('v2');
  assert.equal(r.status, 0, r.stderr);
  const abi = parseAbi(['function weth() view returns (address)']);
  const data = encodeFunctionData({ abi, functionName: 'weth' });
  const reads = f.calls.filter(c => c.method === 'eth_call' && c.params[0].data === data);
  assert.deepEqual(reads.map(c => c.params[0].to).sort(), [f.m.v2.factory, f.m.v2.listingRegistry].sort());
  f.view(f.m.v2.factory, 'weth() view returns (address)', addr(999));
  const wrong = await f.run('v2'); assert.equal(wrong.status, 1); assert.match(wrong.stderr, /factory WETH mismatch/);
});

for (const step of ['v2', 'open', 'listing']) test(`LL-09: ${step} refuses a sale list longer than our keeper and indexer read per inbox (LIM-3)`, async () => {
  const f = step === 'open' ? await openFixture(2) : await fixture();
  f.view(f.m.v2.listingRegistry, 'sellableCount(uint256) view returns (uint256)', 29n, [3n]);
  const r = step === 'open' ? await f.runOpen() : await f.run(step);
  assert.equal(r.status, 1); assert.match(r.stderr, /29 coins, more than the 28/);
});

test('LL-10: the sale-list bound leaves the indexer room for ETH, the box\'s own T and two coins learned from receipts', async () => {
  const { MAX_SALE_LIST } = await import('./launch-check.mjs');
  const { readFile } = await import('node:fs/promises');
  const bound = async (file, name) => BigInt(new RegExp(`${name} = (\\d+)n`).exec(await readFile(new URL(file, import.meta.url), 'utf8'))?.[1] ?? '0');
  const keeper = await bound('../../packages/keeper/src/chain.ts', 'MAX_INBOX_COINS');
  const indexer = await bound('../../packages/chain/src/core/v2/royalty-v21.ts', 'INBOX_COIN_READ_LIMIT');
  assert.equal(MAX_SALE_LIST, 28n);
  assert.ok(MAX_SALE_LIST <= keeper && MAX_SALE_LIST + 4n <= indexer, `${MAX_SALE_LIST} against ${keeper} and ${indexer}`);
});
