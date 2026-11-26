import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, resolvedSolcFixture, artifactCompilerInput, address, word, runtime, contract, source, librarySource, keccak256, toHex, fakeExplorer, explorerRow } from './verify-sources-fixtures.mjs';
import { makePlan, inventory, runExplorer } from '../lib/verify-sources.mjs';
import { runCli } from '../verify-sources.mjs';
import { loadBoxSpecLibrary } from '../../../packages/box-spec/scripts/lib/load-generated.mjs';

test('plan binds source, compiler settings, constructor bytes, links and immutables without a key', async () => {
  const f = await fixture();
  const plan = await makePlan(f.manifest, { baseDir: f.dir });
  const c = plan.contracts.find((c) => c.contract === contract);
  assert.equal(c.runtime, runtime);
  assert.equal(c.compilerVersion, 'v0.8.26+commit.8a97fa7a');
  assert.equal(c.settings.evmVersion, 'amsterdam');
  assert.equal(c.settings.viaIR, true);
  assert.equal(c.settings.optimizer.runs, 1000);
  assert.equal(c.constructorArguments, word(900719925474099312345n));
  assert.equal(c.libraries[librarySource].Library, address(2));
  assert.equal(c.request.fields.codeformat, 'solidity-standard-json-input');
  assert.equal(c.request.fields.constructorArguements, c.constructorArguments.slice(2));
  assert.equal(c.request.fields.contractname, contract);
  assert.equal(c.request.url, 'https://api.etherscan.io/v2/api');
  assert.equal(JSON.stringify(c.request).includes('apikey'), false);
  assert.equal(plan.contracts[0].address, address(2), 'linked library precedes consumer');
});

test('refuses runtime hash mismatch, missing immutable, link mismatch and invalid constructor data', async () => {
  for (const mutate of [
    (f) => { f.manifest.contracts[0].codeHash = word(3); },
    (f) => { f.manifest.contracts[0].immutables = {}; },
    (f) => { f.manifest.contracts[0].libraries[librarySource].Library = address(3); },
    (f) => { f.manifest.contracts[0].constructorArguments = '0x01'; },
    (f) => { f.manifest.contracts[0].creationInput = '0xdead'; },
    (f) => { f.build.input.settings.libraries = { [librarySource]: { Library: address(3) } }; },
  ]) {
    const f = await fixture(); mutate(f); await f.save();
    await assert.rejects(makePlan(f.manifest, { baseDir: f.dir }), /runtime|immutable|librar|constructor|creation/i);
  }
});

test('mainnet requires explicit opt-in, including offline plan and explorer library calls', async () => {
  const f = await fixture(); f.manifest.chainId = '1';
  await assert.rejects(makePlan(f.manifest, { baseDir: f.dir }), /allow-mainnet/);
  const plan = await makePlan(f.manifest, { baseDir: f.dir, allowMainnet: true });
  await assert.rejects(runExplorer(plan, { mode: 'status', key: 'obviously-fake-test-key' }), /allow-mainnet/);
  assert.equal(plan.chainId, '1');
});

test('clone runtime is reconstructed exactly and receives a proxy/similar-match note, no own submission', async () => {
  const f = await fixture();
  for (const kind of ['standard', 'receiving']) {
    const cloneRuntime = `0x${kind === 'receiving' ? '36600557005b' : ''}363d3d373d3d3d363d73${address(1).slice(2)}5af43d82803e903d9160${kind === 'receiving' ? '31' : '2b'}57fd5bf3abcd`;
    f.manifest.contracts.push({ address: address(kind === 'standard' ? 3 : 4), codeHash: keccak256(cloneRuntime),
      clone: { kind, implementation: address(1), arguments: '0xabcd' } });
  }
  const plan = await makePlan(f.manifest, { baseDir: f.dir });
  for (const c of plan.contracts.filter((c) => c.kind === 'clone')) {
    assert.match(c.note, /proxy.*similar match/i);
    assert.equal(c.request, undefined);
    assert.equal(c.contract, contract);
  }
  f.manifest.contracts.at(-1).codeHash = word(0);
  await assert.rejects(makePlan(f.manifest, { baseDir: f.dir }), /runtime/);
});

test('a v1 placeholder is refused; the committed Sepolia v1 manifest (deployed) and the local v2 release inventory preserve every implementation and dependency', async () => {
  const placeholder = { schema: 'squarehole.core-deployment/v1', status: 'awaiting-broadcast', chainId: 11155111, network: 'sepolia' };
  assert.throws(() => inventory(placeholder), /awaiting-broadcast/);
  const v1 = JSON.parse(await readFile('packages/contracts/deployments/core-v1/11155111.json', 'utf8'));
  const deployed = inventory(v1);
  const v1Addresses = [...Object.values(v1.chain), v1.versions[0].factory, v1.versions[0].registry, ...Object.values(v1.versions[0].implementations)].map((e) => e.address.toLowerCase());
  for (const at of v1Addresses) assert.ok(deployed.contracts.some((c) => c.address === at), at);
  // Box 0's source is the BoxBackedSource (F143): the DrandSource it names is verified beside it.
  assert.ok(deployed.contracts.some((c) => c.address === '0xbeece13fbdd67d0a696cb7cfd28103ed37ba79a6'));
  const v2 = JSON.parse(await readFile('packages/contracts/script/sepolia-v2/release-manifest.local.json', 'utf8'));
  const got = inventory(v2);
  for (const at of [...v2.implementations, v2.factory, v2.planner, v2.checks, v2.registry, v2.listingRegistry]) {
    assert.ok(got.contracts.some((c) => c.address === at.toLowerCase()));
  }
  assert.ok(got.notes.some((n) => /supplement/i.test(n)));
  await assert.rejects(makePlan(v2), /supplement|build|binding/i);
});

test('v2.1 array inventory covers all 42 parts (RC6: the shared CoW handler) and seven new fee libraries with authoritative hashes', async () => {
  const sol = await readFile('packages/contracts/script/sepolia-v2/CoreV2ReleaseInventory.sol', 'utf8');
  const names = [...sol.matchAll(/"([A-Z][A-Za-z0-9]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(names).size, 42);
  assert.ok(names.includes('RoyaltyCowHandler'));
  const m = { format: 'squarehole.core-v2-release/2', chainId: '11155111', parts: names.map((_, i) => address(i + 1)),
    partNames: names, partCodeHashes: names.map((_, i) => word(i + 1)) };
  const got = inventory(m);
  assert.equal(got.contracts.filter((c) => c.kind !== 'external').length, 42);
  for (const name of ['ReceiverPendingV21', 'ReceiverRewardsV21', 'RewardAccountingV21', 'ReceiverBooksV21', 'FeeModuleProofV21', 'ReceiverModuleCallV21', 'ReceiverShopV21']) {
    assert.ok(got.contracts.some((c) => c.name === name));
  }
  assert.throws(() => inventory({ ...m, partCodeHashes: [] }), /inventory/);
  assert.throws(() => inventory({ ...m, parts: m.parts.map(() => address(1)) }), /duplicate|conflict/);
});

test('status checks live code and exact explorer input; already verified text is insufficient', async () => {
  const f = await fixture(); const plan = await makePlan(f.manifest, { baseDir: f.dir });
  const api = fakeExplorer(plan);
  const result = await runExplorer(plan, { mode: 'status', key: 'obviously-fake-test-key', fetch: api.fetch, sleep: async () => {} });
  assert.ok(result.contracts.every((c) => c.state === 'verified'));
  for (const override of [
    { eth_getCode: () => ({ result: '0xdead' }) },
    { getsourcecode: (c) => ({ status: '1', result: [{ ...explorerRow(c), CompilerVersion: 'v0.8.25+commit.fake' }] }) },
    { getsourcecode: (c) => ({ status: '1', result: [{ ...explorerRow(c), SimilarMatch: address(88) }] }) },
    { getsourcecode: (c) => ({ status: '1', result: [{ ...explorerRow(c), ConstructorArguments: 'dead' }] }) },
    { getsourcecode: (c) => ({ status: '1', result: [{ ...explorerRow(c), SourceCode: '{{"language":"Solidity","sources":{},"settings":{}}}}' }] }) },
  ]) {
    const bad = fakeExplorer(plan, override);
    const got = await runExplorer(plan, { mode: 'status', key: 'obviously-fake-test-key', fetch: bad.fetch, sleep: async () => {} });
    assert.equal(got.ok, false);
    assert.ok(got.contracts.every((c) => c.state !== 'verified'));
  }
});

test('submit rate limits, retries 429/API throttles, polls GUID, then independently checks sources', async () => {
  const f = await fixture(); const plan = await makePlan(f.manifest, { baseDir: f.dir });
  const api = fakeExplorer(plan); const waits = []; let n = 0;
  const fetch = async (...args) => {
    n++;
    if (n === 1) return { status: 429, ok: false, headers: new Headers({ 'Retry-After': '2' }) };
    if (n === 2) return { status: 200, ok: true, headers: new Headers(), json: async () => ({ status: '0', result: 'Max rate limit reached' }) };
    return api.fetch(...args);
  };
  const result = await runExplorer(plan, { mode: 'submit', key: 'obviously-fake-test-key', fetch, sleep: async (ms) => waits.push(ms) });
  assert.equal(result.ok, true);
  assert.ok(waits.includes(2000));
  assert.ok(waits.every((ms) => ms >= 350));
  assert.ok(api.calls.some(({ query }) => query.get('action') === 'checkverifystatus'));
  assert.ok(api.calls.every(({ url, query }) => !url.includes('obviously-fake-test-key') && query.get('apikey') === 'obviously-fake-test-key'));
  assert.equal(JSON.stringify(result).includes('obviously-fake-test-key'), false);
});

test('submit preflights the whole inventory before sending any source', async () => {
  const f = await fixture(); const plan = await makePlan(f.manifest, { baseDir: f.dir });
  const api = fakeExplorer(plan, { eth_getCode: (c) => ({ result: c.address === address(1) ? '0xdead' : c.runtime }) });
  const result = await runExplorer(plan, { mode: 'submit', key: 'obviously-fake-test-key', fetch: api.fetch, sleep: async () => {} });
  assert.equal(result.ok, false);
  assert.equal(api.calls.some(({ query }) => query.get('action') === 'verifysourcecode'), false);
});

test('CLI validates modes, never reads key for plan, and sanitizes network/API errors', async () => {
  const f = await fixture(); let out = ''; let err = '';
  const io = { stdout: (s) => { out += s; }, stderr: (s) => { err += s; } };
  const env = new Proxy({}, { get() { throw new Error('plan read environment'); } });
  assert.equal(await runCli(['--plan', '--manifest', join(f.dir, 'manifest.json')], { ...io, env }), 0);
  assert.equal(JSON.parse(out).contracts.length, 2);
  assert.equal(await runCli(['--plan', '--status'], io), 1);
  out = ''; err = '';
  const options = { ...io, env: { EXPLORER_TEST: 'obviously-fake-test-key' }, sleep: async () => {},
    fetch: async () => { throw new Error('obviously-fake-test-key'); } };
  assert.equal(await runCli(['--status', '--manifest', join(f.dir, 'manifest.json'), '--key-env', 'EXPLORER_TEST'], options), 1);
  assert.equal((out + err).includes('obviously-fake-test-key'), false);
  await writeFile(join(f.dir, 'bad.json'), '{bad');
  assert.equal(await runCli(['--plan', '--manifest', join(f.dir, 'bad.json')], io), 1);
});

test('Foundry artifact metadata reconstructs input and refuses changed local sources', async () => {
  const f = await fixture();
  const code = f.build.output.contracts[source].Example;
  await mkdir(join(f.dir, 'src'), { recursive: true });
  for (const [path, s] of Object.entries(f.build.input.sources)) await writeFile(join(f.dir, path), s.content);
  const artifact = { abi: code.abi, bytecode: code.evm.bytecode, deployedBytecode: code.evm.deployedBytecode,
    metadata: { compiler: { version: f.build.solcLongVersion }, language: 'Solidity',
      settings: { ...f.build.input.settings, evmVersion: 'cancun', viaIR: false, compilationTarget: { [source]: 'Example' } },
      sources: Object.fromEntries(Object.entries(f.build.input.sources).map(([path, s]) => [path, { keccak256: keccak256(toHex(s.content)) }])) } };
  await writeFile(join(f.dir, 'artifact.json'), JSON.stringify(artifact));
  delete f.manifest.contracts[0].buildInfo;
  f.manifest.contracts[0].artifact = 'artifact.json';
  const options = { baseDir: f.dir, buildDir: f.dir, sourceRoot: f.dir };
  const plan = await makePlan(f.manifest, options);
  assert.equal(plan.contracts[1].settings.evmVersion, 'cancun', 'execution hardfork does not override compiler metadata');
  assert.equal(plan.contracts[1].settings.viaIR, false);
  assert.equal(JSON.parse(plan.contracts[1].request.fields.sourceCode).settings.compilationTarget, undefined);
  await writeFile(join(f.dir, source), 'contract Changed {}');
  await assert.rejects(makePlan(f.manifest, options), /source differs/);
});

for (const metadataField of ['metadata', 'rawMetadata']) {
  test(`resolved solc 0.8.26 ${metadataField} preserves the bytecode-producing standard JSON`, async () => {
    const f = await resolvedSolcFixture(metadataField);
    const metadata = JSON.parse(f.build.output.contracts[source].Example.metadata);
    assert.deepEqual(metadata.settings.libraries, { [`${librarySource}:Library`]: address(2), [`${librarySource}:Second`]: address(3) });
    assert.deepEqual(f.build.output.contracts[source].Example.evm.deployedBytecode.linkReferences, {}, 'solc has already resolved the links');
    const full = await makePlan(f.fullManifest, f.options);
    const plan = await makePlan(f.manifest, f.options);
    assert.equal(plan.contracts.length, 3);
    for (const c of plan.contracts) {
      const original = full.contracts.find((entry) => entry.address === c.address);
      const expectedInput = artifactCompilerInput(f.build, c.contract);
      assert.deepEqual(JSON.parse(c.request.fields.sourceCode), expectedInput, 'same sources and bytecode-affecting compiler settings');
      assert.equal(c.runtime, original.runtime, 'entire deployed bytecode, including IPFS metadata');
      assert.equal(keccak256(c.runtime), c.codeHash);
      assert.deepEqual(c.libraries, f.build.input.settings.libraries, 'both libraries from the same source survive');
      assert.deepEqual(c.dependencies, [], 'resolved metadata links do not invent dependency cycles');
    }
    f.manifest.contracts[0].libraries = structuredClone(f.build.input.settings.libraries);
    assert.deepEqual(await makePlan(f.manifest, f.options), plan, 'matching supplemental bindings remain accepted');
  });
}

for (const mode of ['plan', 'submit', 'status']) {
  test(`CLI --${mode} accepts real resolved-library metadata with an offline explorer`, async () => {
    const f = await resolvedSolcFixture();
    const full = await makePlan(f.fullManifest, f.options);
    for (const c of full.contracts) c.request.fields.sourceCode = JSON.stringify(artifactCompilerInput(f.build, c.contract));
    const api = fakeExplorer(full);
    let out = ''; let err = '';
    const env = mode === 'plan' ? new Proxy({}, { get() { assert.fail('plan read a key'); } })
      : { EXPLORER_TEST: 'obviously-fake-test-key' };
    const code = await runCli([`--${mode}`, '--manifest', join(f.dir, 'manifest.json'), '--build-dir', f.dir,
      '--source-root', f.dir, '--key-env', 'EXPLORER_TEST'], {
      stdout: (s) => { out += s; }, stderr: (s) => { err += s; }, env, fetch: api.fetch, sleep: async () => {},
    });
    assert.equal(code, 0, err);
    assert.equal(err, '');
    const result = JSON.parse(out);
    assert.equal(result.contracts.length, 3);
    if (mode === 'plan') assert.equal(api.calls.length, 0);
    else {
      assert.equal(result.ok, true);
      assert.ok(result.contracts.every((c) => c.state === 'verified'));
      assert.equal(api.calls.filter(({ query }) => query.get('action') === 'verifysourcecode').length, mode === 'submit' ? 3 : 0);
    }
    assert.equal(out.includes('obviously-fake-test-key'), false);
  });
}

test('resolved metadata keeps address, source, supplemental-link and runtime validation', async () => {
  for (const [mutate, expected] of [
    [(f) => { f.manifest.contracts[0].libraries = { [librarySource]: { Library: address(9) } }; }, /library binding conflicts/],
    [(f) => { f.artifacts.Example.metadata.settings.libraries[`${librarySource}:Library`] = 'invalid'; }, /invalid contract address/],
    [(f) => { f.artifacts.Example.metadata.settings.libraries = { 'Library': address(2) }; }, /qualified source contract binding/],
    [(f) => { f.manifest.contracts[1].kind = 'external'; }, /matching source inventory binding/],
    [(f) => { f.manifest.contracts[0].contract = 'src/Wrong.sol:Example'; }, /artifact source binding mismatch/],
    [(f) => { f.manifest.contracts[0].codeHash = word(9); }, /runtime hash disagrees/],
    [async (f) => { await writeFile(join(f.dir, librarySource), 'library Changed {}'); }, /source differs/],
  ]) {
    const f = await resolvedSolcFixture();
    await mutate(f); await f.save();
    await assert.rejects(makePlan(f.manifest, f.options), expected);
  }
});

test('supplement can promote an external dependency to its actual source binding', async () => {
  const f = await fixture();
  const m = { format: 'squarehole.verify-sources/1', chainId: f.manifest.chainId,
    contracts: [{ address: address(1), codeHash: keccak256(runtime), name: 'box0-executor', kind: 'external' }, f.manifest.contracts[1]] };
  const plan = await makePlan(m, { supplement: { ...f.manifest, contracts: [f.manifest.contracts[0]] }, baseDir: f.dir });
  assert.equal(plan.contracts[1].contract, contract);
  const bad = structuredClone(f.manifest); bad.contracts[0].codeHash = word(0);
  await assert.rejects(makePlan(m, { supplement: bad, baseDir: f.dir }), /hash disagrees/);
});

test('native v1/site-v2 inventories include each named slot, supporting records and Safe dependencies', () => {
  const pin = (n) => ({ address: address(n), codeHash: word(n) });
  const names = ['coordinator', 'hook', 'hookExtension', 'launchRouter', 'receiver', 'receiverExtension', 'collection', 'vault', 'tickets', 'royaltyRouter', 'itemStream'];
  const v1 = { version: 1, factory: pin(1), registry: pin(2), implementations: Object.fromEntries(names.map((n, i) => [n, pin(i + 10)])) };
  const names2 = names.filter((n) => !['receiverExtension', 'itemStream'].includes(n)).concat(['token', 'itemLedger', 'pileVault', 'holderLedger', 'tokenLedger', 'shopVault', 'starterSetLoader']);
  const v2 = { version: 2, factory: pin(100), registry: pin(101), listingRegistry: pin(102),
    implementations: Object.fromEntries(names2.map((n, i) => [n, pin(i + 110)])),
    safes: { fit: { ...pin(130), singleton: address(131), singletonCodeHash: word(131), guard: address(132), guardCodeHash: word(132), handler: address(133), handlerCodeHash: word(133) } } };
  const m = { schema: 'squarehole.core-deployment/v1', status: 'deployed', chainId: 11155111,
    chain: { poolManager: pin(3), weth: pin(4), randomness: pin(5), platformSafe: pin(6) }, versions: [v1], releases: [v2] };
  const got = inventory(m);
  assert.equal(got.contracts.length, 40);
  assert.ok(got.contracts.some((c) => c.name === 'DrandSource' && c.kind === 'source'));
  const broken = structuredClone(m); delete broken.versions[0].implementations.hook;
  assert.throws(() => inventory(broken), /missing v1 implementation/);
  assert.throws(() => inventory({ ...m, chain: {} }), /missing chain/);
});

test('F143: a v1 manifest whose randomness is the pinned BoxBackedSource lists it so, and the pinned DrandSource it names', async () => {
  const spec = await loadBoxSpecLibrary();
  const pin = (n) => ({ address: address(n), codeHash: word(n) });
  const names = ['coordinator', 'hook', 'hookExtension', 'launchRouter', 'receiver', 'receiverExtension', 'collection', 'vault', 'tickets', 'royaltyRouter', 'itemStream'];
  const v1 = { version: 1, factory: pin(1), registry: pin(2), implementations: Object.fromEntries(names.map((n, i) => [n, pin(i + 10)])) };
  const randomness = { address: spec.RANDOMNESS_SOURCE, codeHash: spec.RANDOMNESS_SOURCE_CODE_HASH };
  const m = { schema: 'squarehole.core-deployment/v1', status: 'deployed', chainId: 11155111,
    chain: { poolManager: pin(3), weth: pin(4), randomness, platformSafe: pin(6) }, versions: [v1] };
  const got = inventory(m);
  const at = (a) => got.contracts.filter((c) => c.address === a.toLowerCase());
  assert.deepEqual(at(spec.RANDOMNESS_SOURCE).map((c) => [c.name, c.kind, c.codeHash]),
    [['BoxBackedSource', 'source', spec.RANDOMNESS_SOURCE_CODE_HASH]]);
  assert.deepEqual(at(spec.DRAND_SOURCE).map((c) => [c.name, c.kind, c.codeHash]),
    [['DrandSource', 'source', spec.DRAND_SOURCE_CODE_HASH]]);
  assert.equal(got.contracts.length, 4 + 2 + names.length + 1);
  // A manifest from before F143 (its randomness the DrandSource itself, or any other code) keeps one DrandSource row.
  const old = inventory({ ...m, chain: { ...m.chain, randomness: { address: spec.DRAND_SOURCE, codeHash: spec.DRAND_SOURCE_CODE_HASH } } });
  assert.deepEqual(old.contracts.filter((c) => /Source$/.test(c.name)).map((c) => [c.name, c.address]),
    [['DrandSource', spec.DRAND_SOURCE.toLowerCase()]]);
});

test('Solidity library self-address is patched only at its compiler protection prologue', async () => {
  const f = await fixture();
  f.build.output.contracts[librarySource].Library.evm.deployedBytecode.object = `73${'00'.repeat(20)}301400`;
  f.manifest.contracts[1].codeHash = keccak256(`0x73${address(2).slice(2)}301400`);
  await f.save();
  const plan = await makePlan(f.manifest, { baseDir: f.dir });
  assert.equal(plan.contracts[0].runtime, `0x73${address(2).slice(2)}301400`);
});

test('all 42 v2.1 release identities can produce plans and verify through an offline explorer', async () => {
  const f = await fixture();
  const sol = await readFile('packages/contracts/script/sepolia-v2/CoreV2ReleaseInventory.sol', 'utf8');
  const names = [...sol.matchAll(/"([A-Z][A-Za-z0-9]+)"/g)].map((m) => m[1]);
  const m = { format: 'squarehole.core-v2-release/2', chainId: '11155111',
    parts: names.map((_, i) => address(i + 100)), partNames: names, partCodeHashes: [] };
  const supplement = { format: 'squarehole.verify-sources/1', chainId: m.chainId, contracts: [] };
  for (const [i, name] of names.entries()) {
    const path = `src/${name}.sol`;
    const runtime = `0x60${i.toString(16).padStart(2, '0')}00`;
    f.build.input.sources[path] = { content: `// synthetic release test\ncontract ${name} {}` };
    f.build.output.contracts[path] = { [name]: { abi: [], evm: { bytecode: { object: '6000' }, deployedBytecode: { object: runtime } } } };
    m.partCodeHashes.push(keccak256(runtime));
    supplement.contracts.push({ address: m.parts[i], contract: `${path}:${name}`, buildInfo: 'build.json', constructorArguments: '0x' });
  }
  await f.save();
  const plan = await makePlan(m, { supplement, baseDir: f.dir });
  const api = fakeExplorer(plan);
  const result = await runExplorer(plan, { mode: 'status', key: 'obviously-fake-test-key', fetch: api.fetch, sleep: async () => {} });
  assert.equal(result.contracts.length, 42);
  assert.equal(result.ok, true);
});

test('source status refuses individual settings, source names, libraries, proxy flags and unstructured matches', async () => {
  const f = await fixture(); const plan = await makePlan(f.manifest, { baseDir: f.dir });
  for (const change of [
    (r) => { r.ContractName = 'WrongName'; }, (r) => { r.ContractFileName = 'src/Wrong.sol'; },
    (r) => { r.Proxy = '1'; }, (r) => { r.EVMVersion = 'cancun'; }, (r) => { r.Runs = '200'; },
    (r) => { r.SourceCode = 'contract Example {}'; },
    (r) => { const input = JSON.parse(r.SourceCode.slice(1, -1)); input.settings.viaIR = false; r.SourceCode = JSON.stringify(input); },
    (r) => { const input = JSON.parse(r.SourceCode.slice(1, -1)); input.settings.libraries = { [librarySource]: { Library: address(99) } }; r.SourceCode = JSON.stringify(input); },
  ]) {
    const api = fakeExplorer(plan, { getsourcecode: (c) => { const row = explorerRow(c); change(row); return { status: '1', result: [row] }; } });
    const result = await runExplorer(plan, { mode: 'status', key: 'obviously-fake-test-key', fetch: api.fetch, sleep: async () => {} });
    assert.equal(result.ok, false);
    assert.ok(result.contracts.every((c) => c.state !== 'verified'));
  }
});

test('already-verified, failed and pending submissions cannot fabricate verification success', async () => {
  const f = await fixture(); const plan = await makePlan(f.manifest, { baseDir: f.dir });
  for (const override of [
    { verifysourcecode: () => ({ status: '0', result: 'Already Verified' }), getsourcecode: () => ({ status: '1', result: [{ SourceCode: '' }] }) },
    { checkverifystatus: () => ({ status: '0', result: 'Pending in queue' }), getsourcecode: () => ({ status: '1', result: [{ SourceCode: '' }] }) },
    { verifysourcecode: () => ({ status: '0', result: 'obviously-fake-test-key rejected' }) },
  ]) {
    const api = fakeExplorer(plan, override);
    const result = await runExplorer(plan, { mode: 'submit', key: 'obviously-fake-test-key', fetch: api.fetch, sleep: async () => {} });
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes('obviously-fake-test-key'), false);
    assert.ok(api.calls.length < 15, 'polls are bounded');
  }
});

test('empty and missing key, unsupported chains and unknown modes never contact the explorer', async () => {
  const f = await fixture(); const plan = await makePlan(f.manifest, { baseDir: f.dir });
  const fetch = async () => assert.fail('network must not be touched');
  for (const args of [{ mode: 'status' }, { mode: 'status', key: '' }, { mode: 'other', key: 'obviously-fake-test-key' }]) {
    await assert.rejects(runExplorer(plan, { ...args, fetch }));
  }
  f.manifest.chainId = '999'; await assert.rejects(makePlan(f.manifest, { baseDir: f.dir }), /unsupported chain/);
  f.manifest.chainId = '31337'; const local = await makePlan(f.manifest, { baseDir: f.dir });
  await assert.rejects(runExplorer(local, { mode: 'status', key: 'obviously-fake-test-key', fetch }), /plan only/);
});

test('global compiler library settings do not invent cyclic dependencies between unused libraries', async () => {
  const f = await fixture();
  f.build.input.sources['src/Second.sol'] = { content: 'library Second {}' };
  f.build.output.contracts['src/Second.sol'] = { Second: { abi: [], evm: { bytecode: { object: '6003' }, deployedBytecode: { object: '600300' } } } };
  f.build.input.settings.libraries = { [librarySource]: { Library: address(2) }, 'src/Second.sol': { Second: address(3) } };
  f.manifest.contracts.push({ address: address(3), codeHash: keccak256('0x600300'), contract: 'src/Second.sol:Second', buildInfo: 'build.json' });
  await f.save();
  const plan = await makePlan(f.manifest, { baseDir: f.dir });
  assert.equal(plan.contracts.length, 3);
  assert.deepEqual(plan.contracts.find((c) => c.address === address(2)).dependencies, []);
  assert.deepEqual(plan.contracts.find((c) => c.address === address(1)).dependencies, [address(2)]);
});
