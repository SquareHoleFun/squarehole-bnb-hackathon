import { readFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { shLimit } from '../../../../../vitest.timeouts.mjs';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, type Hex } from 'viem';
import { prepareOpenReveals, readOpenBoxSpec } from '../../../scripts/reveal-open-v2';
import { foldReveals, multicall3Abi } from '../../../scripts/reveal-open-v2-batch';
import { boxCollectionAbi } from '../../abi/boxCollection';
import {
  checkOpenRevealFileV2, parseOpenRevealFileV2, planOpenRevealBatchesV2,
  openRevealBatchSizeV2, OPEN_REVEAL_GAS_PER_ITEM, DEFAULT_OPEN_REVEAL_GAS_BUDGET,
  readOpenRevealResultsV2, readOpenRevealReceiptV2,
} from './open-reveal-batches-v2';
import { fixtureHash, openRevealFixture, recommitFixture, revealFixtureClient, revealFixtureCollection } from './test-support/open-reveal-fixture';
import legacy from './test-support/open-reveal-legacy.json';

const from = '0x0000000000000000000000000000000000000100';
const commitment = (file: ReturnType<typeof openRevealFixture>) => ({ root: file.spec.revealRoot as Hex });
const checked = (file = openRevealFixture()) => checkOpenRevealFileV2(file, commitment(file));
const batches = (file = openRevealFixture(), revealed = new Set<bigint>()) => [...planOpenRevealBatchesV2(checked(file), {
  collection: revealFixtureCollection, revealed,
})];
function row(file: ReturnType<typeof openRevealFixture>, index = 0) {
  const item = file.revealList.items[index];
  if (!item) throw new Error('missing fixture row');
  return item;
}
async function* chunks(text: string, size = 997) {
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

describe('SH-199 checked open reveal batches', () => {
  it('matches the pre-refactor bytes and runs both Node tools on the same 500-item fixture', async () => {
    const file = openRevealFixture();
    const before = JSON.stringify(file);
    const node = await prepareOpenReveals(file, { client: revealFixtureClient(file), from, boxId: 7n });
    const planned = batches(file);
    expect(file.specHash).toBe(legacy.specHash);
    expect(fixtureHash(JSON.stringify(node.calls))).toBe(legacy.callsSha256);
    expect(planned).toEqual(foldReveals(node.calls));
    expect(fixtureHash(JSON.stringify(planned))).toBe(legacy.batchesSha256);
    expect(planned.map(b => fixtureHash(b.data))).toEqual(legacy.calldataSha256);
    expect(planned.map(b => b.ids.length)).toEqual([...Array<number>(12).fill(40), 20]);
    for (const batch of planned) {
      const calls = decodeFunctionData({ abi: multicall3Abi, data: batch.data }).args[0];
      expect(calls.every(c => c.allowFailure && c.target.toLowerCase() === revealFixtureCollection)).toBe(true);
    }
    expect(JSON.stringify(file)).toBe(before);
  });

  it('refuses a valid saved file from a different on-chain root and optional commitment fields', () => {
    const file = openRevealFixture(10);
    expect(() => checkOpenRevealFileV2(file, { root: fixtureHash('other') })).toThrow(/on-chain revealRoot/);
    for (const extra of [{ size: 9n }, { firstId: 0n }, { specHash: fixtureHash('other') }]) {
      expect(() => checkOpenRevealFileV2(file, { ...commitment(file), ...extra })).toThrow();
    }
    expect(() => checkOpenRevealFileV2(file, { root: '0x' })).toThrow();
  });

  it.each(['traitsPacked', 'imageSha256', 'avatarSha256', 'modelSha256', 'salt'] as const)('authenticates %s at both the list hash and Merkle root', field => {
    const file = openRevealFixture(10);
    const item = file.revealList.items[0];
    if (!item) throw new Error('fixture');
    if (field === 'traitsPacked') item.traitsPacked = '1';
    else item[field] = fixtureHash('changed');
    expect(() => checked(file)).toThrow(/list hash mismatch/);
    recommitFixture(file, false);
    expect(() => checked(file)).toThrow(/list root mismatch/);
  });

  it('refuses missing, duplicate, reordered, malformed, overflowing and hidden data', () => {
    const cases: ((file: ReturnType<typeof openRevealFixture>) => void)[] = [
      f => { f.revealList.items.pop(); },
      f => { f.revealList.items.reverse(); recommitFixture(f, false); },
      f => { f.revealList.items[1] = { ...row(f) }; recommitFixture(f, false); },
      f => { row(f).traitsPacked = (1n << 128n).toString(); recommitFixture(f, false); },
      f => { row(f).imageSha256 = `0x${'00'.repeat(32)}`; recommitFixture(f, false); },
      f => { row(f).salt = '0x'; },
      f => { Reflect.deleteProperty(row(f), 'salt'); },
      f => { row(f).id = '01'; },
      f => { Reflect.set(row(f), 'traitsPacked', 123); },
      f => { Reflect.set(row(f), 'proof', []); },
      f => { f.spec.artMode = 2; recommitFixture(f); },
      f => { f.spec.firstId = '0'; recommitFixture(f); },
      f => { f.spec.n = 11; },
      f => { f.encoded = `${f.encoded}00`; },
      f => { f.specHash = fixtureHash('wrong'); },
      f => { f.demo = true; },
    ];
    for (const mutate of cases) { const file = openRevealFixture(10); mutate(file); expect(() => checked(file)).toThrow(); }
  });

  it('sizes batches with bigint gas budgets, never above 40 or below one', () => {
    expect(openRevealBatchSizeV2()).toBe(40);
    expect(DEFAULT_OPEN_REVEAL_GAS_BUDGET).toBe(OPEN_REVEAL_GAS_PER_ITEM * 40n);
    expect(openRevealBatchSizeV2(OPEN_REVEAL_GAS_PER_ITEM * 3n + 1n)).toBe(3);
    expect(openRevealBatchSizeV2(10n ** 30n)).toBe(40);
    for (const budget of [0n, -1n, OPEN_REVEAL_GAS_PER_ITEM - 1n]) expect(() => openRevealBatchSizeV2(budget)).toThrow(/gas budget/);
    expect([...planOpenRevealBatchesV2(checked(openRevealFixture(10)), {
      collection: revealFixtureCollection, gasBudget: OPEN_REVEAL_GAS_PER_ITEM * 3n,
    })].map(b => b.ids.length)).toEqual([3, 3, 3, 1]);
  });

  it('resumes gaps from caller-supplied chain state and returns no batches at completion', async () => {
    const file = openRevealFixture(90);
    const revealed = new Set([1n, 20n, 40n, 90n]);
    const node = await prepareOpenReveals(file, { client: revealFixtureClient(file, revealed), from, boxId: 7n });
    expect(batches(file, revealed)).toEqual(foldReveals(node.calls));
    expect(batches(file, new Set(file.revealList.items.map(i => BigInt(i.id))))).toEqual([]);
    expect(() => batches(file, new Set([0n]))).toThrow(/revealed id/);
    expect(() => [...planOpenRevealBatchesV2(checked(file), { collection: '0x0000000000000000000000000000000000000000' })]).toThrow(/collection/);
  });

  it('owns its checked data; later input mutations cannot change a plan', () => {
    const file = openRevealFixture(10);
    const safe = checked(file);
    const before = [...planOpenRevealBatchesV2(safe, { collection: revealFixtureCollection })];
    file.revealList.items.reverse();
    row(file).salt = fixtureHash('changed');
    expect([...planOpenRevealBatchesV2(safe, { collection: revealFixtureCollection })]).toEqual(before);
    expect(() => [...planOpenRevealBatchesV2({ ...safe }, { collection: revealFixtureCollection })]).toThrow(/checked/);
  });

  it('streams a saved copy and full file across every byte boundary, discarding assets', async () => {
    const file = openRevealFixture(10);
    const json = JSON.stringify({ pictures: [{ bytes: 'a'.repeat(100_000), text: 'é🦋\\"' }], ...file, models: ['unused'] });
    for (const source of [chunks(json, 1), new Blob([json])]) {
      const result = await parseOpenRevealFileV2(source, commitment(file));
      expect([...planOpenRevealBatchesV2(result, { collection: revealFixtureCollection })]).toEqual(batches(file));
    }
  });

  it('streams 10,000 items, retaining the CLI raw-IPFS limit only in the CLI', async () => {
    const file = openRevealFixture(10_000);
    expect(() => readOpenBoxSpec(file)).toThrow(/raw IPFS block limit/);
    const result = await parseOpenRevealFileV2(chunks(JSON.stringify(file)), commitment(file));
    let count = 0;
    let last: readonly string[] = [];
    for (const batch of planOpenRevealBatchesV2(result, { collection: revealFixtureCollection })) { count++; last = batch.ids; }
    expect(count).toBe(250);
    expect(last.at(-1)).toBe('10000');
  }, shLimit(60_000));

  it('fails closed on malformed/truncated JSON, duplicate keys, limits and invalid UTF-8', async () => {
    const file = openRevealFixture(10);
    const json = JSON.stringify(file);
    for (const text of [json.slice(0, -1), `${json}x`, `${json},`, json.replace('"demo":false', '"demo":false,"demo":false'),
      json.replace('"demo":false', '"demo":false,'), json.replace('"demo":false', '"demo":01'),
      json.replace('"demo":false', '"ignored":"\\x"'), json.replace('"demo":false', '"ignored":"\n"'),
      '{"pictures":[1,]}', '{"pictures":tru}', '[]', `${json} {}`]) {
      await expect(parseOpenRevealFileV2(chunks(text, 11), commitment(file))).rejects.toThrow();
    }
    await expect(parseOpenRevealFileV2(chunks(json), commitment(file), { maxFileBytes: 20 })).rejects.toThrow(/file.*limit/);
    await expect(parseOpenRevealFileV2(chunks(`{"ignored":${'['.repeat(80)}0${']'.repeat(80)}}`), commitment(file))).rejects.toThrow(/depth/);
    async function* invalid() { yield new Uint8Array([0xff]); }
    await expect(parseOpenRevealFileV2(invalid(), commitment(file))).rejects.toThrow();
    async function* text() { yield json as unknown as Uint8Array; }
    await expect(parseOpenRevealFileV2(text(), commitment(file))).rejects.toThrow(/^reveal source parts must be bytes$/);
  });

  it('maps mixed aggregate3 results exactly; an outer revert overrides all inner results', () => {
    const [batch] = batches(openRevealFixture(10));
    if (!batch) throw new Error('batch');
    const results = batch.ids.map((_id, i) => ({ success: i % 2 === 0, returnData: '0x' as Hex }));
    const encoded = encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: results });
    for (const input of [results, encoded]) expect(readOpenRevealResultsV2(batch, 'success', input)).toEqual({
      succeeded: ['1', '3', '5', '7', '9'], failed: ['2', '4', '6', '8', '10'], unknown: [],
    });
    expect(readOpenRevealResultsV2(batch, 'reverted', results)).toEqual({ succeeded: [], failed: batch.ids, unknown: [] });
    expect(readOpenRevealResultsV2(batch, 'success')).toEqual({ succeeded: [], failed: [], unknown: batch.ids });
    expect(() => readOpenRevealResultsV2(batch, 'success', results.slice(1))).toThrow(/result count/);
  });

  it('reads mined Revealed logs, not outer success alone or foreign/mismatched events', () => {
    const file = openRevealFixture(10);
    const [batch] = batches(file);
    if (!batch) throw new Error('batch');
    const log = (index: number): { address: Hex; topics: Hex[]; data: Hex } => {
      const item = row(file, index);
      return { address: revealFixtureCollection,
        topics: encodeEventTopics({ abi: boxCollectionAbi, eventName: 'Revealed', args: { id: BigInt(item.id) } }) as Hex[],
        data: encodeAbiParameters([{ type: 'uint128' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }],
          [BigInt(item.traitsPacked), item.imageSha256, item.avatarSha256, item.modelSha256]) };
    };
    const receipt: Parameters<typeof readOpenRevealReceiptV2>[1] = {
      status: 'success', logs: [log(0), log(4), { ...log(1), address: from }, { ...log(2), data: log(3).data }],
    };
    expect(readOpenRevealReceiptV2(batch, receipt)).toEqual({ succeeded: ['1', '5'], failed: ['2', '3', '4', '6', '7', '8', '9', '10'], unknown: [] });
    expect(readOpenRevealReceiptV2(batch, { ...receipt, status: 'reverted' })).toEqual({ succeeded: [], failed: batch.ids, unknown: [] });
  });

  it('statically walks runtime imports: no Node builtins or globals in the browser module graph', () => {
    const visited = new Set<string>();
    const builtins = new Set(builtinModules.flatMap(m => [m, `node:${m}`]));
    function walk(path: string) {
      if (visited.has(path)) return;
      visited.add(path);
      const source = readFileSync(path, 'utf8');
      const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node) {
        if (ts.isIdentifier(node) && ['Buffer', 'process', 'require', '__dirname', '__filename'].includes(node.text)) {
          throw new Error(`Node global ${node.text} in ${path}`);
        }
        if ((ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly || ts.isExportDeclaration(node) && !node.isTypeOnly)
          && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const name = node.moduleSpecifier.text;
          expect(builtins.has(name), `${path}: ${name}`).toBe(false);
          // Traverse workspace exports as well as relative imports; registry browser dependencies are allowlisted.
          if (name.startsWith('.')) {
            const base = resolve(dirname(path), name);
            const resolved = createRequire(path).resolve(name.endsWith('.ts') ? base : `${base}.ts`);
            walk(resolved);
          } else if (name.startsWith('@squarehole/')) walk(createRequire(path).resolve(name));
          else expect(['viem', 'zod', '@noble/hashes/sha2.js', '@noble/hashes/sha3.js', '@noble/hashes/utils.js']).toContain(name);
        }
        ts.forEachChild(node, visit);
      }
      visit(ast);
    }
    walk(fileURLToPath(new URL('./open-reveal-batches-v2.ts', import.meta.url)));
    expect(visited.size).toBeGreaterThan(5);
  });
});
