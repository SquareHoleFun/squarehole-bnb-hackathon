import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DEFAULT_ENCODING, rawBlockCar, readBytes } from '../../../scripts/ipfs/pin-raw-lib.mjs';
import { publicRevealList } from './content.mjs';
import { assetRecord, readAsset, requireListAssets } from './inventory.mjs';

/** Offline only. Export CARs for `docker compose exec -T kubo ipfs dag import` on the server.
 * The manifest's expected hashes must come from the reviewed kit/spec, not newly chosen replacement art.
 */
export async function exportKit(manifestPath, destination) {
  const manifest = JSON.parse((await readBytes(manifestPath, 4_194_304)).toString('utf8'));
  if (!manifest || Object.keys(manifest).some(key => !['files', 'encoding'].includes(key))
      || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 20_000) throw new Error('invalid public manifest');
  if (manifest.encoding !== undefined && (!manifest.encoding || typeof manifest.encoding !== 'object' || Array.isArray(manifest.encoding)
      || Object.keys(manifest.encoding).some(key => !(key in DEFAULT_ENCODING)))) throw new Error('invalid encoding profile');
  const encoding = { ...DEFAULT_ENCODING, ...manifest.encoding };
  for (const role of ['image', 'avatar']) {
    if (!Number.isSafeInteger(encoding[`${role}Size`]) || encoding[`${role}Size`] < 1 || encoding[`${role}Size`] > 16_384
        || !Number.isSafeInteger(encoding[`${role}Quality`]) || encoding[`${role}Quality`] < 1 || encoding[`${role}Quality`] > 100
        || !['png', 'jpeg', 'webp'].includes(encoding[`${role}Format`])) throw new Error('invalid encoding profile');
  }
  const baseDirectory = dirname(resolve(manifestPath));
  const records = [];
  const lists = [];
  const seen = new Set();
  const ids = new Set();
  for (const [index, file] of manifest.files.entries()) {
    if (!file || Object.keys(file).some(key => !['path', 'role', 'id', 'sha256', 'mime', 'cid', 'bytes'].includes(key))) throw new Error('invalid public file');
    const role = file.role ?? 'file';
    if (file.id !== undefined) {
      if (!['image', 'item', 'avatar', 'model'].includes(role) || typeof file.id !== 'string'
          || !/^[1-9][0-9]{0,19}$/.test(file.id) || ids.has(`${file.id}:${role}`)) throw new Error('invalid item id/role');
      ids.add(`${file.id}:${role}`);
    }
    const bytes = await readAsset(baseDirectory, file);
    const record = assetRecord(bytes, { ...file, role });
    if (record.mime === 'application/json') lists.push(publicRevealList(bytes));
    if (!seen.has(record.cid)) {
      records.push({ index: index + 1, ...record, ...(file.id === undefined ? {} : { id: file.id }), encoding, upload: 'car-v1-raw', status: 'computed' });
      seen.add(record.cid);
    }
  }
  requireListAssets(lists, records);
  // Fresh destination only. An interrupted export is retained; use a different directory to retry.
  await mkdir(destination);
  for (const record of records) {
    const bytes = await readAsset(baseDirectory, manifest.files[record.index - 1]);
    assetRecord(bytes, record); // Recheck after preflight, before writing the committed raw block.
    await writeFile(resolve(destination, `${record.cid}.car`), rawBlockCar(bytes), { flag: 'wx' });
  }
  await writeFile(resolve(destination, 'pins.json'), `${JSON.stringify(records, null, 2)}\n`, { flag: 'wx' });
  return records;
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 4) throw new Error('usage');
    const records = await exportKit(process.argv[2], process.argv[3]);
    process.stdout.write(`Exported ${records.length} verified public-art records; pins.json is the inventory.\n`);
  } catch {
    process.stderr.write('export-kit: refused; check public roles, hashes, MIME, list coverage, 1 MiB bound and a fresh destination. Usage: node infra/server/ipfs/export-kit.mjs MANIFEST NEW_DIRECTORY\n');
    process.exitCode = 1;
  }
}
