/** Translate only the listed model hashes and their derived commitments in an immutable ARM fixture.
 * This starts from the recorded fixture, never the builder result under test.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { reviewedManifestForPlatform } from '../../kits/bag-holders-normal-zero-platform-exception.mjs';
import { fixtureAbi, fixturePath, fixtureSource } from '../../kits/reveal-fixtures.mjs';
import { artwork, specV2 } from '../../kits/app.mjs';
import { rawCidV1 } from '../../ipfs/pin-raw-lib.mjs';
const { decodeAbiParameters, encodeAbiParameters, keccak256, zeroHash, decodeFunctionData, encodeFunctionData } =
  createRequire(new URL('../../../packages/chain/package.json', import.meta.url))('viem');
const { boxCollectionAbi } = await import('../../../packages/chain/src/abi/boxCollection.ts');

export function platformFixtureSource(id, source, arch = process.arch) {
  const reviewed = JSON.parse(readFileSync(`examples/boxes/${id}/unique/manifest.json`, 'utf8'));
  const platform = reviewedManifestForPlatform(id, reviewed, arch);
  if (platform === reviewed) return source;
  const [decoded] = decodeAbiParameters(fixtureAbi, `0x${source.match(/return hex"([0-9a-f]+)";/)[1]}`);
  const fixture = { ...decoded, kit: id };
  assert.equal(fixtureSource(fixture), source, 'recorded fixture round trip is exact');
  fixture.items = fixture.items.map((item, index) => {
    assert.equal(item.modelHash, `0x${reviewed.items[index].model.sha256}`, 'fixture starts with reviewed ARM model');
    const modelHash = `0x${platform.items[index].model.sha256}`;
    const token = JSON.parse(item.tokenJSON);
    assert.equal(token.animation_url, `ipfs://${rawCidV1(item.modelHash)}`);
    token.animation_url = `ipfs://${rawCidV1(modelHash)}`;
    return { ...item, modelHash, tokenJSON: JSON.stringify(token) };
  });
  // Independently encode the six words and construct the index-directed, zero-padded tree.
  let level = fixture.items.map(item => keccak256(encodeAbiParameters(
    ['uint256', 'uint128', 'bytes32', 'bytes32', 'bytes32', 'bytes32'].map(type => ({ type })),
    [item.id, item.traitsPacked, item.imageHash, item.avatarHash, item.modelHash, item.salt])));
  const size = 2 ** Math.ceil(Math.log2(level.length));
  level.push(...Array(size - level.length).fill(zeroHash));
  const levels = [level];
  while (level.length > 1) {
    level = Array.from({ length: level.length / 2 }, (_, i) => keccak256(`${level[2 * i]}${level[2 * i + 1].slice(2)}`));
    levels.push(level);
  }
  fixture.root = level[0];
  fixture.items.forEach((item, i) => { item.proof = levels.slice(0, -1).map((layer, depth) => layer[(i >> depth) ^ 1]); });
  const list = { format: 'squarehole.box-reveal-list/1', n: String(fixture.items.length), items: fixture.items.map(item => ({
    id: String(item.id), traitsPacked: String(item.traitsPacked), imageSha256: item.imageHash,
    avatarSha256: item.avatarHash, modelSha256: item.modelHash, salt: item.salt,
  })) };
  const spec = specV2.decodeBoxSpecV2(fixture.encodedSpec);
  spec.revealRoot = fixture.root;
  spec.revealListId = artwork.sha256Hex(Buffer.from(artwork.canonicalJson(list)));
  fixture.encodedSpec = specV2.encodeBoxSpecV2(spec);
  fixture.specHash = keccak256(fixture.encodedSpec);
  fixture.calls = fixture.calls.map(data => {
    const call = decodeFunctionData({ abi: boxCollectionAbi, data });
    const item = fixture.items.find(item => item.id === call.args[0]);
    const args = [...call.args]; args[4] = item.modelHash; args[6] = item.proof;
    return encodeFunctionData({ abi: boxCollectionAbi, functionName: call.functionName, args });
  });
  return fixtureSource(fixture);
}


/** Keep a caller's ARM spec pin intact; derive the platform pin from the reviewed fixture, never a fresh build. */
export function platformFixtureSpecHash(id, reviewedHash, arch = process.arch) {
  const source = readFileSync(fixturePath(id), 'utf8');
  const decode = text => decodeAbiParameters(fixtureAbi, `0x${text.match(/return hex"([0-9a-f]+)";/)[1]}`)[0];
  assert.equal(decode(source).specHash, reviewedHash, 'recorded spec hash must still match the reviewed fixture');
  return decode(platformFixtureSource(id, source, arch)).specHash;
}
