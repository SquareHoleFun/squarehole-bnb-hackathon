import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exportKit } from '../../../../infra/server/ipfs/export-kit.mjs';
import { checkArt } from './build-art.mjs';

/** The sixteen card pictures as raw-block CARs (the cards' `imageURI` names each by its raw CID); no upload. */
export async function exportCars(destination) {
  checkArt();
  return exportKit(fileURLToPath(new URL('pin-manifest.json', import.meta.url)), destination);
}
function isEntry() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (isEntry()) {
  try {
    if (process.argv.length !== 3 || process.argv[2].startsWith('-')) throw new Error('usage');
    const records = await exportCars(process.argv[2]);
    process.stdout.write(`Exported ${records.length} public raw-block CARs; pins.json records their CIDs. No upload.\n`);
  } catch {
    process.stderr.write('Card CAR export refused; use export-car.mjs NEW_DIRECTORY with reviewed, unchanged art.\n');
    process.exitCode = 1;
  }
}
