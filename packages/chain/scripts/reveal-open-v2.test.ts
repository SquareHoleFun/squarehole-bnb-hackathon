import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { shLimit } from '../../../vitest.timeouts.mjs';
import { decodeFunctionData, encodeAbiParameters, keccak256, toHex, zeroHash, type Hex, type PublicClient } from 'viem';
import { decodeBoxSpecV2, encodeBoxSpecV2 } from '../../box-spec/src/generated/box-spec.v2';
import { buildBoxTree, verifyBoxProof } from '../../artwork/src/box-commitment';
import { canonicalJson } from '../../artwork/src/manifest';
import { boxCollectionAbi } from '../src/abi/boxCollection';
import { ROLE_V2 } from '../src/core/roles';
import { prepareOpenReveals, readOpenBoxSpec, writeOpenReveals } from './reveal-open-v2';

const from = '0x0000000000000000000000000000000000000100';
// Paths are the repository's, wherever the test runs from (the chain project, or the repository root).
const root = fileURLToPath(new URL('../../../', import.meta.url));
const collection = '0x0000000000000000000000000000000000000300';
const code = '0x6000';
const blockHash = toHex(9n, { size: 32 });
let download: ReturnType<typeof JSON.parse>;
beforeAll(() => {
  mkdirSync(join(root, '.cache/tmp'), { recursive: true });
  // Use the kit builder and app's exact Download BoxSpec format, with real public unique bag-holders art and its models
  // through Create's own reader (SH-CREATE-ITEM-MODELS). The pictures' and models' bytes are left out: only the spec and
  // the six-field list are read here.
  download = JSON.parse(execFileSync(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', `
    import { buildKit, settingsText } from './scripts/kits/settings.mjs';
    const kit = await buildKit('bag-holders');
    const file = JSON.parse(settingsText(kit));
    const listed = new Set(file.revealList.items.map(item => item.modelSha256));
    if (!Array.isArray(file.models) || file.models.length === 0 || file.models.length !== listed.size) throw new Error('bag-holders models missing from its file');
    file.pictures = [];
    delete file.models;
    process.stdout.write(JSON.stringify(file));
  `], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }));
// Cold art generation and waiting for another process's kit lock share T07's setup budget.
}, shLimit(600_000));

function client(overrides: Record<string, unknown> = {}, revealed = new Set<bigint>(), file = download, blockNumber = 123n) {
  const reads: { functionName: string; blockNumber: bigint }[] = [];
  const api = {
    getChainId: async () => 11155111,
    getBlock: async () => ({ number: blockNumber, hash: blockHash }),
    getCode: async () => code,
    readContract: async (request: { functionName: string; args?: bigint[]; blockNumber: bigint }) => {
      reads.push(request);
      if (request.functionName in overrides) return overrides[request.functionName];
      const spec = file.spec;
      const contracts = Array.from({ length: 24 }, (_, i) => toHex(BigInt(i + 1), { size: 20 }));
      contracts[ROLE_V2.collection] = collection;
      const values: Record<string, unknown> = {
        recordOf: { boxId: 7n, specHash: file.specHash, q: toHex(0n, { size: 20 }), contracts, codeHashes: contracts.map(() => keccak256(code)) },
        revealRoot: spec.revealRoot, collectionSize: BigInt(spec.n), firstId: 1n, revealTriggers: 4,
        revealState: [false, false, revealed.has(request.args?.[0] ?? 0n), !revealed.has(request.args?.[0] ?? 0n)],
      };
      if (!(request.functionName in values)) throw new Error('unexpected read');
      return values[request.functionName];
    },
  };
  return { api: api as unknown as PublicClient, reads };
}
const plan = (api: PublicClient, file = download) => prepareOpenReveals(file, { client: api, from, boxId: 7n });

const sets = [
  { kit: 'rent-free', count: 500, models: true },
  { kit: 'bag-holders', count: 420, models: true },
  { kit: 'link-marines-v2', count: 420, models: false },
  { kit: 'exit-liquidity', count: 404, models: false },
] as const;
type FixtureItem = { id: string; traitsPacked: string; imageSha256: Hex; avatarSha256: Hex; modelSha256: Hex; salt: Hex };
const sha256 = (text: string): Hex => `0x${createHash('sha256').update(text).digest('hex')}`;
// Encode independently of boxLeaf, so every word of the six-field commitment is checked.
const leaf = (item: FixtureItem) => keccak256(encodeAbiParameters([
  { type: 'uint256' }, { type: 'uint128' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' },
], [BigInt(item.id), BigInt(item.traitsPacked), item.imageSha256, item.avatarSha256, item.modelSha256, item.salt]));
function recommit(file: typeof download, root = true) {
  const spec = { ...decodeBoxSpecV2(file.encoded) };
  spec.n = file.revealList.items.length;
  file.revealList.n = String(spec.n);
  if (root) spec.revealRoot = buildBoxTree(file.revealList.items.map(leaf), spec.n).root;
  spec.revealListId = sha256(canonicalJson(file.revealList));
  file.encoded = encodeBoxSpecV2(spec);
  file.specHash = keccak256(file.encoded);
  file.spec = JSON.parse(JSON.stringify(spec, (_k, v: unknown) => typeof v === 'bigint' ? v.toString() : v));
  return file;
}
function uniqueFixture(set: typeof sets[number], saltLabel = 'created-box') {
  const file = structuredClone(download);
  // Synthetic hashes only: these are not the final art, GLBs, salts or downloads of any created box.
  file.revealList.items = Array.from({ length: set.count }, (_, i): FixtureItem => ({
    id: String(i + 1), traitsPacked: ((1n << 80n) + BigInt(i)).toString(),
    imageSha256: sha256(`${set.kit}:picture:${i}`), avatarSha256: zeroHash,
    modelSha256: set.models ? sha256(`${set.kit}:model:${i}`) : zeroHash,
    salt: sha256(`${set.kit}:${saltLabel}:${i}`),
  }));
  return recommit(file);
}

describe('SH-KITS-UNIQUE-T05 final-download preparation', () => {
  it.each(sets)('prepares every six-field $kit reveal and the exact canonical list', async set => {
    const file = uniqueFixture(set);
    const { api, reads } = client({}, new Set(), file);
    const result = await prepareOpenReveals(file, { client: api, from, boxId: 7n, kit: set.kit });
    expect(result.kit).toBe(set.kit);
    expect(result.calls).toHaveLength(set.count);
    expect(result.skipped).toEqual([]);
    expect(result.revealListBytes).toBe(canonicalJson(file.revealList));
    expect(sha256(result.revealListBytes)).toBe(file.spec.revealListId);
    for (const [i, call] of result.calls.entries()) {
      const item = file.revealList.items[i] as FixtureItem;
      expect(call.value).toBe('0');
      expect(call.to.toLowerCase()).toBe(collection);
      const decoded = decodeFunctionData({ abi: boxCollectionAbi, data: call.data });
      expect(decoded.functionName).toBe('reveal');
      if (decoded.functionName !== 'reveal') throw new Error('expected reveal');
      expect(decoded.args.slice(0, 6)).toEqual([
        BigInt(item.id), BigInt(item.traitsPacked), item.imageSha256, item.avatarSha256, item.modelSha256, item.salt,
      ]);
      expect(verifyBoxProof(i + 1, leaf(item), decoded.args[6], file.spec.revealRoot, set.count)).toBe(true);
    }
    expect(reads.every(r => r.blockNumber === 123n)).toBe(true);
  });

  it.each(sets)('refuses $kit model policy, duplicate pictures and wrong count even with valid commitments', async set => {
    const file = uniqueFixture(set);
    for (const [mutate, reason] of [
      [(f: typeof download) => { f.revealList.items[0].modelSha256 = set.models ? zeroHash : sha256('unexpected-model'); }, /model hashes/],
      [(f: typeof download) => { f.revealList.items[1].imageSha256 = `0x${f.revealList.items[0].imageSha256.slice(2).toUpperCase()}`; }, /distinct image/],
      [(f: typeof download) => { f.revealList.items.pop(); }, /item count/],
    ] as const) {
      const changed = structuredClone(file); mutate(changed); recommit(changed);
      const { api, reads } = client({}, new Set(), changed);
      await expect(prepareOpenReveals(changed, { client: api, from, boxId: 7n, kit: set.kit })).rejects.toThrow(reason);
      expect(reads).toEqual([]);
    }
    for (const kit of ['unknown-kit', 'toString']) expect(() => readOpenBoxSpec(file, kit)).toThrow(/unknown open kit/);
  });

  it('rejects changed model, traits, image, avatar and salt at the list digest and six-field root', () => {
    const file = uniqueFixture(sets[0]);
    for (const field of ['modelSha256', 'traitsPacked', 'imageSha256', 'avatarSha256', 'salt']) {
      const changed = structuredClone(file);
      changed.revealList.items[0][field] = field === 'traitsPacked' ? '1' : sha256(`wrong:${field}`);
      expect(() => readOpenBoxSpec(changed)).toThrow(/list hash mismatch/);
      recommit(changed, false); // A matching list digest cannot excuse a different six-field root.
      expect(() => readOpenBoxSpec(changed)).toThrow(/list root mismatch/);
    }
  });

  it('binds fresh salts to the created box, refusing a self-consistent portable template or altered model', async () => {
    const final = uniqueFixture(sets[1]);
    const template = uniqueFixture(sets[1], 'portable-template');
    expect(template.spec.revealRoot).not.toBe(final.spec.revealRoot);
    expect(template.spec.revealListId).not.toBe(final.spec.revealListId);
    await expect(plan(client({}, new Set(), final).api, template)).rejects.toThrow(/does not belong/);
    const changed = structuredClone(final);
    changed.revealList.items[0].modelSha256 = sha256('wrong-but-nonzero-model');
    recommit(changed);
    await expect(plan(client({}, new Set(), final).api, changed)).rejects.toThrow(/does not belong/);
  });

  it.each([sets[1], sets[3]])('keeps all chain/provenance refusals for $kit', async set => {
    const file = uniqueFixture(set);
    const prepare = (api: PublicClient) => prepareOpenReveals(file, { client: api, from, boxId: 7n, kit: set.kit });
    for (const [overrides, reason] of [
      [{ recordOf: { boxId: 8n, specHash: file.specHash } }, /wrong registry record/],
      [{ recordOf: { boxId: 7n, specHash: zeroHash } }, /does not belong/],
      [{ revealRoot: zeroHash }, /on-chain revealRoot/],
      [{ collectionSize: 1n }, /on-chain size/],
      [{ firstId: 0n }, /on-chain firstId/],
      [{ revealTriggers: 1 }, /reveal always/],
      [{ revealState: [false, false, false, false] }, /not revealable/],
      [{ revealState: [false, false, false] }, /invalid reveal state/],
    ] as const) await expect(prepare(client(overrides, new Set(), file).api)).rejects.toThrow(reason);
    const wrongChain = client({}, new Set(), file).api;
    wrongChain.getChainId = async () => 1;
    await expect(prepare(wrongChain)).rejects.toThrow(/Sepolia only/);
    for (const bytes of ['0x', '0x6001'] as const) {
      const wrongCode = client({}, new Set(), file).api;
      wrongCode.getCode = async () => bytes;
      await expect(prepare(wrongCode)).rejects.toThrow(/collection code/);
    }
    const noFinality = client({}, new Set(), file).api;
    noFinality.getBlock = (async () => ({ number: null, hash: null })) as typeof noFinality.getBlock;
    await expect(prepare(noFinality)).rejects.toThrow(/finalized block required/);
    const reorg = client({}, new Set(), file).api;
    let reads = 0;
    reorg.getBlock = (async () => ({ number: 123n, hash: ++reads === 1 ? blockHash : zeroHash })) as typeof reorg.getBlock;
    await expect(prepare(reorg)).rejects.toThrow(/finalized block changed/);
  });

  it.each([sets[1], sets[3]])('resumes $kit from fresh finalized reads including gaps and completion', async set => {
    const file = uniqueFixture(set);
    const first = await plan(client({}, new Set(), file).api, file);
    const revealed = new Set([1n, 20n, BigInt(set.count)]);
    const resumedClient = client({}, revealed, file, 124n);
    const resumed = await plan(resumedClient.api, file);
    expect(resumed.blockNumber).toBe('124');
    expect(resumedClient.reads.every(r => r.blockNumber === 124n)).toBe(true);
    expect(resumed.calls).toEqual(first.calls.filter(call => !revealed.has(BigInt(call.id))));
    expect(resumed.skipped).toEqual(['1', '20', String(set.count)]);
    expect(resumed.revealListBytes).toBe(first.revealListBytes);
    const done = await plan(client({}, new Set(file.revealList.items.map((item: FixtureItem) => BigInt(item.id))), file, 125n).api, file);
    expect(done.calls).toEqual([]);
    expect(done.skipped).toHaveLength(set.count);
    expect(done.revealListBytes).toBe(first.revealListBytes);
  });

  it('writes the full model-carrying canonical list and pin digest on a partial resume', async () => {
    const file = uniqueFixture(sets[1]);
    const result = await prepareOpenReveals(file, { client: client({}, new Set([1n]), file).api, from, boxId: 7n, kit: 'bag-holders' });
    const directory = join(root, `.cache/tmp/unique-t05-output-${process.pid}-${Date.now()}`);
    writeOpenReveals(result, directory);
    const bytes = readFileSync(join(directory, 'reveal-list.json'), 'utf8');
    expect(bytes).toBe(canonicalJson(file.revealList));
    expect(sha256(bytes)).toBe(result.revealListId);
    expect(JSON.parse(readFileSync(join(directory, 'pin.json'), 'utf8'))).toEqual({ files: [{ path: 'reveal-list.json', role: 'file', sha256: result.revealListId }] });
    const report = JSON.parse(readFileSync(join(directory, 'calls.json'), 'utf8'));
    expect(report.kit).toBe('bag-holders');
    expect(report.calls).toHaveLength(419);
    expect(report.skipped).toEqual(['1']);
  });
});

describe('SH-EX-L4 open reveal preparation', () => {
  it('prepares all 420 actual bag-holders proofs, canonical pin bytes and a Solidity replay vector', async () => {
    const { api, reads } = client();
    const result = await plan(api);
    expect(new Set(download.revealList.items.map((item: { imageSha256: string }) => item.imageSha256)).size).toBe(420);
    expect(download.revealList.items.every((item: { modelSha256: string }) => item.modelSha256 !== zeroHash)).toBe(true);
    expect(result.calls).toHaveLength(420);
    expect(result.skipped).toEqual([]);
    expect(createHash('sha256').update(result.revealListBytes).digest('hex')).toBe(download.spec.revealListId.slice(2));
    for (const [i, call] of result.calls.entries()) {
      expect(call.id).toBe(String(i + 1));
      expect(call.to.toLowerCase()).toBe(collection);
      expect(call.value).toBe('0');
      const decoded = decodeFunctionData({ abi: boxCollectionAbi, data: call.data });
      expect(decoded.functionName).toBe('reveal');
      expect(decoded.args?.[0]).toBe(BigInt(i + 1));
      expect(decoded.args?.[4]).toBe(download.revealList.items[i].modelSha256);
    }
    expect(reads.every(r => r.blockNumber === 123n)).toBe(true);
    mkdirSync(join(root, '.cache/tmp'), { recursive: true });
    writeFileSync(join(root, '.cache/tmp/ex-l4-bag-holders.json'), JSON.stringify({
      encoded: download.encoded, root: download.spec.revealRoot, listId: download.spec.revealListId,
      calls: result.calls.map(call => call.data), images: download.revealList.items.map((item: { imageSha256: string }) => item.imageSha256),
    }));
  });

  it('resumes only from chain state; a resumed run still writes the complete list', async () => {
    const { api } = client({}, new Set(Array.from({ length: 137 }, (_, i) => BigInt(i + 1))));
    const result = await plan(api);
    expect(result.calls).toHaveLength(283);
    expect(result.calls[0]?.id).toBe('138');
    expect(result.skipped).toHaveLength(137);
    expect(JSON.parse(result.revealListBytes).items).toHaveLength(420);
    const gaps = await plan(client({}, new Set([1n, 256n, 420n])).api);
    expect(gaps.skipped).toEqual(['1', '256', '420']);
    expect(gaps.calls).toHaveLength(417);
    expect(gaps.calls[0]?.id).toBe('2');
    expect(gaps.calls.at(-1)?.id).toBe('419');
    const done = await plan(client({}, new Set(Array.from({ length: 420 }, (_, i) => BigInt(i + 1)))).api);
    expect(done.calls).toEqual([]);
  });

  it('accepts address casing in valid downloads and rejects a consistently encoded hidden spec', () => {
    const make = (artMode: number) => {
      const spec = { ...decodeBoxSpecV2(download.encoded), artMode, marketplaceOwner: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as const };
      const encoded = encodeBoxSpecV2(spec);
      return { ...download, encoded, specHash: keccak256(encoded), spec: JSON.parse(JSON.stringify(spec, (_k, v: unknown) => typeof v === 'bigint' ? v.toString() : v)) };
    };
    expect(readOpenBoxSpec(make(1)).spec.n).toBe(420);
    expect(() => readOpenBoxSpec(make(2))).toThrow(/only open art/);
  });

  it('refuses hidden downloads, corrupt bytes, changed salts, duplicate ids and unsafe integer traits', () => {
    for (const mutate of [
      (f: typeof download) => { f.spec.artMode = 2; },
      (f: typeof download) => { f.encoded += '00'; },
      (f: typeof download) => { f.revealList.items[0].salt = zeroHash; },
      (f: typeof download) => { f.revealList.items[1].id = '1'; },
      (f: typeof download) => { f.revealList.items[0].traitsPacked = 1; },
      (f: typeof download) => { f.demo = true; },
    ]) {
      const file = structuredClone(download); mutate(file);
      expect(() => readOpenBoxSpec(file)).toThrow();
    }
  });

  it('rejects wrong root, size, first id, triggers, provenance, chain, code and unavailable items', async () => {
    for (const overrides of [{ revealRoot: zeroHash }, { collectionSize: 419n }, { firstId: 0n }, { revealTriggers: 1 },
      { recordOf: { specHash: zeroHash } }, { revealState: [false, false, false, false] }]) {
      await expect(plan(client(overrides).api)).rejects.toThrow();
    }
    const wrongChain = client().api; wrongChain.getChainId = async () => 1;
    await expect(plan(wrongChain)).rejects.toThrow();
    const changedCode = client().api; changedCode.getCode = async () => '0x6001';
    await expect(plan(changedCode)).rejects.toThrow();
    const reorg = client().api; let n = 0;
    reorg.getBlock = (async () => ({ number: 123n, hash: ++n === 1 ? blockHash : zeroHash })) as typeof reorg.getBlock;
    await expect(plan(reorg)).rejects.toThrow();
  });

  it('writes pin-raw compatible relative paths and refuses an existing output directory', async () => {
    const result = await plan(client().api);
    const dir = join(root, `.cache/tmp/ex-l4-output-${process.pid}-${Date.now()}`);
    writeOpenReveals(result, dir);
    const pin = JSON.parse(readFileSync(`${dir}/pin.json`, 'utf8'));
    expect(pin).toEqual({ files: [{ path: 'reveal-list.json', role: 'file', sha256: download.spec.revealListId }] });
    expect(readFileSync(`${dir}/reveal-list.json`, 'utf8')).toBe(result.revealListBytes);
    expect(JSON.parse(readFileSync(`${dir}/calls.json`, 'utf8')).calls).toHaveLength(420);
    const pinned = JSON.parse(execFileSync(process.execPath, ['scripts/ipfs/pin-raw.mjs', '--manifest', `${dir}/pin.json`, '--dry-run'], { cwd: root, encoding: 'utf8' }));
    expect(pinned.status).toBe('computed');
    expect(pinned.sha256).toBe(download.spec.revealListId);
    expect(() => writeOpenReveals(result, dir)).toThrow();
  });
});
