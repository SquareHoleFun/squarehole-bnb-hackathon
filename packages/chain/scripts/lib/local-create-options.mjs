import '../register-ts.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
const { parseCreateOptions } = await import('../../src/create-options/schema.ts');

/** Local stacks only: every release in the just-written manifest gets a schema-checked, all-on list in this run. */
export function writeLocalCreateOptions(manifestFile) {
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  if (!Array.isArray(manifest.releases) || manifest.releases.length === 0) throw new Error('local Create lists need a manifest with releases');
  const directory = resolve(dirname(manifestFile), 'create-options');
  for (const release of manifest.releases) {
    const pins = { chainId: manifest.chainId, factory: release.factory.address.toLowerCase(),
      registry: release.registry.address.toLowerCase(), versionCodeHash: release.versionCodeHash.toLowerCase() };
    const text = `${JSON.stringify({ schema: 1, ...pins, revision: 1, off: [] })}\n`;
    const checked = parseCreateOptions(text, pins);
    if (!checked.ok) throw new Error(`local Create list refused: ${checked.reason}`);
    const folder = join(directory, String(pins.chainId));
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${pins.factory}.json`), text);
  }
  return directory;
}
