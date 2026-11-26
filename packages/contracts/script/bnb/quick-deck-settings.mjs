#!/usr/bin/env node
/**
 * SH-300 (lane d): the settings folder of the new card shop box on the SECOND release, in the form card-shop.mjs reads
 * (`readSettingsDir`: card-shop-boxspec-v2.json, bindings.json, starter.json). The live Card Shop's settings, built
 * by the same kit tool (`buildKit('card-shop')`), with four changes:
 *   - its own name, ticker, words and logo (hackathon/demo-pictures/quick-deck.png, read by Create's picture reader);
 *   - the shop's `listDelay` 600 s (ten minutes; the second release's shop vault accepts it, SH-300 lane c);
 *   - the sixteen starter cards are ids 9 to 12 of each of the four live collections (free on chain 97 at block
 *     144,928,655: ids 1 to 8 are minted; the owner, the deploy wallet, mints 9 to 12 to itself first);
 *   - the factory (bindings.json) is the second release's, given with --factory once lane c has deployed it.
 * No chain read, no transaction. Run from packages/contracts:
 *
 *   node --experimental-transform-types --no-warnings=ExperimentalWarning script/bnb/quick-deck-settings.mjs \
 *     --cards deployments/bnb-testnet/97-cards.json --extras <the SECOND release's 97-extras file> \
 *     [--factory <the second release's factory>] [--listing-id <tUSDC's id in its registry, default 1>] --out <new dir>
 */
import '../../../chain/scripts/register-ts.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { ROOT } from './bnb-testnet.mjs';

const require = createRequire(join(ROOT, 'packages/chain/package.json'));
const { decodeAbiParameters, encodeAbiParameters, getAddress, keccak256 } = require('viem');
const { buildKit, settingsText, starterEntries } = await import('../../../../scripts/kits/settings.mjs');
const { specV2, artFiles, picturesV2 } = await import('../../../../scripts/kits/app.mjs');
const { encodePicture, encodeFree, FREE_FIT } = await import('../../../../scripts/kits/pictures.mjs');
const { readExampleSettings } = await import('../../../chain/scripts/create-example-v2-settings.mjs');
const { encodeBoxSpecV2 } = await import('../../../box-spec/src/generated/box-spec.v2.ts');
const { shopConfigV2Parameters } = await import('../../../chain/src/core/v2/m2-spec-v2.ts');
const { sha256Hex } = await import('../../../artwork/src/index.ts');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1]; };
for (const name of ['--cards', '--extras', '--out']) assert.ok(flag(name), `${name} is required`);

export const NAME = 'Quick Deck';
export const TICKER = 'QDECK';
export const LIST_DELAY = 600;
export const STARTER_IDS = Object.freeze(['9', '10', '11', '12']);
const CREATOR = '0x2EF9A78074bbf674bEA16f21154a30c821A3C576';
const LOGO = join(ROOT, 'hackathon/demo-pictures/quick-deck.png');
// The live Card Shop's words (scripts/kits/catalog.mjs), with this box's coin and its ten-minute wait.
const WORDS = 'A shop for trading cards in four rarity tiers. The coin is QDECK. The creator loads sixteen test cards, four of each tier, and seeds the shop. After graduation anyone picks a card for twice the sell-back price. Sell-backs open ten minutes after the box was created: then any holder of a listed card can sell one back for its tier\'s price, within weekly limits. The list is fixed: no curator and no new collections. The last card stays. Buyers fees go to holders. Sellers fees buy QDECK for the shop up to twice its seed; excess goes to holders. Test network setup. The cards are owner-minted test stand-ins with our own art.';

const cardsFile = JSON.parse(readFileSync(resolve(flag('--cards')), 'utf8'));
const extras = JSON.parse(readFileSync(resolve(flag('--extras')), 'utf8'));
const TIERS = ['common-cards', 'uncommon-cards', 'rare-cards', 'legendary-cards'];
const cards = Object.fromEntries(TIERS.map(key => [key, getAddress(cardsFile.collections[key.replace('-cards', '')])]));
const listingId = flag('--listing-id', '1');
const native = extras.listings.find(l => l.id === 0);
const usdc = extras.listings.find(l => String(l.id) === listingId);
assert.ok(native && usdc && usdc.symbol === 'tUSDC' && usdc.decimals === 6, `listing ${listingId} is tUSDC in this extras file`);
const bindings = { owner: CREATOR, nativeRaise: native.raise, priceListing: { id: listingId, token: getAddress(usdc.token), raise: usdc.raise }, collections: cards };

const kit = await buildKit('card-shop', bindings);
assert.deepEqual(kit.unresolved, [], 'every binding resolved');
let spec = { ...kit.spec, tokenName: NAME, tokenSymbol: TICKER, description: WORDS };
// The shop's wait: ten minutes.
const [shop] = decodeAbiParameters(shopConfigV2Parameters, spec.contentsParams);
assert.equal(Number(shop.listDelay), 604_800, 'the kit\'s wait is the live Card Shop\'s seven days');
spec = { ...spec, contentsParams: encodeAbiParameters(shopConfigV2Parameters, [{ ...shop, listDelay: LIST_DELAY }]) };
// The starter cards: ids 9 to 12 of each tier, in the kit's order (tier by tier), committed as the kit commits them.
const starter = starterEntries(TIERS.flatMap((key, tier) => STARTER_IDS.map(id => ({ collection: cards[key], id, tier }))));
spec = { ...spec, addOns: spec.addOns.map(addon => (addon.id === 8 ? { id: 8, params: encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint32' }], [starter[0].hash, starter.length]) } : addon)) };
// The logo, read as Create's logo field reads a file.
const env = { digest: async bytes => sha256Hex(bytes), thumbnail: async () => null, encodeCover: encodePicture, encodeFree, salt: () => `0x${'0'.repeat(64)}` };
const logo = await artFiles.readPicture(new File([readFileSync(LOGO)], 'logo.png', { type: 'image/png' }), env, 'logo', FREE_FIT);
assert.ok(!('error' in logo), `the logo: ${logo.error}`);
spec = { ...spec, coverSha256: logo.picture.sha256 };
const committed = await picturesV2.committedPictures(spec, { cover: logo.picture, collectionCover: null, page: kit.input.page, art: null }, env.digest);
assert.deepEqual(committed.missing, [], 'every committed picture in hand');
const verdict = specV2.validateBoxSpecV2(spec, { listing: kit.context.pricing });
process.stdout.write(`the spec validator: reason ${verdict.reason}${verdict.reason ? ` at ${verdict.field}` : ' (valid)'}\n`);

const text = settingsText({ ...kit, spec, pictures: committed.pictures });
const read = readExampleSettings(text);
const specHash = keccak256(encodeBoxSpecV2(read));
assert.equal(specHash, keccak256(encodeBoxSpecV2(spec)), 'the file reads back as this spec');
const factory = flag('--factory') ? getAddress(flag('--factory')) : null;
const dir = resolve(flag('--out'));
mkdirSync(dir); // a new folder only
writeFileSync(join(dir, 'card-shop-boxspec-v2.json'), text, { flag: 'wx' });
writeFileSync(join(dir, 'bindings.json'), `${JSON.stringify({ factory: factory ?? 'FILL IN: the second release\'s factory (rerun with --factory)', creator: CREATOR, specHash, ...bindings }, null, 2)}\n`, { flag: 'wx' });
writeFileSync(join(dir, 'starter.json'), `${JSON.stringify(starter.map(i => ({ collection: i.collection, id: i.id, tier: i.tier })), null, 2)}\n`, { flag: 'wx' });
process.stdout.write(`${dir}: ${NAME} (${TICKER}), listDelay ${LIST_DELAY} s, 16 starter cards (ids ${STARTER_IDS.join(', ')} per tier), logo ${logo.picture.sha256}, spec hash ${specHash}, factory ${factory ?? 'to fill'}\n`);
