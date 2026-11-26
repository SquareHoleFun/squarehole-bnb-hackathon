#!/usr/bin/env node
/** Offline raw-block CAR and numbered open-art files. Never contacts an IPFS service. */
import { mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { buildKit, cliArgs, json, ROOT, settingsText, writeSettings, planManifest } from './settings.mjs';
import { MAX_RAW_BLOCK_BYTES, rawBlockCar, rawCidV1 } from '../ipfs/pin-raw-lib.mjs';
import { artwork, pictureTypes } from './app.mjs';
import { UNIQUE_KITS } from './unique.mjs';
const { sha256Hex, canonicalJson } = artwork;

function varint(value) {
  const bytes = [];
  do { const next = value % 128; value = Math.floor(value / 128); bytes.push(next | (value ? 128 : 0)); } while (value);
  return Buffer.from(bytes);
}
const cidBytes = digest => Buffer.concat([Buffer.from([1, 0x55, 0x12, 0x20]), Buffer.from(digest.slice(2), 'hex')]);
function arrayHeader(length) {
  assert.ok(length <= 65535);
  return length < 24 ? Buffer.from([0x80 + length]) : length < 256 ? Buffer.from([0x98, length]) : Buffer.from([0x99, length >> 8, length & 255]);
}

/** All unique raw blocks are roots: dag import pins each picture, not just a JSON inventory with no IPLD links. */
export function rawBlocksCar(blocks) {
  const entries = [...blocks];
  const header = Buffer.concat([Buffer.from('a265726f6f7473', 'hex'), arrayHeader(entries.length),
    ...entries.map(([digest]) => Buffer.concat([Buffer.from('d82a582500', 'hex'), cidBytes(digest)])), Buffer.from('6776657273696f6e01', 'hex')]);
  const sections = entries.map(([digest, bytes]) => {
    assert.equal(sha256Hex(bytes), digest, 'raw block digest mismatch');
    const single = rawBlockCar(bytes); // shared 1 MiB guard and the production pin writer's exact framing
    let size = 0; let shift = 0; let offset = 0; let byte;
    do { byte = single[offset++]; size += (byte & 127) * 2 ** shift; shift += 7; } while (byte & 128);
    return single.subarray(offset + size);
  });
  return Buffer.concat([varint(header.length), header, ...sections]);
}

/** Refuse replacement of different prior bytes; retain interrupted builds and retry in a fresh directory. */
function writeSame(path, bytes) {
  if (existsSync(path)) { assert.deepEqual(readFileSync(path), Buffer.from(bytes), 'output differs; retain it and choose a fresh directory'); return; }
  writeFileSync(path, bytes, { flag: 'wx' });
}

export async function bundleKit(kit, destination) {
  if (kit.spec.artMode === 2) {
    assert.ok(kit.plan && kit.spec.revealRoot === kit.plan.templateRoot && kit.items.length === 0 && kit.revealList === null && kit.proofs === null && kit.art === null && kit.pictures.every(p => ['logo', 'collection cover', 'banner', 'teaser'].includes(p.role)), 'hidden edition material must never enter a public bundle');
  }
  const blocks = new Map();
  const files = [];
  const outputs = new Map();
  const block = (path, bytes, role, expected) => {
    bytes = Buffer.from(bytes);
    assert.ok(bytes.length <= MAX_RAW_BLOCK_BYTES, 'one raw block per file, at most 1 MiB');
    const sha256 = sha256Hex(bytes);
    if (expected) assert.equal(sha256, expected, 'committed hash differs from bundle bytes');
    blocks.set(sha256, bytes);
    outputs.set(path, bytes);
    files.push({ path, role, bytes: bytes.length, sha256, cid: rawCidV1(sha256) });
  };
  for (const [index, picture] of kit.pictures.entries()) {
    const extension = { 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg' }[pictureTypes.pictureType(picture.bytes)];
    assert.ok(extension, 'raster picture required');
    block(`pictures/${String(index + 1).padStart(2, '0')}.${extension}`, picture.bytes, picture.role, picture.sha256);
  }
  const modelPolicy = Object.hasOwn(UNIQUE_KITS, kit.id) ? UNIQUE_KITS[kit.id].modelPolicy : '2d';
  for (const [index, item] of kit.items.entries()) {
    assert.equal(item.id, String(index + 1), 'bundle items must be ordered 1..N');
    const entry = kit.revealList?.items[index];
    assert.equal(entry?.id, item.id, 'list item id');
    assert.equal(entry.imageSha256, item.sha256, 'list picture hash');
    assert.equal(Boolean(item.model), modelPolicy === '3d', 'model policy requires exactly the approved models');
    assert.equal(entry.modelSha256, item.model?.sha256 ?? `0x${'0'.repeat(64)}`, 'list model policy hash');
    block(`items/${item.id}.png`, item.bytes, 'item', item.sha256);
    if (item.model) block(`items/${item.id}.glb`, item.model.bytes, 'model', item.model.sha256);
  }
  outputs.set('items/traits.csv', Buffer.from(kit.traitsCsv));
  if (kit.revealList) {
    block('reveal-list.json', canonicalJson(kit.revealList), 'public reveal list', kit.spec.revealListId);
    block('proofs.json', canonicalJson(kit.proofs), 'public proofs');
    block('items/traits.csv', kit.traitsCsv, 'traits');
  }
  if (kit.starter.length) block('starter-set.json', json({ format: 'squarehole.kit-starter/1', items: kit.starter }), 'starter set');
  if (kit.plan) {
    block('hidden-plan.json', json(planManifest(kit)), 'public hidden plan');
    block('plan.csv', readFileSync(resolve(ROOT, kit.plan.path)), 'public hidden plan', kit.plan.sha256);
  }
  const settings = Buffer.from(settingsText(kit));
  const inventory = {
    format: 'squarehole.kit-bundle/1', kit: kit.id, chainId: '11155111',
    status: kit.plan ? 'hidden-plan-template' : kit.unresolved.length ? 'bindings-required' : 'bound-offline',
    modelPolicy, integrationRequirements: kit.integrationRequirements,
    ...(kit.plan ? { hiddenPlan: kit.plan } : {}),
    settings: { path: `${kit.id}-boxspec-v2.json`, sha256: sha256Hex(settings), bytes: settings.length },
    creatorSets: ['price coin', 'name', 'ticker', 'opening time', 'fees'],
    unresolvedBindings: kit.unresolved,
    notes: ['A portable setup, not transaction calldata. Resolve every offline address slot before Create.',
      'Refresh the selected listing and raise, bind the connected creator and confirm opening time.',
      ...(kit.plan ? ['Public plan template only: no hidden item pictures, assignment, salts or reveal file. Load requires private plan inputs and a fresh commitment; never create directly from its template root.'] : []),
      ...(kit.id === 'the-alchemist' ? ['Keep pending until a mature Alchemist row resolves for the chosen price coin and Test Gold; row slot 0 is not a claimed registration.'] : []),
      ...(kit.starter.length ? ['Shop starter NFTs are external collections, not newly minted items. No local NFT artwork or deployed starter collections are supplied by this kit.'] : []),
      'All CAR blocks are roots for pin-roots=true; none are UnixFS directories.'],
    files,
  };
  const inventoryBytes = Buffer.from(json(inventory));
  assert.ok(inventoryBytes.length <= MAX_RAW_BLOCK_BYTES);
  const inventoryHash = sha256Hex(inventoryBytes);
  // Inventory first for a stable summary root; each remaining raw block is also independently pinned.
  const ordered = new Map([[inventoryHash, inventoryBytes], ...blocks]);
  const car = rawBlocksCar(ordered);
  outputs.set('inventory.json', inventoryBytes);
  outputs.set(`${kit.id}-boxspec-v2.json`, settings);
  outputs.set('pictures.car', car);
  mkdirSync(destination, { recursive: true });
  mkdirSync(resolve(destination, 'items'), { recursive: true });
  mkdirSync(resolve(destination, 'pictures'), { recursive: true });
  for (const [path, bytes] of outputs) writeSame(resolve(destination, path), bytes);
  return { id: kit.id, items: kit.items.length, starterItems: kit.starter.length, settingsBytes: settings.length,
    bundleBytes: [...outputs.values()].reduce((sum, bytes) => sum + bytes.length, 0), carBytes: car.length,
    carRoot: rawCidV1(inventoryHash), rawRoots: ordered.size, unresolvedBindings: kit.unresolved.length };
}

function startedDirectly() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (startedDirectly()) {
  try {
    const { ids, bindings } = cliArgs(process.argv.slice(2));
    for (const id of ids) {
      const kit = await buildKit(id, bindings);
      const destination = resolve(ROOT, 'examples/boxes', id, 'build');
      const result = await bundleKit(kit, destination);
      writeSettings(kit);
      process.stdout.write(json({ ...result, directory: relative(ROOT, destination) }));
    }
  } catch (error) {
    console.error(error?.code === 'ERR_CWEBP_REQUIRED'
      ? 'kit bundle refused: cwebp is required for the offline free-picture encoder.'
      : `kit bundle refused: ${error.message}`);
    process.exitCode = 1;
  }
}
