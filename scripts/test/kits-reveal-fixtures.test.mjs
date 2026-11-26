import { platformFixtureSource } from './fixtures/reveal-platform-expectation.mjs';
import { reviewedManifestForPlatform } from '../kits/bag-holders-normal-zero-platform-exception.mjs';
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { buildKit, settingsText } from '../kits/settings.mjs';
import { UNIQUE_KITS } from '../kits/unique.mjs';
import { buildRevealFixture, fixtureSource, fixturePath, fixtureAbi } from '../kits/reveal-fixtures.mjs';

const { decodeAbiParameters, encodeAbiParameters, keccak256, zeroHash } = createRequire(new URL('../../packages/chain/package.json', import.meta.url))('viem');

// A cold build (or waiting for another process's cold build) is setup. Keep T07's 120 s assertion budget.
// Failed/uncacheable producers cannot be assumed to have a warm entry from an earlier suite.
for (const [id, policy] of Object.entries(UNIQUE_KITS)) {
  describe(`T07 ${id}`, () => {
    let kit;
    before(async () => { kit = await buildKit(id); }, { timeout: 600_000 });
    test('real builder, six-field proofs, tool calls and committed fixture agree', { timeout: 120_000 }, async () => {
      const before = JSON.parse(settingsText(kit));
      const fixture = await buildRevealFixture(kit);
      assert.equal(fixture.root, before.spec.revealRoot);
      assert.equal(fixture.specHash, before.specHash);
      assert.equal(fixture.encodedSpec, before.encoded);
      assert.equal(BigInt(fixture.items.length), BigInt(policy.count));
      assert.deepEqual(fixture.sampleIds, ['1', '2', '20', '21', '256', (BigInt(policy.count) - 1n).toString(), policy.count]);
      const reviewed = reviewedManifestForPlatform(id, JSON.parse(readFileSync(`examples/boxes/${id}/unique/manifest.json`, 'utf8')));
      const rows = reviewed.entries ?? reviewed.items;
      for (const [index, item] of fixture.items.entries()) {
        assert.equal(item.id, String(index + 1));
        assert.equal(item.imageHash, `0x${rows[index].picture.sha256}`);
        assert.equal(item.avatarHash, zeroHash);
        assert.equal(item.modelHash, policy.modelPolicy === '3d' ? `0x${rows[index].model.sha256}` : zeroHash);
        const source = kit.proofs.items[index];
        assert.equal(item.traitsPacked, source.traitsPacked);
        assert.equal(item.salt, source.salt);
        assert.deepEqual(item.proof, source.proof);
        // Independent ABI leaf and index-directed proof; no artwork leaf/tree helper.
        let node = keccak256(encodeAbiParameters([
          { type: 'uint256' }, { type: 'uint128' }, ...Array.from({ length: 4 }, () => ({ type: 'bytes32' })),
        ], [BigInt(item.id), BigInt(item.traitsPacked), item.imageHash, item.avatarHash, item.modelHash, item.salt]));
        let position = BigInt(index);
        for (const sibling of item.proof) {
          node = keccak256(position & 1n ? `${sibling}${node.slice(2)}` : `${node}${sibling.slice(2)}`);
          position >>= 1n;
        }
        assert.equal(node, fixture.root);
        const metadata = JSON.parse(item.tokenJSON);
        assert.deepEqual(Object.fromEntries(metadata.attributes.map(a => [a.trait_type, a.value])), rows[index].traits);
        assert.equal(Object.hasOwn(metadata, 'animation_url'), policy.modelPolicy === '3d');
      }
      // This also checks the writer's exact bytes, not just its returned JS object.
      const source = fixtureSource(fixture);
      const embedded = `0x${source.match(/return hex"([0-9a-f]+)";/)[1]}`;
      const [decoded] = decodeAbiParameters(fixtureAbi, embedded);
      assert.equal(decoded.specHash, fixture.specHash);
      assert.equal(decoded.root, fixture.root);
      assert.equal(decoded.items.length, fixture.items.length);
      assert.equal(decoded.calls.length, fixture.sampleIds.length);
      assert.equal(encodeAbiParameters(fixtureAbi, [decoded]), embedded);
      assert.equal(platformFixtureSource(id, readFileSync(fixturePath(id), 'utf8')), source, 'reviewed fixture plus only the listed platform model exception');
      assert.deepEqual(JSON.parse(settingsText(kit)).spec, before.spec, 'fixture construction must not change economic settings');
    });
  });
}
