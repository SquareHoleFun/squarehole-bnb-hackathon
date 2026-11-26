import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewedJsonForPlatform, reviewedManifestForPlatform, restoreReviewedNormalZeros } from '../kits/bag-holders-normal-zero-platform-exception.mjs';
import { intelNormalZeroHashes } from '../kits/record-bag-holders-intel-normal-zero.mjs';
import { verifyUniqueSet } from '../kits/unique.mjs';
import { modelGlb } from '../../examples/boxes/bag-holders/unique/model.mjs';

const reviewed = JSON.parse(readFileSync('examples/boxes/bag-holders/unique/manifest.json'));
const list = JSON.parse(readFileSync('scripts/kits/bag-holders-intel-normal-zero-hashes.json'));

test('ARM ignores the exception; non-ARM changes exactly 35 listed kind-09 model hashes', () => {
  const before = structuredClone(reviewed), intel = reviewedManifestForPlatform('bag-holders', reviewed, 'x64');
  assert.equal(reviewedManifestForPlatform('bag-holders', reviewed, 'arm64'), reviewed);
  assert.deepEqual(reviewedManifestForPlatform('bag-holders', reviewed, 'riscv64'), intel);
  assert.equal(reviewedManifestForPlatform('rent-free', reviewed, 'x64'), reviewed);
  assert.notDeepEqual(intel, reviewed, 'Intel bytes must fail the ARM comparison');
  assert.notDeepEqual(reviewed, intel, 'ARM bytes are not the listed Intel bytes');
  let changed = 0;
  for (const [index, row] of intel.items.entries()) {
    const original = before.items[index];
    if (Object.hasOwn(list, `model-${row.id}.glb`)) {
      assert.equal(row.traits.kind, '09');
      assert.equal(row.model.sha256, list[`model-${row.id}.glb`]);
      row.model.sha256 = original.model.sha256; changed++;
    }
  }
  assert.equal(changed, 35);
  assert.deepEqual(intel, before, 'no other field changes');
  assert.deepEqual(reviewed, before, 'recorded input is never mutated');
});

test('platform exception still rejects changed pictures, traits, sizes and unlisted/unknown model hashes', () => {
  for (const change of [
    m => { m.items[0].picture.sha256 = 'a'.repeat(64); },
    m => { m.items[0].traits.trim = 'changed'; },
    m => { m.items[0].model.bytes++; },
    m => { m.items[0].model.sha256 = 'a'.repeat(64); },
    m => { m.items.find(row => row.traits.kind === '09').model.sha256 = 'a'.repeat(64); },
  ]) {
    const root = mkdtempSync(join(tmpdir(), 'bag-platform-refuse-'));
    const manifest = structuredClone(reviewedManifestForPlatform('bag-holders', reviewed)); change(manifest);
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
    assert.throws(() => verifyUniqueSet('bag-holders', root), /reviewed manifest/);
  }
});

test('Intel list reproduces from actual models and only four zero signs recover the ARM hashes', { skip: process.arch === 'arm64' }, () => {
  assert.deepEqual(intelNormalZeroHashes(reviewed), list);
  assert.throws(() => intelNormalZeroHashes(reviewed, traits => {
    const bytes = modelGlb(traits); bytes[bytes.length - 1] ^= 1; return bytes;
  }), /unlisted model/);
  assert.throws(() => intelNormalZeroHashes(reviewed, traits => {
    const bytes = modelGlb(traits);
    if (traits.kind === '09') bytes[bytes.length - 1] ^= 1;
    return bytes;
  }), /four normal zero signs recover/);
});

test('af2: assignment JSON permits exactly the listed replacements and preserves every other byte', () => {
  const source = readFileSync('examples/boxes/bag-holders/assignment.json', 'utf8');
  const expected = JSON.parse(source), json = value => `${JSON.stringify(value, null, 2)}\n`;
  for (const row of expected.items) if (Object.hasOwn(list, `model-${row.id}.glb`)) row.model.sha256 = `0x${list[`model-${row.id}.glb`]}`;
  const platform = reviewedJsonForPlatform(source, reviewed, 'x64', '0x');
  assert.equal(platform, json(expected));
  assert.equal(reviewedJsonForPlatform(source, reviewed, 'riscv64', '0x'), platform);
  assert.equal(reviewedJsonForPlatform(source, reviewed, 'arm64', '0x'), source);
  assert.notEqual(platform, source, 'arm64 rejects the Intel assignment');
  for (const change of [
    m => { m.items[0].model.sha256 = `0x${'a'.repeat(64)}`; },
    m => { m.items.find(row => row.traits.kind === '09').model.sha256 = `0x${'a'.repeat(64)}`; },
    m => { m.items[0].picture.sha256 = `0x${'a'.repeat(64)}`; },
    m => { m.items[0].model.bytes++; },
    m => { m.items[0].model.path = 'changed.glb'; },
    m => { m.items[0].traits.trim = 'changed'; },
  ]) {
    const bad = structuredClone(expected); change(bad);
    assert.notEqual(platform, json(bad), 'audit equality must reject every extra assignment change');
  }
  assert.notEqual(platform, `${json(expected)} `, 'assignment whitespace is checked');
  assert.throws(() => reviewedJsonForPlatform(`${source} `, reviewed, 'x64', '0x'), /recorded JSON formatting/);
  const badRecorded = JSON.parse(source);
  badRecorded.items.find(row => row.traits.kind === '09').model.sha256 = `0x${'a'.repeat(64)}`;
  assert.throws(() => reviewedJsonForPlatform(json(badRecorded), reviewed, 'x64', '0x'), /reviewed ARM hash/);
  // No list validation on arm64, even with a manifest that cannot satisfy the 35-row list.
  assert.equal(reviewedJsonForPlatform(source, { items: [] }, 'arm64', '0x'), source);
});

test('af2: shared zero-sign reversal refuses a wrong source sign', { skip: process.arch === 'arm64' }, () => {
  const row = reviewed.items.find(row => row.traits.kind === '09');
  const intel = modelGlb(row.traits), restored = restoreReviewedNormalZeros(intel);
  assert.notDeepEqual(restored, intel);
  assert.throws(() => restoreReviewedNormalZeros(restored), /only the known normal zero signs/);
});
