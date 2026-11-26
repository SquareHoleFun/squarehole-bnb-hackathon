import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { pieces, collections } from './art.mjs';
import { generatedFiles, checkArt } from './build-art.mjs';
import { exportCars } from './export-car.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const kit = fileURLToPath(new URL('./', import.meta.url));
const sha = bytes => `0x${createHash('sha256').update(bytes).digest('hex')}`;
function scratch() {
  mkdirSync(join(root, '.cache/tmp'), { recursive: true });
  return mkdtempSync(join(root, '.cache/tmp/junk-collections-'));
}

test('five public test collections have ten distinct, numbered, reproducible SVG/PNG pairs and reviewed digests', () => {
  assert.equal(collections.length, 5);
  assert.equal(pieces().length, 10);
  checkArt();
  const files = generatedFiles();
  const catalog = JSON.parse(files.get('catalog.json'));
  const manifest = JSON.parse(files.get('pin-manifest.json'));
  assert.equal(manifest.files.length, 10);
  assert.equal(new Set(manifest.files.map(f => f.sha256)).size, 10);
  for (const collection of catalog.collections) {
    assert.match(collection.name, /^Test Junk /);
    assert.deepEqual(collection.items.map(item => item.id), ['1', '2']);
    for (const item of collection.items) {
      const bytes = files.get(item.path);
      assert.ok(bytes.length <= 1_048_576);
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.equal(bytes.readUInt32BE(16), 512);
      assert.equal(bytes.readUInt32BE(20), 512);
      assert.equal(item.sha256, sha(bytes));
      assert.equal(manifest.files.find(f => f.path === item.path).sha256, item.sha256);
      assert.match(item.cid, /^bafkrei[a-z2-7]{52}$/);
      const source = files.get(item.path.replace('.png', '.svg'));
      assert.doesNotMatch(source, /<script|<image|<foreignObject|<text|href=|url\(/i);
      assert.match(source, /<title>Test Junk /);
    }
  }
});

// Decode CAR framing independently of the exporter: one root and exactly one raw SHA-256 block.
function unpackCar(bytes) {
  let offset = 0;
  function varint() {
    let n = 0; let shift = 0; let next;
    do { next = bytes[offset++]; assert.notEqual(next, undefined); n += (next & 127) * 2 ** shift; shift += 7; } while (next & 128);
    return n;
  }
  const headerLength = varint();
  const header = bytes.subarray(offset, offset += headerLength);
  assert.equal(header.subarray(0, 12).toString('hex'), 'a265726f6f747381d82a5825');
  assert.equal(header[12], 0);
  const rootCid = header.subarray(13, 49);
  assert.equal(header.subarray(49).toString('hex'), '6776657273696f6e01');
  const blockLength = varint();
  const cid = bytes.subarray(offset, offset += 36);
  const block = bytes.subarray(offset, offset += blockLength - 36);
  assert.deepEqual(cid, rootCid);
  assert.equal(cid.subarray(0, 4).toString('hex'), '01551220');
  assert.equal(sha(block), `0x${cid.subarray(4).toString('hex')}`);
  assert.equal(offset, bytes.length);
  return block;
}

test('existing kit exporter produces ten raw CAR roots matching the PNGs, with no overwrite', async () => {
  const destination = join(scratch(), 'cars');
  const records = await exportCars(destination);
  const manifest = JSON.parse(readFileSync(join(kit, 'pin-manifest.json'), 'utf8'));
  assert.equal(records.length, 10);
  for (const [i, record] of records.entries()) {
    const car = readFileSync(join(destination, `${record.cid}.car`));
    assert.deepEqual(unpackCar(car), readFileSync(join(kit, manifest.files[i].path)));
    assert.equal(record.sha256, manifest.files[i].sha256);
    assert.equal(record.status, 'computed');
  }
  assert.deepEqual(JSON.parse(readFileSync(join(destination, 'pins.json'), 'utf8')), records);
  await assert.rejects(exportCars(destination));
});

test('program entry checks work through symlinks; imports are silent', () => {
  const link = join(scratch(), 'kit');
  symlinkSync(kit, link, 'dir');
  const run = (args) => spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
  const check = run([join(link, 'build-art.mjs'), '--check']);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /10/);
  for (const program of ['build-art.mjs', 'export-car.mjs']) {
    const bad = run([join(link, program), '--unknown']);
    assert.equal(bad.status, 1);
    const imported = run(['--input-type=module', '-e', `await import(${JSON.stringify(new URL(program, import.meta.url).href)})`]);
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout + imported.stderr, '');
  }
});
