import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { platformFixtureSource, platformFixtureSpecHash } from './fixtures/reveal-platform-expectation.mjs';
import { fixtureAbi, fixturePath } from '../kits/reveal-fixtures.mjs';
import { specV2 } from '../kits/app.mjs';
const { decodeAbiParameters } = createRequire(new URL('../../packages/chain/package.json', import.meta.url))('viem');
const decode = source => decodeAbiParameters(fixtureAbi, `0x${source.match(/return hex"([0-9a-f]+)";/)[1]}`)[0];

test('T07 platform expectation keeps the ARM fixture exact and changes only approved models and derived commitments', () => {
  const source = readFileSync(fixturePath('bag-holders'), 'utf8');
  assert.equal(platformFixtureSource('bag-holders', source, 'arm64'), source);
  const intelSource = platformFixtureSource('bag-holders', source, 'x64');
  assert.notEqual(intelSource, source);
  const arm = decode(source), intel = decode(intelSource);
  assert.equal(platformFixtureSpecHash('bag-holders', arm.specHash, 'arm64'), arm.specHash);
  assert.equal(platformFixtureSpecHash('bag-holders', arm.specHash, 'x64'), intel.specHash);
  assert.throws(() => platformFixtureSpecHash('bag-holders', `0x${'0'.repeat(64)}`, 'x64'), /recorded spec hash/);
  const a = specV2.decodeBoxSpecV2(arm.encodedSpec), b = specV2.decodeBoxSpecV2(intel.encodedSpec);
  assert.notEqual(a.revealRoot, b.revealRoot);
  assert.notEqual(a.revealListId, b.revealListId);
  assert.deepEqual({ ...b, revealRoot: a.revealRoot, revealListId: a.revealListId }, a, 'every other spec field stays reviewed');
  const changed = intel.items.filter((item, i) => item.modelHash !== arm.items[i].modelHash);
  assert.equal(changed.length, 35);
  for (const [index, item] of intel.items.entries()) {
    const original = arm.items[index];
    assert.deepEqual({ ...item, modelHash: original.modelHash, proof: original.proof, tokenJSON: original.tokenJSON }, original);
    const before = JSON.parse(original.tokenJSON), after = JSON.parse(item.tokenJSON);
    assert.deepEqual({ ...after, animation_url: before.animation_url }, before);
  }
  const other = readFileSync(fixturePath('rent-free'), 'utf8');
  assert.equal(platformFixtureSource('rent-free', other, 'x64'), other);
});
