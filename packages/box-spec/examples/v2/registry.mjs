import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const raw = z.string().regex(/^(0|[1-9][0-9]*)$/);
// TEST_* are recipe binding keys for TA-30 stand-ins, not issuer symbols or deployed addresses.
const asset = z.enum(['ETH', 'USDC', 'LINK', 'NVDAon', 'PAXG', 'TEST_PEPE', 'TEST_GOLD', 'TEST_FROG']);
// The curator is the creator, or 'none': ShopConfigV2.curator is then the zero address, a fixed list nobody can add to
// (IShopVaultV2.sol, "Initial curator, or zero for a fixed list"; SH-ONE-COLLECTION-SHOP).
const shop = z.strictObject({
  seedT: raw, givePricesT: z.array(raw).length(4),
  pickBps: z.enum(['12500', '15000', '20000', '30000']), weeklyBps: z.enum(['500', '1000']),
  collectionBps: z.enum(['100', '250', '500']), listDelay: z.enum(['604800', '1209600', '2592000']),
  curator: z.enum(['creator', 'none']), allowanceFloor: z.literal('cheapest-active-give'),
  collections: z.array(z.strictObject({ id: z.string().regex(/^[a-z][a-z0-9-]*$/), tier: z.enum(['0', '1', '2', '3']), starterIds: z.array(raw) })).min(1).max(64),
});
/**
 * Pictures come from two reviewed places only: the shared local test pictures, or a kit's own top-level art folder
 * (`examples/boxes/<id>/art/<name>.png`, TA-24). A kit path must name the row's own kit (validateExample).
 */
export const KIT_ART = /^examples\/boxes\/([a-z]+(?:-[a-z0-9]+)*)\/art\/[a-z0-9]+(?:-[a-z0-9]+)*\.png$/;
const artPath = z.string().regex(/^(packages\/chain\/scripts\/local-art\/[a-zA-Z0-9-]+|examples\/boxes\/[a-z]+(?:-[a-z0-9]+)*\/art\/[a-z0-9]+(?:-[a-z0-9]+)*)\.png$/);
// v2.1: 'eat' eats the price coin (step 1), 'holders-t' / 'items-t' pay in the box token (step 2), 'pile' feeds the pile (step 3).
// v2.1 step 5: an inside item's Depth share goes to the box's own pool (wire value 3).
export const ITEMS_INSIDE_POLICIES = Object.freeze({ keep: 1, burn: 2, depth: 3 });
const side = z.strictObject({ choice: z.enum(['keep', 'burn', 'grow', 'holders', 'items', 'pile', 'eat', 'holders-t', 'items-t', 'shop', 'alchemist']), ceilingPreset: z.enum(['2', '4', '8']).optional(), inside: z.enum(Object.keys(ITEMS_INSIDE_POLICIES)).optional() });
/**
 * Pending steps that gate only the site: the recipe is the real one and its contract life runs offline, but the
 * browser life waits for the create flow to offer it. FE12 (the site's Pile fee choice and leave-behind preset) is
 * delivered; no example waits on it now.
 */
export const SITE_STEPS = Object.freeze(['FE12']);
/** A current contract recipe: ready, or pending only on a site step. */
export const contractReady = example => example.status === 'ready' || SITE_STEPS.includes(example.pendingStep);
/**
 * A kit row whose recipe is set but whose local contract and browser lives are not written yet (TA-24). It never runs
 * offline or in the browser until a reviewed change adds its lives and makes it `ready`.
 */
export const KIT_STEPS = Object.freeze(['EXAMPLE-LIFE']);
/** No chain row or runnable example life yet; never a site-only gate. */
export const CHAIN_STEPS = Object.freeze(['ALCHEMIST-REGISTRATION']);
export const PROPERTY_IDS = ['fee-conservation', 'graduation', 'page-state', 'own-pictures', 'creator-claim', 'holder-claim',
  'item-claim', 'supply-burn', 'pool-growth', 'royalty-creator', 'pile-pro-rata', 'failure-refunds', 'price-coin-eaten', 'shop-life'];
export const schema = z.strictObject({
  // A profile's rows live one folder down (`bnb/`), so their schema is one folder up.
  $schema: z.enum(['./schema.json', '../schema.json']), version: z.literal(1),
  id: z.string().regex(/^[a-z]+(?:-[a-z0-9]+)*$/), name: z.string().min(1).max(64),
  // BoxSpecV2 takes 1 to 11 bytes of JSON text (BoxSpecV2.sol, tokenSymbol); examples keep to 1 to 11 capitals or
  // digits inside that, and may start with a digit (One Dollar is all you need: 1, the founder's choice of 2026-10-23).
  ticker: z.string().regex(/^[A-Z0-9]{1,11}$/),
  status: z.enum(['ready', 'pending']), pendingStep: z.enum(['V21-01-EAT', 'V21-02', 'V21-03', ...SITE_STEPS, ...KIT_STEPS, ...CHAIN_STEPS]).optional(),
  pendingReason: z.string().min(1).optional(),
  template: z.strictObject({ id: z.enum(['liquidity', 'burn', 'creator', 'holders', 'collection', 'collection-burn', 'pile', 'shop', 'blank']), name: z.string().min(1) }),
  priceCoin: z.strictObject({ symbol: asset, decimals: z.enum(['6', '18']) }),
  logo: artPath,
  contents: z.strictObject({ kind: z.enum(['token', 'collection', 'pile', 'shop']), shop: shop.optional(), size: raw, label: z.string().min(1),
    art: z.strictObject({ mode: z.enum(['none', 'open', 'hidden']), source: artPath.nullable() }),
    leaveBehindBps: z.enum(['0', '500']).optional(),
    seed: z.strictObject({ symbol: asset, amount: raw }).nullable(), pickFeeBps: z.enum(['0', '100', '500', '2500']) }),
  creator: z.strictObject({ kind: z.literal('safe'), buyEthEquivalent: raw, registerHolder: z.literal(true),
    humbleCap: z.strictObject({ eth: raw, days: z.literal('30'), enforcement: z.literal('operator-policy') }).optional() }).optional(),
  raise: z.strictObject({ policy: z.literal('listing-fixed'), amount: raw.nullable() }),
  deadline: z.strictObject({ days: z.enum(['30', '60', '90', '180']) }),
  // R53 G-J (F138): royalties reach the box's inbox and are booked like the buyers' fees; no creator or pool destination.
  royalties: z.strictObject({ bps: raw, destination: z.enum(['none', 'fees']) }),
  fees: z.strictObject({ buyers: side, sellers: side }),
  life: z.enum(['graduate', 'failure']), properties: z.array(z.enum(PROPERTY_IDS)).min(1),
});
export const jsonSchema = z.toJSONSchema(schema);

/** Extra cross-field invariants supplement the portable JSON schema; never coerce monetary data. */
export function validateExample(example) {
  schema.parse(example);
  const require = (ok, message) => { if (!ok) throw new Error(`${example.id}: ${message}`); };
  const uint = value => BigInt(value) < 1n << 256n;
  require(example.status === 'pending' ? Boolean(example.pendingStep && example.pendingReason) : !example.pendingStep && !example.pendingReason, 'pending step and reason required only for pending examples');
  const alchemist = Object.values(example.fees).some(side => side.choice === 'alchemist');
  const registration = example.status === 'pending' && example.pendingStep === 'ALCHEMIST-REGISTRATION';
  require(!alchemist || (registration && example.contents.kind === 'pile' && example.contents.seed !== null
    && example.contents.seed.symbol !== example.priceCoin.symbol), 'Alchemist requires pending registration and a different pile coin');
  require(!registration || alchemist, 'registration step requires Alchemist');
  require(!alchemist || example.properties.includes('pile-pro-rata'), 'Alchemist requires pile-pro-rata');
  // TA-30 has no reviewed raise in this base. Null is unresolved, never zero or an executable amount.
  require(example.raise.amount !== null || registration, 'unresolved raise requires pending Alchemist registration');
  require(example.raise.amount === null || (uint(example.raise.amount) && BigInt(example.raise.amount) > 0n), 'raise must fit a nonzero uint256');
  require(new Set(example.properties).size === example.properties.length, 'duplicate property');
  for (const file of [example.logo, example.contents.art.source]) {
    const kit = file?.match(KIT_ART);
    require(!file || !file.startsWith('examples/') || (kit && kit[1] === example.id), 'kit art must come from the row\'s own kit');
    // The shared local art also holds Square Hole's own coin mark and collection pictures (misfits-*); no example uses them.
    require(!file || !/\/local-art\/misfits-/i.test(file), 'no example uses Square Hole\'s own art');
  }
  require(['page-state', 'fee-conservation', 'own-pictures'].every(id => example.properties.includes(id)), 'common assertions required');
  require(example.properties.includes(example.life === 'failure' ? 'failure-refunds' : 'graduation'), 'life assertion required');
  const isShop = example.contents.kind === 'shop';
  require(isShop === Boolean(example.contents.shop), 'shop settings require shop contents');
  require(isShop === example.properties.includes('shop-life'), 'shop life assertion required');
  if (isShop) {
    const s = example.contents.shop;
    require(example.creator?.kind === 'safe', 'shop creator must be a Safe');
    require(uint(example.creator.buyEthEquivalent) && BigInt(example.creator.buyEthEquivalent) > 0n && (!example.creator.humbleCap || uint(example.creator.humbleCap.eth)), 'invalid creator policy');
    const prices = s.givePricesT.map(BigInt);
    require(s.givePricesT.every(uint) && prices.every((p, i) => p > 0n && (i === 0 || p > prices[i - 1])), 'give tiers must increase');
    const cheapest = s.collections.reduce((min, c) => prices[c.tier] < min ? prices[c.tier] : min, prices[3]);
    require(uint(s.seedT) && BigInt(s.seedT) / 2n >= cheapest, 'seed must cover two cheapest listed gives');
    require(BigInt(s.collectionBps) <= BigInt(s.weeklyBps), 'collection limit exceeds weekly limit');
    require(new Set(s.collections.map(c => c.id)).size === s.collections.length, 'duplicate collection');
    const count = s.collections.reduce((sum, c) => sum + c.starterIds.length, 0);
    require(count >= 10 && count <= 10000, 'starter set requires 10..10000 items');
    for (const c of s.collections) require(c.starterIds.every(uint) && new Set(c.starterIds).size === c.starterIds.length, 'invalid starter ids');
  } else require(!example.creator, 'creator policy belongs to the shop');
  for (const [name, side] of Object.entries(example.fees)) {
    require(side.choice === 'shop' ? isShop && name === 'sellers' && Boolean(side.ceilingPreset) : side.ceilingPreset === undefined, 'shop fees require sellers, shop contents and a ceiling preset');
  }
  const collection = example.contents.kind === 'collection';
  require(collection ? BigInt(example.contents.size) > 0n && BigInt(example.contents.size) <= 10000n && example.contents.art.mode !== 'none' && example.contents.art.source !== null && example.contents.pickFeeBps !== '0'
    : example.contents.size === '0' && example.contents.art.mode === 'none' && example.contents.art.source === null && example.contents.pickFeeBps === '0', 'contents and art disagree');
  // A pile may start empty only when fees fill it: The Alchemist's conversions, or To the pile on both fee sides (Lake
  // House, SH-LAKE-HOUSE; the contract takes a zero seed, PileVaultV2.initialize). A pile that only one side feeds, or
  // none, keeps its positive seed (Dragon's Hoard, One Dollar).
  const filledByFees = alchemist || Object.values(example.fees).every(side => side.choice === 'pile');
  require(example.contents.kind === 'pile' ? example.contents.seed !== null && uint(example.contents.seed.amount) && (filledByFees || BigInt(example.contents.seed.amount) > 0n) : example.contents.seed === null, 'seed must belong to a pile; only Alchemist or a pile both fee sides feed may start empty');
  require(example.contents.kind === 'pile' || example.contents.leaveBehindBps === undefined, 'leave-behind requires a pile');
  require(!Object.values(example.fees).some(side => side.choice === 'pile') || (example.contents.kind === 'pile' && example.contents.seed.symbol === example.priceCoin.symbol), 'pile fees require the price coin pile');
  require(BigInt(example.royalties.bps) <= 1000n, 'royalty exceeds offered range');
  require(example.royalties.bps === '0' ? example.royalties.destination === 'none' : collection && example.royalties.destination !== 'none', 'royalty requires collection and destination');
  for (const side of Object.values(example.fees)) require(side.choice === 'items' || side.choice === 'items-t' ? collection && Boolean(side.inside) : !side.inside, 'inside policy requires collection items');
  require(example.properties.includes('price-coin-eaten') === Object.values(example.fees).some(side => side.choice === 'eat'), 'price-coin-eaten belongs to an eat box');
  require(example.priceCoin.decimals === (example.priceCoin.symbol === 'USDC' ? '6' : '18'), 'price coin decimals disagree');
  const names = { liquidity: 'Liquidity token', burn: 'Burn', creator: 'To the creator', holders: 'To holders', collection: 'Collection', 'collection-burn': 'Collection that burns', pile: 'Coin pile', shop: 'Shop', blank: 'Blank' };
  require(names[example.template.id] === example.template.name, 'template id/name disagree');
  return example;
}

/** Only per-example files participate; generated schema is never mistaken for an example. */
export function loadExamples(directory = new URL('./', import.meta.url)) {
  const examples = readdirSync(directory).filter(file => file.endsWith('.json') && file !== 'schema.json').sort().map(file => {
    const example = validateExample(JSON.parse(readFileSync(new URL(file, directory), 'utf8')));
    if (`${example.id}.json` !== file) throw new Error(`${file}: id must match filename`);
    return example;
  });
  if (new Set(examples.map(e => e.id)).size !== examples.length) throw new Error('duplicate example id');
  return examples;
}

/**
 * The rows each test network's build offers. Sepolia's are this folder's (what `loadExamples()` reads, unchanged).
 * BNB Chain testnet's (chain id 97, the build's `SH_TESTNET=bnb`) are `bnb/`: the same kits, with the prices and fee
 * choices of that chain's demo boxes. A row's id there is its kit's id, so a kit keeps its own art.
 */
export const PROFILES = Object.freeze({ sepolia: new URL('./', import.meta.url), bnb: new URL('./bnb/', import.meta.url) });
export function loadProfileExamples(profile = 'sepolia') {
  if (!Object.hasOwn(PROFILES, profile)) throw new Error(`unknown examples profile ${profile}`);
  const examples = loadExamples(PROFILES[profile]);
  const schemaRef = profile === 'sepolia' ? './schema.json' : '../schema.json';
  for (const example of examples) if (example.$schema !== schemaRef) throw new Error(`${example.id}: $schema must be ${schemaRef}`);
  return examples;
}
