/** T07 TEST ONLY. Build reviewed kits offline; embed compact vectors, never image or model bytes.
 * node --experimental-transform-types scripts/kits/reveal-fixtures.mjs [--check]
 * Solidity data artifacts keep default Forge runs independent of FFI, new fs permissions and prior script execution.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildKit, settingsText } from './settings.mjs';
import { UNIQUE_KITS } from './unique.mjs';
import { rawCidV1 } from '../ipfs/pin-raw-lib.mjs';

// settings.mjs installs the repository's Node TypeScript hooks first.
const { prepareOpenReveals } = await import('../../packages/chain/scripts/reveal-open-v2.ts');
const { ROLE_V2 } = await import('../../packages/chain/src/core/roles.ts');
const { boxCollectionAbi } = await import('../../packages/chain/src/abi/boxCollection.ts');
const { encodeAbiParameters, decodeFunctionData, keccak256, toHex, zeroHash } = createRequire(new URL('../../packages/chain/package.json', import.meta.url))('viem');

const fields = entries => entries.map(([name, type]) => ({ name, type }));
export const fixtureAbi = [{ type: 'tuple', components: [
  ...fields([['encodedSpec', 'bytes'], ['root', 'bytes32'], ['specHash', 'bytes32'], ['modelItems', 'uint256']]),
  { name: 'items', type: 'tuple[]', components: fields([
    ['id', 'uint256'], ['traitsPacked', 'uint128'], ['imageHash', 'bytes32'], ['avatarHash', 'bytes32'],
    ['modelHash', 'bytes32'], ['salt', 'bytes32'], ['proof', 'bytes32[]'], ['tokenJSON', 'string'],
  ]) },
  ...fields([['sampleIds', 'uint256[]'], ['calls', 'bytes[]']]),
] }];
export const fixturePath = id => `packages/contracts/test/box-v2/unique-art/${id}.sol`;
export const fixtureName = id => `${id.split('-').map(part => part[0].toUpperCase() + part.slice(1)).join('')}RevealFixture`;

export async function buildRevealFixture(kit) {
  assert.ok(Object.hasOwn(UNIQUE_KITS, kit.id), 'unique kit required');
  const download = JSON.parse(settingsText(kit));
  const { spec, specHash, encoded: encodedSpec } = download;
  assert.equal(kit.proofs.root, spec.revealRoot);
  assert.equal(keccak256(encodedSpec), specHash);
  const items = kit.proofs.items.map((item, index) => ({
    id: item.id, traitsPacked: item.traitsPacked,
    imageHash: item.imageSha256, avatarHash: item.avatarSha256, modelHash: item.modelSha256,
    salt: item.salt, proof: item.proof,
    // Expected metadata uses the reviewed producer's trait strings and the independent raw-block CID writer.
    tokenJSON: JSON.stringify({
      name: `${spec.collectionName} #${item.id}`, description: spec.description,
      image: `ipfs://${rawCidV1(item.imageSha256)}`,
      ...(item.modelSha256 === zeroHash ? {} : { animation_url: `ipfs://${rawCidV1(item.modelSha256)}` }),
      attributes: kit.input.commitment.traitTypes.map(type => ({ trait_type: type.name, value: kit.items[index].traits[type.name] })),
    }),
  }));
  const sampleIds = ['1', '2', '20', '21', '256', (BigInt(items.length) - 1n).toString(), String(items.length)];
  const pack = JSON.parse(readFileSync(`packages/chain/scripts/sepolia-launch-packs/${kit.id}/open-reveals.json`, 'utf8'));
  assert.equal(pack.tool, 'packages/chain/scripts/reveal-open-v2.ts');
  assert.deepEqual(pack.prepareArgs, ['--kit', kit.id]);
  assert.equal(pack.art.itemCount, String(items.length));

  // A closed, in-memory finalized-read double. There is no transport or RPC URL.
  // Solidity replays the returned calldata against the actual production collection implementation.
  const from = toHex(0x100n, { size: 20 }), collection = toHex(0x300n, { size: 20 });
  const code = '0x6000', blockHash = toHex(9n, { size: 32 });
  const contracts = Array.from({ length: 24 }, (_, i) => toHex(BigInt(i + 1), { size: 20 }));
  contracts[ROLE_V2.collection] = collection;
  const client = {
    getChainId: async () => 11155111,
    getBlock: async () => ({ number: 123n, hash: blockHash }),
    getCode: async () => code,
    readContract: async ({ functionName, blockNumber }) => {
      assert.equal(blockNumber, 123n);
      const values = {
        recordOf: { boxId: 7n, specHash, q: toHex(0n, { size: 20 }), contracts, codeHashes: contracts.map(() => keccak256(code)) },
        revealRoot: spec.revealRoot, collectionSize: BigInt(spec.n), firstId: BigInt(spec.firstId), revealTriggers: 4,
        revealState: [false, false, false, true],
      };
      assert.ok(Object.hasOwn(values, functionName), 'unexpected chain read');
      return values[functionName];
    },
  };
  const plan = await prepareOpenReveals(download, { client, from, boxId: 7n, kit: pack.prepareArgs[1] });
  assert.equal(plan.specHash, specHash);
  assert.equal(plan.revealRoot, spec.revealRoot);
  assert.equal(plan.calls.length, items.length);
  assert.deepEqual(plan.skipped, []);
  // Check every prepared call, even though the Solidity tool-call sample is deliberately small.
  for (const [index, call] of plan.calls.entries()) {
    const item = items[index];
    assert.equal(call.id, item.id);
    assert.equal(call.to, collection);
    assert.equal(call.value, '0');
    const decoded = decodeFunctionData({ abi: boxCollectionAbi, data: call.data });
    assert.equal(decoded.functionName, 'reveal');
    assert.deepEqual(decoded.args, [BigInt(item.id), BigInt(item.traitsPacked), item.imageHash, item.avatarHash, item.modelHash, item.salt, item.proof]);
  }
  return { kit: kit.id, encodedSpec, root: spec.revealRoot, specHash,
    modelItems: String(items.filter(item => item.modelHash !== zeroHash).length), items, sampleIds,
    calls: plan.calls.filter(call => sampleIds.includes(call.id)).map(call => call.data) };
}

export function fixtureSource(fixture) {
  const encoded = encodeAbiParameters(fixtureAbi, [{ ...fixture, modelItems: BigInt(fixture.modelItems),
    items: fixture.items.map(item => ({ ...item, id: BigInt(item.id), traitsPacked: BigInt(item.traitsPacked) })),
    sampleIds: fixture.sampleIds.map(BigInt),
  }]);
  return `// SPDX-License-Identifier: MIT\npragma solidity 0.8.26;\n\n// GENERATED TEST DATA by scripts/kits/reveal-fixtures.mjs; regenerate, do not hand-edit.\n// ${fixture.kit}: ${fixture.items.length} items, ${fixture.modelItems} models. ABI: UniqueArtFixture.Data.\n// root: ${fixture.root}\n// specHash: ${fixture.specHash}\ncontract ${fixtureName(fixture.kit)} {\n    function data() external pure returns (bytes memory) {\n        return hex"${encoded.slice(2)}";\n    }\n}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--check'), 'usage: reveal-fixtures.mjs [--check]');
  for (const id of Object.keys(UNIQUE_KITS)) {
    const started = performance.now();
    const fixture = await buildRevealFixture(await buildKit(id));
    const source = fixtureSource(fixture), path = fixturePath(id);
    if (process.argv[2] === '--check') assert.equal(readFileSync(path, 'utf8'), source, `stale: ${path}`);
    else { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, source); }
    process.stdout.write(`${id}: ${fixture.items.length} items, ${fixture.modelItems} models; ${source.length} fixture bytes; ${((performance.now() - started) / 1000).toFixed(2)}s\n`);
  }
}
