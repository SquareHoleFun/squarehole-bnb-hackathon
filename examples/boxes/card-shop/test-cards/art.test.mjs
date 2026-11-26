import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { TIERS, CARD_NAMES, pieces, lettering } from './art.mjs';
import { generatedFiles, checkArt } from './build-art.mjs';

const sha = bytes => `0x${createHash('sha256').update(bytes).digest('hex')}`;
const png = (bytes, width, height) => {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(bytes.readUInt32BE(16), width);
  assert.equal(bytes.readUInt32BE(20), height);
};

test('SH-262: four tiers of four cards, sixteen distinct reproducible pictures with their digests in the catalog and in Solidity', () => {
  assert.deepEqual(TIERS.map(t => t.rarity), ['Common', 'Uncommon', 'Rare', 'Legendary']);
  assert.equal(pieces().length, 16);
  checkArt();
  const files = generatedFiles();
  const catalog = JSON.parse(files.get('catalog.json'));
  const manifest = JSON.parse(files.get('pin-manifest.json'));
  assert.equal(manifest.files.length, 16);
  assert.equal(new Set(manifest.files.map(f => f.sha256)).size, 16);
  const solidity = files.get('../../../../packages/contracts/src/test-coins/TestTradingCardsCatalog.sol');
  for (const [tier, collection] of catalog.collections.entries()) {
    assert.equal(collection.tier, String(tier));
    assert.match(collection.name, /^Test Trading Cards (Common|Uncommon|Rare|Legendary)$/);
    assert.deepEqual(collection.items.map(item => item.id), ['1', '2', '3', '4']);
    assert.deepEqual(collection.items.map(item => item.name), CARD_NAMES[tier]);
    for (const [i, item] of collection.items.entries()) {
      const bytes = files.get(item.path);
      assert.ok(bytes.length <= 1_048_576);
      png(bytes, 500, 700);
      assert.equal(item.sha256, sha(bytes));
      assert.equal(item.number, `${String(tier * 4 + i + 1).padStart(2, '0')}/16`);
      assert.match(item.cid, /^bafkrei[a-z2-7]{52}$/);
      assert.ok(solidity.includes(`bytes32(${item.sha256})`));
      const source = files.get(item.path.replace('.png', '.svg'));
      // Lettering is drawn as strokes: no fonts, scripts, linked pictures or outside references.
      assert.doesNotMatch(source, /<script|<image|<foreignObject|<text|href=|url\((?!#)/i);
      assert.match(source, /<title>Test Trading Cards /);
      assert.deepEqual(readFileSync(new URL(item.path, import.meta.url)), bytes);
    }
  }
  png(files.get('contact-sheet.png'), 4 * 250 + 5 * 24, 4 * 350 + 5 * 24);
  png(files.get('../art/logo.png'), 512, 512);
});

test('the stroke lettering has every letter it is asked for and refuses one it lacks', () => {
  for (const words of [...CARD_NAMES.flat(), ...TIERS.map(t => t.rarity), 'Test card', '0123456789/']) {
    assert.match(lettering(words, { x: 0, y: 0, height: 12 }), /^<path d="M/);
  }
  assert.throws(() => lettering('a#', { x: 0, y: 0, height: 12 }), /no glyph/);
});

test('the kit exporter writes sixteen raw CARs named by the cards\' CIDs, and never overwrites', async () => {
  const { mkdirSync, mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { exportCars } = await import('./export-car.mjs');
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  mkdirSync(join(root, '.cache/tmp'), { recursive: true });
  const destination = join(mkdtempSync(join(root, '.cache/tmp/test-cards-')), 'cars');
  const records = await exportCars(destination);
  const catalog = JSON.parse(readFileSync(new URL('catalog.json', import.meta.url), 'utf8'));
  assert.deepEqual(records.map(r => r.sha256), catalog.collections.flatMap(c => c.items.map(item => item.sha256)));
  assert.deepEqual(records.map(r => r.cid), catalog.collections.flatMap(c => c.items.map(item => item.cid)));
  await assert.rejects(exportCars(destination));
});
