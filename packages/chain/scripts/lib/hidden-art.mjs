/** Hidden kit material is generated only below the ignored cache; no publisher or network client. */
import '../register-ts.mjs';
import { renderPngs } from '../../../../scripts/kits/png-workers.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256, zeroHash } from 'viem';
const { encodeBoxSpecV2 } = await import('../../../box-spec/src/generated/box-spec.v2.ts');
const { commitArt, metadataTableHex, revealFile } = await import('../../../../apps/web/src/features/create/create-model.ts');
const { boxSpecFrame, picturePart } = await import('../../../../apps/web/src/features/create/v2/model.ts');
const { boxLeaf, buildBoxTree } = await import('../../../artwork/src/box-commitment.ts');

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const sha256 = bytes => `0x${createHash('sha256').update(bytes).digest('hex')}`;
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const write = (file, bytes) => writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
const supported = example => assert.ok(['frog-kiln', 'paper-certificates'].includes(example.id) && example.contents.art.mode === 'hidden', 'hidden kit required');

function privateDirectory(directory) {
  const cache = resolve(ROOT, '.cache');
  const actual = realpathSync(resolve(ROOT, directory));
  assert.ok(actual.startsWith(`${cache}${sep}`), 'hidden material must stay in the local cache');
  const local = relative(ROOT, actual);
  assert.equal(execFileSync('git', ['check-ignore', '--', local], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(), local, 'hidden material must be gitignored');
  return actual;
}

/** Fresh CSPRNG assignment and independent leaf salts; full numbered PNG set and Create's reveal-file format. */
export async function createHiddenArt(example, { parentDirectory = '.cache/hidden-art' } = {}) {
  supported(example);
  const base = resolve(ROOT, parentDirectory);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  privateDirectory(base);
  const directory = mkdtempSync(`${base}/${example.id}-`);
  const seed = randomBytes(32).toString('hex');
  write(`${directory}/secret.json`, json({ seed }));
  mkdirSync(`${directory}/items`, { mode: 0o700 });
  const kit = new URL(`examples/boxes/${example.id}/`, new URL('../../../../', import.meta.url));
  const assignment = await import(new URL('assign.mjs', kit));
  const assigned = assignment.assignment(seed);
  let pictures;
  if (example.id === 'paper-certificates') {
    const { VARIANTS, itemSvg } = await import(new URL('src/items.mjs', kit));
    pictures = renderPngs(assigned.items, { svg: item => itemSvg(VARIANTS[Number(item.variant) - 1], item.id) });
  } else pictures = (async function* () {
    for (const item of assigned.items) yield readFileSync(new URL(item.image, kit));
  })();
  const items = []; const salts = []; const sizes = [];
  let pictureIndex = 0;
  for await (const bytes of pictures) {
    const item = assigned.items[pictureIndex++];
    assert.ok(bytes.length > 0 && bytes.length <= 1048576, 'item exceeds the raw-block limit');
    write(`${directory}/items/${item.id}.png`, bytes);
    // Traits are optional; the selected kit's human-readable traits remain in the private folder.
    const index = Number(item.variant) - 1;
    const values = example.id === 'frog-kiln' ? assignment.TRAITS[index] : [assignment.VARIANT_NAMES[index], ...assignment.TRAITS[index]];
    const names = example.id === 'frog-kiln' ? ['Glaze', 'Crack'] : ['Company', 'Ink', 'Series'];
    const traits = names.flatMap((trait, i) => values[i] ? [{ trait, value: values[i] }] : []);
    items.push({ id: Number(item.id), imageSha256: sha256(bytes), traits });
    salts.push(`0x${randomBytes(32).toString('hex')}`);
    sizes.push(BigInt(bytes.length));
  }
  write(`${directory}/items/traits.json`, json(items.map(item => ({ id: String(item.id), attributes: item.traits.map(t => ({ trait_type: t.trait, value: t.value })) }))));
  // Each item's attributes as the collection's tokenJSON writes one (BoxMetadataTable `attributes`), for the offline lives.
  write(`${directory}/attributes.json`, json(Object.fromEntries(items.map(item => [String(item.id), item.traits.map(t => `{"trait_type":"${t.trait}","value":"${t.value}"}`)]))));
  const artState = { items, salts, problems: [] };
  // Hidden art's table is sorted (create-model `commitArt`): it never tells which id holds which traits.
  const commitment = commitArt(artState, 'hidden');
  assert.ok(commitment, 'invalid kit art');
  const table = metadataTableHex('', commitment.traitTypes);
  assert.ok(table, 'invalid kit metadata table');
  const reveal = revealFile({ collectionName: example.name, collectionSymbol: example.ticker }, artState, commitment);
  write(`${directory}/reveal.json`, reveal.text);
  const entries = JSON.parse(reveal.text).items;
  const tree = buildBoxTree(entries.map(item => boxLeaf({ ...item, id: Number(item.id), traitsPacked: BigInt(item.traitsPacked) }, items.length)), items.length);
  // Contract harness reads one proof by the drawn id, without exposing any item in a public fixture.
  write(`${directory}/proofs.json`, json(Object.fromEntries(entries.map(item => [item.id, tree.proof(Number(item.id))]))));
  const total = sizes.reduce((a, b) => a + b, 0n);
  write(`${directory}/size-report.json`, json({ items: String(items.length), minPngBytes: String(sizes.reduce((a, b) => a < b ? a : b)),
    maxPngBytes: String(sizes.reduce((a, b) => a > b ? a : b)), totalPngBytes: String(total), meanPngBytesFloor: String(total / BigInt(items.length)),
    revealFileBytes: String(Buffer.byteLength(reveal.text)), perItemBytes: sizes.map(String) }));
  const art = { metadataTable: table, revealRoot: commitment.revealRoot, generatorHash: zeroHash, revealListId: zeroHash };
  write(`${directory}/commitments.json`, json(art));
  return { directory: relative(ROOT, directory), art };
}

/** Same order as eachCommittedPicture: logo, collection cover, then distinct item hashes sorted lexically. */
export function* hiddenPictures(example, directory) {
  supported(example);
  const local = privateDirectory(directory);
  for (const [role, file] of [['logo', example.logo], ['collection cover', example.contents.art.source]]) {
    const bytes = readFileSync(resolve(ROOT, file));
    assert.ok(bytes.length <= 1048576, 'public picture exceeds the raw-block limit');
    yield { role, sha256: sha256(bytes), bytes };
  }
  const reveal = JSON.parse(readFileSync(`${local}/reveal.json`, 'utf8'));
  const byHash = new Map(reveal.items.map(item => [item.imageSha256, item.id]));
  for (const [hash, id] of [...byHash].sort(([a], [b]) => a.localeCompare(b))) {
    const bytes = readFileSync(`${local}/items/${id}.png`);
    assert.equal(sha256(bytes), hash, 'private item changed after commitment');
    yield { role: 'item', sha256: hash, bytes };
  }
}

/** Reuses the Create download formatter byte-for-byte; its embedded hidden pictures make this file private. */
export function writeHiddenSettings(example, local, spec) {
  const directory = privateDirectory(local.directory);
  assert.equal(spec.revealRoot, local.art.revealRoot, 'settings must bind the saved reveal');
  assert.equal(spec.revealListId, zeroHash, 'hidden reveal list must stay private');
  const frame = boxSpecFrame(spec, { pricing: {}, listings: [] });
  const filename = `${directory}/${frame.name}`;
  const fd = openSync(filename, 'wx', 0o600);
  try {
    writeFileSync(fd, frame.head);
    let first = true;
    for (const picture of hiddenPictures(example, local.directory)) {
      writeFileSync(fd, picturePart(picture, first)); first = false;
    }
    writeFileSync(fd, frame.tail);
  } finally { closeSync(fd); }
  const encoded = encodeBoxSpecV2(spec);
  write(`${directory}/contract.json`, json({ encoded, specHash: keccak256(encoded) }));
  return relative(ROOT, filename);
}
