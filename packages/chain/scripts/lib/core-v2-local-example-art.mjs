/**
 * The example stack's own art (SH-V21-EXAMPLES-E2E-FIX2). The create flow re-encodes each picture in the browser and
 * the spec commits those bytes, so the example suite writes exactly the committed bytes here BEFORE the box that
 * commits them is created, and only the example stack's art gateway reads them (`startLocalArtGateway(ports,
 * { exampleArt })`). Every picture passes the same size, type and SHA-256 checks as the committed catalogue, when it
 * is written and again whenever the gateway reads it. Pictures are named by their SHA-256; nothing is ever deleted.
 * No TypeScript import: the Playwright worker loads this module as well as the stack.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_ART_BYTES = 1_048_576; // Same single raw-block limit as the production art checker.
export const ART_FILE = /^[a-zA-Z][a-zA-Z0-9-]*\.png$/;
export const ART_SHA256 = /^0x[0-9a-f]{64}$/;
export const EXAMPLE_ART_SCHEMA = 'sh.local-art.examples.v1';
export const EXAMPLE_ART_ROLES = Object.freeze(['logo', 'collection cover', 'item']);
const PNG_SIGNATURE = '89504e470d0a1a0a';
// The registry's own id shape (packages/box-spec/examples/v2/registry.mjs): a versioned kit's later parts may hold digits
// (link-marines-v2).
const EXAMPLE_ID = /^[a-z]+(?:-[a-z0-9]+)*$/;
const RAW = /^[1-9][0-9]*$/;

export const sha256Hex = bytes => `0x${createHash('sha256').update(bytes).digest('hex')}`;
const fileOf = sha256 => `art-${sha256.slice(2)}.png`;
const catalogPath = directory => join(directory, 'catalog.json');

/** The catalogue's checks for one picture: at most one raw block, exactly the committed SHA-256, a PNG. */
export function checkArtBytes(bytes, sha256, name) {
  if (bytes.length > MAX_ART_BYTES || sha256Hex(bytes) !== sha256) throw new Error(`local art sha256/size mismatch: ${name}`);
  if (bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== PNG_SIGNATURE) throw new Error(`local art is not PNG: ${name}`);
  return bytes;
}

/** Replaces the file in one rename, so a reader never sees a partly written catalogue. */
function writeCatalog(directory, catalog) {
  const temporary = join(directory, `catalog.json.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(catalog, null, 2)}\n`);
  renameSync(temporary, catalogPath(directory));
}

function readCatalog(directory) {
  const catalog = JSON.parse(readFileSync(catalogPath(directory), 'utf8'));
  if (catalog?.schema !== EXAMPLE_ART_SCHEMA || typeof catalog.pictures !== 'object' || catalog.pictures === null
      || Array.isArray(catalog.pictures)) throw new Error('unknown example art catalogue');
  return catalog;
}

/** The example stack starts with an empty catalogue: pictures written by an earlier run are never served by this one. */
export function resetExampleArt(directory) {
  mkdirSync(directory, { recursive: true });
  writeCatalog(directory, { schema: EXAMPLE_ART_SCHEMA, pictures: {} });
}

/**
 * Adds the exact bytes one example commits. Every picture is checked before anything is written; a refusal leaves the
 * catalogue as it was. Only a catalogue the example stack started can be written to.
 */
export function writeExampleArt(directory, example, pictures) {
  if (!EXAMPLE_ID.test(example)) throw new Error(`invalid example id: ${example}`);
  if (!Array.isArray(pictures) || pictures.length === 0) throw new Error(`${example}: no pictures to serve`);
  const checked = pictures.map(({ role, sha256, bytes }) => {
    if (!EXAMPLE_ART_ROLES.includes(role)) throw new Error(`${example}: unknown picture role ${role}`);
    if (typeof sha256 !== 'string' || !ART_SHA256.test(sha256)) throw new Error(`${example} ${role}: invalid sha256`);
    return { role, sha256, bytes: checkArtBytes(Buffer.from(bytes), sha256, `${example} ${role}`) };
  });
  if (!existsSync(catalogPath(directory))) throw new Error('example art catalogue missing: the example stack starts it');
  const catalog = readCatalog(directory);
  for (const { role, sha256, bytes } of checked) {
    const file = fileOf(sha256);
    try { writeFileSync(join(directory, file), bytes, { flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      checkArtBytes(readFileSync(join(directory, file)), sha256, file); // a kept file must still be these bytes
    }
    const uses = new Set(catalog.pictures[sha256]?.uses ?? []);
    uses.add(`${example}:${role}`);
    catalog.pictures[sha256] = { file, sha256, bytes: String(bytes.length), type: 'image/png', uses: [...uses].sort() };
  }
  writeCatalog(directory, catalog);
  return checked.map(({ role, sha256, bytes }) => ({ role, sha256, file: fileOf(sha256), bytes: String(bytes.length) }));
}

/** The pictures of the example catalogue by SHA-256, each re-read with the catalogue's checks; any bad entry refuses all. */
export function loadExampleArt(directory, { readBytes = readFileSync } = {}) {
  const catalog = readCatalog(directory);
  const files = new Map();
  for (const [key, entry] of Object.entries(catalog.pictures)) {
    if (key !== entry?.sha256 || !ART_SHA256.test(entry.sha256) || entry.file !== fileOf(entry.sha256) || !ART_FILE.test(entry.file)
        || entry.type !== 'image/png' || typeof entry.bytes !== 'string' || !RAW.test(entry.bytes)) {
      throw new Error('invalid example art file or hash');
    }
    const bytes = checkArtBytes(Buffer.from(readBytes(join(directory, entry.file))), entry.sha256, entry.file);
    if (String(bytes.length) !== entry.bytes) throw new Error(`example art size mismatch: ${entry.file}`);
    files.set(entry.sha256, bytes);
  }
  return files;
}
