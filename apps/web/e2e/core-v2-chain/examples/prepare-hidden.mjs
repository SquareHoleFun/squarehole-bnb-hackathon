/** Offline test bindings only. Real creators use create-example-v2 with their reviewed chain inputs. */
import '../../../../../packages/chain/scripts/register-ts.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { toHex, zeroAddress } from 'viem';
import { loadExamples } from '../../../../../packages/box-spec/examples/v2/registry.mjs';
import { buildExampleSpec } from '../../../../../packages/chain/scripts/create-example-v2.mjs';
import { createHiddenArt, writeHiddenSettings } from '../../../../../packages/chain/scripts/lib/hidden-art.mjs';
import { ROOT } from './support.mjs';

/**
 * Contract lives that create a kit's own box from its download (ExampleLives.t.sol): Link Marines version 2 (F151).
 * The kit tooling writes the Create page's Download BoxSpec bytes (scripts/kits); the reviewed open reveal reader
 * (reveal-open-v2.ts) checks them and its checked builder prepares every reveal from the file's own list. Open art, so
 * nothing in it is secret; it shares the run's private folder, index and cleanup with the hidden kits.
 */
export const KIT_DOWNLOAD_LIVES = Object.freeze(['link-marines-v2']);

const json = value => `${JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v, 2)}\n`;
const write = (file, text) => writeFileSync(file, text, { flag: 'wx', mode: 0o600 });

/** The kit's download, its reveal calls and each marine's attributes as the collection's tokenJSON writes them. */
export async function writeKitDownload(example, directory) {
  assert.ok(KIT_DOWNLOAD_LIVES.includes(example.id) && example.contents.art.mode === 'open', 'open kit life required');
  const [{ buildKit, settingsText }, { readOpenBoxSpec }, { checkedRevealCallV2 }] = await Promise.all([
    import('../../../../../scripts/kits/settings.mjs'),
    import('../../../../../packages/chain/scripts/reveal-open-v2.ts'),
    import('../../../../../packages/chain/src/core/v2/collection-calls-v2.ts'),
  ]);
  const kit = await buildKit(example.id);
  const download = JSON.parse(settingsText(kit));
  const { spec, specHash, list, tree } = readOpenBoxSpec(download);
  // Reveal calldata names no address: the forge life sends each call to the collection it created. These stand-in roles
  // only satisfy the builder's distinct-role checks; the caller is the life's creator (OWNER, 0xA11CE).
  const role = n => toHex(n, { size: 20 });
  const from = role(0xA11CEn);
  const target = { chainId: 31337, token: role(0x7001n), coordinator: role(0x7002n), receiver: role(0x7003n), p: zeroAddress,
    vault: role(0x7004n), collection: role(0x7005n), collectionCaller: from };
  const commitment = { root: spec.revealRoot, firstId: spec.firstId, size: BigInt(spec.n) };
  const calls = list.items.map((item, i) => checkedRevealCallV2(target, BigInt(item.id), {
    traitsPacked: BigInt(item.traitsPacked), imageHash: item.imageSha256, avatarHash: item.avatarSha256,
    modelHash: item.modelSha256, salt: item.salt, proof: tree.proof(i + 1),
  }, commitment, from).data);
  mkdirSync(new URL(`${directory}/`, ROOT), { recursive: true, mode: 0o700 });
  const folder = mkdtempSync(fileURLToPath(new URL(`${directory}/${example.id}-`, ROOT)));
  write(`${folder}/download.json`, json({ format: 'squarehole.example-kit-download/1', id: example.id, specHash,
    encoded: download.encoded, revealRoot: spec.revealRoot, revealListId: spec.revealListId, calls,
    images: list.items.map(item => item.imageSha256) }));
  assert.equal(kit.art.items.length, calls.length, 'every marine has its traits');
  write(`${folder}/attributes.json`, json(Object.fromEntries(kit.art.items.map(item =>
    [String(item.id), item.traits.map(t => `{"trait_type":"${t.trait}","value":"${t.value}"}`)]))));
  return relative(fileURLToPath(ROOT), folder);
}

export async function prepareHiddenLives(directory = '.cache/hidden-art') {
  const index = {};
  for (const example of loadExamples().filter(e => e.contents.art.mode === 'hidden')) {
    const local = await createHiddenArt(example, { parentDirectory: directory });
    const { spec } = buildExampleSpec(example, { creator: toHex(0xA11CEn, { size: 20 }), factory: toHex(2n, { size: 20 }), listingId: '8', art: local.art },
      { id: 8, token: toHex(3n, { size: 20 }), decimals: 18, class: 5, kind: 1, raise: BigInt(example.raise.amount), burnSelector: '0x42966c68' }, 4206980085000000000n);
    writeHiddenSettings(example, local, spec);
    index[example.id] = local.directory;
  }
  for (const example of loadExamples().filter(e => KIT_DOWNLOAD_LIVES.includes(e.id))) index[example.id] = await writeKitDownload(example, directory);
  const file = `${directory}/lives-${randomUUID()}.json`;
  writeFileSync(new URL(file, ROOT), JSON.stringify(index, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return file;
}
function startedDirectly() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (startedDirectly()) {
  try {
    const args = process.argv.slice(2);
    assert.ok(args.length === 0 || args.length === 2 && args[0] === '--directory'
      && /^\.cache\/hidden-art\/lives-[a-zA-Z0-9]+$/.test(args[1]), 'expected run-owned --directory');
    process.stdout.write(`${await prepareHiddenLives(args[1])}\n`);
  } catch {
    console.error('Hidden kit preparation failed; the offline runner manages its private partial files.');
    process.exitCode = 1;
  }
}