#!/usr/bin/env node
/**
 * SH-286: the settings sheet of a box priced in a coin launched on another platform (Flap's PILE), whose fees on both
 * sides EAT that coin (to 0xdEaD, or burned where the listing records a checked burn). Written by the site's own
 * Create code, as a person would make it on the page: GPU Poor's BNB sheet loaded (Load settings), the price coin
 * picked from the chain's listings (finishLoad's pricing), the name, ticker and words typed, "eat" picked on both
 * sides, then the page's own spec and file (buildSpecV2, boxSpecFile), checked by the release's create options.
 *
 *   node packages/chain/scripts/bnb-boxes/rail-sheet.mjs --rpc <url> --files <release folder> --token <price coin>
 *     --out <sheet> [--name <name>] [--ticker <ticker>] [--logo <png: the box's own logo>]
 *
 * The listing of `--token` must exist on the chain `--rpc` serves (on a fork: after the rehearsal's `add`); its raise
 * is the listing's.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import './ts.mjs';

process.env.SH_TESTNET = 'bnb';
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const CREATE = '../../../../apps/web/src/features/create';
const load = await import(`${CREATE}/v2/load-settings.ts`);
const options = await import(`${CREATE}/v2/create-options.ts`);
const { buildSpecV2, boxSpecFile } = await import(`${CREATE}/v2/model.ts`);
const { pickFor } = await import(`${CREATE}/v2/recipes.ts`);
const { committedPictures } = await import(`${CREATE}/v2/pictures.ts`);
const { readPicture } = await import(`${CREATE}/art-files.ts`);
const { encodePicture, encodeFree, FREE_FIT } = await import('../../../../scripts/kits/pictures.mjs');
const { commitArt } = await import(`${CREATE}/create-model.ts`);
const { sha256Hex } = await import('../../../../packages/artwork/src/index.ts');
const { createReads, createGate, releaseFiles, siteListings, loadSettings } = await import('./launch.mjs');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1]; };
for (const name of ['--rpc', '--files', '--token', '--out']) assert.ok(flag(name), `${name} is required`);
// --rule eat (default): the fees eat PILE; --rule holders: the fees pay the box's holders in PILE (no module row: it
// needs no directory row's day).
const RULE = flag('--rule', 'eat');
assert.ok(RULE === 'eat' || RULE === 'holders', '--rule eat|holders');
const NAME = flag('--name', RULE === 'eat' ? 'Pile Furnace' : 'Pile Party');
const TICKER = flag('--ticker', RULE === 'eat' ? 'FURN' : 'PARTY');
const DESCRIPTION = RULE === 'eat' ? 'Priced in PILE, a coin launched on Flap. Most of every trade\'s fee, on buys and sells, goes to the dead address in PILE, for good.'
  : 'Priced in PILE, a coin launched on Flap. Most of every trade\'s fee, on buys and sells, is paid to the holders in PILE.';
const BASE = resolve(ROOT, 'examples/boxes/gpu-poor/settings/bnb/gpu-poor-boxspec-v2.json');

const { release, extras, createOptionsText } = releaseFiles(resolve(flag('--files')));
const { client } = createReads(flag('--rpc'));
const listings = await siteListings(client, release);
const token = flag('--token');
const pricing = listings.find(l => l.token.toLowerCase() === token.toLowerCase());
assert.ok(pricing, `the chain lists no ${token}: add its listing first`);
process.stdout.write(`listing ${pricing.id}: ${pricing.symbol}, raise ${pricing.raise}, class ${pricing.class}\n`);

// Load settings, as the page does, then the page's own choices.
const read = await load.readSettingsFile(readFileSync(BASE, 'utf8'), async bytes => sha256Hex(bytes));
assert.ok(read.ok, `the base sheet reads: ${read.error}`);
const setup = await load.setupOf(read.value, listings, async () => null);
assert.ok(setup.ok, `the base sheet sets up: ${setup.error}`);
const finished = load.finishLoad(setup.value, null, listings, pricing.token, Date.now(), { salt: () => `0x${randomBytes(32).toString('hex')}` });
assert.ok(finished.ok, `the coin is taken: ${finished.error}`);
const loaded = finished.value;
const form = { ...loaded.form, name: NAME, ticker: TICKER, description: DESCRIPTION };
// --logo <png>: the box's own logo, read by Create's own picture reader (as the form's logo field reads a file);
// without it the base sheet's logo (GPU Poor's) stays.
let cover = loaded.cover;
if (flag('--logo')) {
  const file = resolve(flag('--logo'));
  const env = { digest: async bytes => sha256Hex(bytes), thumbnail: async () => null, encodeCover: encodePicture, encodeFree, salt: () => '0x0000000000000000000000000000000000000000000000000000000000000000' };
  const read = await readPicture(new File([readFileSync(file)], 'logo.png', { type: 'image/png' }), env, 'logo', FREE_FIT);
  assert.ok(!('error' in read), `the logo ${file}: ${read.error}`);
  cover = read.picture;
  process.stdout.write(`logo ${file}: ${cover.sha256 ?? ''}\n`);
}
const v2 = { ...loaded.v2, pricing: pricing.token, buyers: pickFor(RULE), sellers: pickFor(RULE) };
const spec = buildSpecV2({ form, art: loaded.art, commitment: commitArt(loaded.art, form.artMode), cover,
  collectionCover: loaded.collectionCover, page: loaded.page, owner: '0x0000000000000000000000000000000000000000', nowMs: Date.now(), v2, listings });
const gate = createGate(release, extras, createOptionsText);
const document = await options.readCreateOptions(gate.target, gate.fetch);
assert.ok(document.ok, 'the release\'s create options read');
const checked = options.checkSpec(document.document, spec);
assert.equal(checked.state, 'ok', `the release's create options: ${JSON.stringify(checked)}`);
// The pictures the spec commits (its logo: GPU Poor's, kept), as the page's file carries them.
const { pictures, missing } = await committedPictures(spec, { cover, collectionCover: loaded.collectionCover, page: loaded.page, art: loaded.art }, async bytes => sha256Hex(bytes));
assert.equal(missing.length, 0, 'every committed picture is in hand');
const text = boxSpecFile(spec, { pricing, listings }, { pictures }).parts.join('');
// The sheet must load back through the site's own Load settings unchanged (as launch.mjs reads it).
await loadSettings(text, listings, gate, '0x2EF9A78074bbf674bEA16f21154a30c821A3C576');
const out = resolve(flag('--out'));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, text);
process.stdout.write(`${out}: ${NAME} (${TICKER}), priced in ${pricing.symbol} (listing ${pricing.id}, raise ${spec.raise}), buyers ${RULE}, sellers ${RULE}\n`);
