import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildKit, KIT_IDS } from '../../../scripts/kits/settings.mjs';
import { bundleKit } from '../../../scripts/kits/bundle.mjs';
import { exportCars } from '../../../examples/boxes/junkyard/test-collections/export-car.mjs';
import { MAX_RAW_BLOCK_BYTES, readBytes } from '../../../scripts/ipfs/pin-raw-lib.mjs';
import { publicRevealList, ZERO_HASH } from './content.mjs';
import { assetRecord, readAsset, requireListAssets, servedRole } from './inventory.mjs';

const junk = new URL('../../../examples/boxes/junkyard/test-collections/', import.meta.url);

/** T02 owns the bundle/CAR producer. Consume its role/hash/size/CID interface without guessing extensions.
 * Only known auxiliary records are omitted; new roles fail closed until the producer/consumer agree.
 */
export async function bundleAssets(directory, inventory, revealListId) {
  if (inventory?.format !== 'squarehole.kit-bundle/1' || inventory.hiddenPlan !== undefined
      || !['bindings-required', 'bound-offline'].includes(inventory.status)
      || !Array.isArray(inventory.files) || !inventory.files.length || inventory.files.length > 20_000) throw new Error('invalid public bundle');
  const records = [];
  const lists = [];
  const auxiliary = new Set(['public proofs', 'traits', 'starter set']);
  for (const file of inventory.files) {
    if (auxiliary.has(file?.role)) continue;
    if (!servedRole(file?.role) || !Number.isSafeInteger(file.bytes) || typeof file.cid !== 'string') throw new Error('unsupported bundle asset');
    const bytes = await readAsset(directory, file);
    const record = { path: file.path, ...assetRecord(bytes, file) };
    if (record.mime === 'application/json') {
      if (record.sha256 !== revealListId) throw new Error('public list differs from final spec commitment');
      lists.push(publicRevealList(bytes));
    }
    records.push(record);
  }
  if (lists.length !== (revealListId === ZERO_HASH ? 0 : 1)) throw new Error('final public list missing or duplicated');
  requireListAssets(lists, records);
  return records;
}

/** All public example art, offline. Existing builders supply exact committed bytes and CAR framing.
 * Only open kits are exported: a hidden kit (art mode 2) is skipped, so nothing of a hidden edition is pinned
 * before its reveal. No directory scan, private reveal inputs, RPC, upload or signer.
 * Fresh destination only; partial output is retained for inspection if a build fails.
 */
export async function exportExamples(destination) {
  await mkdir(destination);
  const files = new Map();
  const cars = [];
  const kits = [];
  const add = (record) => {
    if (!files.has(record.cid)) files.set(record.cid, record);
  };
  const records = await exportCars(resolve(destination, 'test-junk'));
  const manifest = JSON.parse(await readFile(new URL('pin-manifest.json', junk), 'utf8'));
  for (const record of records) {
    const name = `test-junk/${record.cid}`;
    const bytes = await readBytes(fileURLToPath(new URL(manifest.files[record.index - 1].path, junk)), MAX_RAW_BLOCK_BYTES);
    await writeFile(resolve(destination, `${name}.png`), bytes, { flag: 'wx' });
    add({ path: `${name}.png`, ...assetRecord(bytes, record) });
    cars.push(`${name}.car`);
  }
  // buildKit uses a shared item-file store, so kits must be built serially.
  for (const id of KIT_IDS) {
    const kit = await buildKit(id);
    if (kit.spec.artMode === 2) continue;
    kits.push(id);
    await bundleKit(kit, resolve(destination, id));
    const inventory = JSON.parse(await readFile(resolve(destination, id, 'inventory.json'), 'utf8'));
    for (const file of await bundleAssets(resolve(destination, id), inventory, kit.spec.revealListId)) {
      add({ ...file, path: `${id}/${file.path}` });
    }
    cars.push(`${id}/pictures.car`);
  }
  const inventory = { format: 'squarehole.public-example-pins/1', kits, cars, files: [...files.values()] };
  await writeFile(resolve(destination, 'pins.json'), `${JSON.stringify(inventory, null, 2)}\n`, { flag: 'wx' });
  return inventory;
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3 || process.argv[2].startsWith('-')) throw new Error('usage');
    const result = await exportExamples(process.argv[2]);
    process.stdout.write(`Exported ${result.cars.length} CARs, ${result.files.length} unique public asset CIDs; pins.json includes supported images, models and canonical lists. No upload.\n`);
  } catch {
    process.stderr.write('export-examples refused; use a fresh destination and unchanged public kit art. Usage: node --experimental-transform-types infra/server/ipfs/export-examples.mjs NEW_DIRECTORY\n');
    process.exitCode = 1;
  }
}
