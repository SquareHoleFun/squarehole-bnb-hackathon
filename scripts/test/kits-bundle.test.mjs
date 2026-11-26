import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { buildKit, KIT_IDS, settingsText } from '../kits/settings.mjs';
import { bundleKit, rawBlocksCar } from '../kits/bundle.mjs';
import { rawBlockCar, rawCidV1 } from '../ipfs/pin-raw-lib.mjs';
import { artwork, artFiles } from '../kits/app.mjs';
const { boxLeaf, verifyBoxProof, sha256Hex, canonicalJson } = artwork;
const { readArt } = artFiles;

// Independent CAR reader: require CIDv1/raw/sha2-256, canonical CBOR roots and exact framing/EOF.
function carParts(car) {
  let cursor = 0;
  const take = length => { const out = car.subarray(cursor, cursor + length); cursor += length; assert.equal(out.length, length); return out; };
  const integer = () => {
    let value = 0; let shift = 0; let byte;
    do { byte = take(1)[0]; value += (byte & 127) * 2 ** shift; shift += 7; assert.ok(shift <= 35); } while (byte & 128);
    return value;
  };
  const headerSize = integer(); const end = cursor + headerSize;
  assert.equal(take(7).toString('hex'), 'a265726f6f7473');
  const marker = take(1)[0];
  const count = marker === 0x98 ? take(1)[0] : marker === 0x99 ? take(2).readUInt16BE() : marker - 0x80;
  const roots = [];
  const digest = () => { assert.equal(take(4).toString('hex'), '01551220'); return `0x${take(32).toString('hex')}`; };
  for (let i = 0; i < count; i++) { assert.equal(take(5).toString('hex'), 'd82a582500'); roots.push(rawCidV1(digest())); }
  assert.equal(take(9).toString('hex'), '6776657273696f6e01');
  assert.equal(cursor, end);
  const blocks = [];
  while (cursor < car.length) {
    const start = cursor; const size = integer(); const hash = digest(); const bytes = take(size - 36);
    blocks.push({ digest: hash, bytes, section: car.subarray(start, cursor) });
  }
  assert.equal(cursor, car.length);
  return { roots, blocks };
}

// Retain scratch outputs for review; no deletion in this lane.
function scratch(prefix) {
  mkdirSync('.cache/tmp', { recursive: true });
  const dir = mkdtempSync(`.cache/tmp/${prefix}`);
  return dir;
}

assert.ok(KIT_IDS.includes('link-marines-v2'), 'the public bundle includes v2');

for (const id of KIT_IDS) {
  test(`${id}: assigned pictures, app-readable traits, every proof and raw CAR bytes`, async () => {
    const kit = await buildKit(id);
    const out = scratch(`kits-${id}-`);
    const result = await bundleKit(kit, out);
    assert.equal(readFileSync(`${out}/${id}-boxspec-v2.json`, 'utf8'), settingsText(kit));
    const inventory = JSON.parse(readFileSync(`${out}/inventory.json`, 'utf8'));
    // SH-CREATE-ITEM-MODELS: the 3D kits' models are Create's own now, so they wait only for their bindings like the rest.
    assert.equal(inventory.status, kit.plan ? 'hidden-plan-template' : id === 'dragons-hoard' ? 'bound-offline' : 'bindings-required');
    assert.deepEqual(inventory.integrationRequirements, []);
    assert.ok(!inventory.files.some(f => kit.plan && ['item', 'public reveal list', 'public proofs'].includes(f.role)));
    const blocks = carParts(readFileSync(`${out}/pictures.car`));
    assert.equal(blocks.roots.length, blocks.blocks.length, 'each raw block is a pin root');
    for (const { digest, bytes, section } of blocks.blocks) {
      assert.equal(sha256Hex(bytes), digest);
      assert.ok(blocks.roots.includes(rawCidV1(digest)));
      assert.ok(rawBlockCar(bytes).subarray(-section.length).equals(section), 'same raw block framing as the pin writer');
    }
    const byHash = new Map(blocks.blocks.map(b => [b.digest, b.bytes]));
    assert.equal(result.rawRoots, blocks.blocks.length);
    const inventoryBytes = readFileSync(`${out}/inventory.json`);
    assert.ok(inventoryBytes.length <= 1_048_576, 'inventory fits one raw block');
    assert.equal(blocks.blocks.length, new Set([sha256Hex(inventoryBytes), ...inventory.files.map(f => f.sha256)]).size);
    for (const file of inventory.files) {
      const bytes = readFileSync(`${out}/${file.path}`);
      assert.equal(bytes.length, file.bytes);
      assert.equal(sha256Hex(bytes), file.sha256);
      assert.equal(file.cid, rawCidV1(file.sha256));
      assert.deepEqual(byHash.get(file.sha256), bytes);
    }
    const models = inventory.files.filter(f => f.role === 'model');
    assert.equal(models.length, ['rent-free', 'bag-holders'].includes(id) ? kit.items.length : 0);
    for (const item of kit.items) {
      if (item.model) {
        const bytes = readFileSync(`${out}/items/${item.id}.glb`);
        assert.deepEqual(bytes, readFileSync(item.model.source));
        assert.equal(sha256Hex(bytes), item.model.sha256);
        assert.equal(kit.revealList.items[Number(item.id) - 1].modelSha256, item.model.sha256);
      } else assert.ok(!models.some(m => m.path === `items/${item.id}.glb`));
    }
    assert.equal(result.carRoot, rawCidV1(sha256Hex(readFileSync(`${out}/inventory.json`))));
    for (const picture of kit.pictures) assert.deepEqual(byHash.get(picture.sha256), Buffer.from(picture.bytes));
    const files = kit.items.map(item => {
      const bytes = readFileSync(`${out}/items/${item.id}.png`);
      assert.deepEqual(bytes, readFileSync(item.source));
      assert.equal(sha256Hex(bytes), item.sha256);
      return new File([bytes], `${item.id}.png`, { type: 'image/png' });
    });
    // A 3D kit's numbered models, as Create's Load settings takes them from the same items/ folder.
    const glbs = kit.items.filter(item => item.model).map(item => new File([readFileSync(`${out}/items/${item.id}.glb`)], `${item.id}.glb`, { type: 'model/gltf-binary' }));
    if (files.length) {
      const read = await readArt([...files, ...glbs, new File([kit.traitsCsv], 'traits.csv')], {
        env: { digest: async b => sha256Hex(b), salt: () => `0x${'0'.repeat(64)}`, thumbnail: async () => null },
      });
      assert.deepEqual(read.problems, []);
      assert.deepEqual(read.items.map(i => i.traits), kit.art.items.map(i => i.traits));
      assert.deepEqual(read.items.map(i => i.modelSha256 ?? null), kit.items.map(item => item.model?.sha256 ?? null));
      assert.deepEqual(byHash.get(kit.spec.revealListId), Buffer.from(canonicalJson(kit.revealList)));
      for (const entry of kit.proofs.items) {
        const leaf = boxLeaf({ ...entry, id: Number(entry.id), traitsPacked: BigInt(entry.traitsPacked) }, kit.items.length);
        assert.ok(verifyBoxProof(Number(entry.id), leaf, entry.proof, kit.spec.revealRoot, kit.items.length));
        assert.equal(verifyBoxProof(Number(entry.id), leaf, [...entry.proof].reverse(), kit.spec.revealRoot, kit.items.length), false);
      }
    }
    const again = scratch(`kits-${id}-again-`);
    await bundleKit(await buildKit(id), again);
    assert.deepEqual(readFileSync(`${out}/pictures.car`), readFileSync(`${again}/pictures.car`));
  });
}

test('raw export refuses changed picture bytes, oversized blocks and replacing prior output', async () => {
  const oversized = Buffer.alloc(1_048_577);
  assert.throws(() => rawBlocksCar(new Map([[sha256Hex(oversized), oversized]])), /1 MiB/);
  const kit = await buildKit('dragons-hoard');
  const out = scratch('kits-refuse-');
  const picture = kit.pictures[0];
  const damaged = Buffer.from(picture.bytes); damaged[damaged.length - 1] ^= 1;
  await assert.rejects(bundleKit({ ...kit, pictures: [{ ...picture, bytes: damaged }] }, out), /committed hash/);
  writeFileSync(`${out}/inventory.json`, 'retained previous result');
  await assert.rejects(bundleKit(kit, out), /output differs/);
  assert.equal(readFileSync(`${out}/inventory.json`, 'utf8'), 'retained previous result');
});

test('hidden public bundle refuses item bytes, numbered assignments, proofs or a real edition root', async () => {
  const kit = await buildKit('frog-kiln');
  const out = scratch('kits-hidden-refuse-');
  for (const changed of [
    { pictures: [...kit.pictures, { ...kit.pictures[0], role: 'item' }] },
    { pictures: [...kit.pictures, { ...kit.pictures[0], role: 'model' }] },
    { items: [{ id: '1', bytes: kit.pictures[0].bytes }] },
    { revealList: { items: [] } }, { proofs: { items: [] } }, { art: { items: [] } },
    { spec: { ...kit.spec, revealRoot: `0x${'a'.repeat(64)}` } },
  ]) await assert.rejects(bundleKit({ ...kit, ...changed }, out), /hidden edition material/);
});


test('T02: CAR refuses corrupt, missing and forbidden model material', async () => {
  const kit = await buildKit('bag-holders');
  const out = scratch('kits-model-refuse-');
  const first = kit.items[0];
  const bytes = Buffer.from(first.model.bytes); bytes[bytes.length - 1] ^= 1;
  await assert.rejects(bundleKit({ ...kit, items: [{ ...first, model: { ...first.model, bytes } }, ...kit.items.slice(1)] }, out), /committed hash/);
  await assert.rejects(bundleKit({ ...kit, items: [{ ...first, model: null }, ...kit.items.slice(1)] }, out), /model policy/);
  const twoD = await buildKit('exit-liquidity');
  await assert.rejects(bundleKit({ ...twoD, items: twoD.items.map(i => ({ ...i, model: first.model })) }, out), /model policy/);
});
