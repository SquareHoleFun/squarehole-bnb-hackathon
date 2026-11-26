import { readFileSync } from 'node:fs';

/** Public templates only. These texts condense each kit's README/details into the spec's 1,024-byte description. */
export const KIT_TEXT = Object.freeze({
  'dragons-hoard': "A dragon keeps nineteen coins and lets one stay. Buyers' fees go to the coin pile after graduation. Sellers' fees buy HOARD and burn it. Burn HOARD for its share of the pile, with 5% left behind. The pile starts with one seed coin. Sepolia test setup; no promise of value.",
  'one-dollar': 'One Dollar is all you need. The token is 1. One unit of the selected price coin seeds the pile. Both fee sides buy the token and burn it. Fees never add to the pile. After graduation, burn the token for its share, with nothing left behind. Sepolia test setup; no promise of value.',
  'gpu-poor': 'Too poor for a GPU, so it burns VRAM to stay warm. No collection, shop or pile. On both sides the box share of fees buys VRAM in its own pool and burns it. Sepolia test setup; the selected price coin is a test stand-in, not stock or a claim on a company.',
  'bag-holders': 'Nobody wants to be left holding the bag, so in this box the bags get the fees. 420 bags share the box share of buyers and sellers fees equally. Bags outside the box keep fees for their owners to claim. A bag inside keeps its share for whoever takes it out. Every bag has its own picture and model; traits change nothing about fees. Sepolia test setup; no promise of value.',
  'exit-liquidity': '404 exit signs, and not one of them knows the way out. Buyers fees deepen the box pool. Sellers fees go equally to the signs; the share of signs still inside buys EXIT and burns it. Every item has its own picture; traits change nothing about fees. Sepolia test setup; no promise of value.',
  'link-marines': 'These marines love their coin so much that they eat it. 420 marines, twelve roles and thirty-five squads. Both fee sides eat the price coin after graduation. Without a checked burn, eaten coins are locked out of circulation. No fees go to the marines. Pictures and squads change nothing about fees. Sepolia test setup; no promise of value.',
  'link-marines-v2': 'At mess night the General gets the same ration as the Private. 420 marines, twelve ranks and thirty-five squads. On both fee sides, ten of fifteen parts go equally to the marines in the price coin. Outside owners claim their rations. The share of marines still inside deepens the box pool. Rank and squad change nothing about fees. Royalties feed the same fee handling. Sepolia test setup; no promise of value.',
  'rent-free': 'Five hundred little houses, living Rent Free in your head. Buyers fees go to the houses outside the box; the share of houses inside buys RENT and burns it. Sellers fees buy RENT and burn it too. Rent and property tax are jokes. Nobody lives in these houses. Every item has its own picture; traits change nothing about fees. Sepolia test setup; no promise of value.',
  junkyard: 'A home for the almost. The coin is TRASH. Buyers fees go to holders. Sellers fees buy TRASH for the shop up to twice its seed; excess goes to holders. Gives and picks use TRASH; picks cost twice the give price. The Safe supplies the seed and ten starter NFTs, two from each of five Test Junk collections. Pictures show invented objects, not physical toys. The selected price coin is an unbacked Sepolia test stand-in.',
  'the-alchemist': 'Fees buy the pile coin. Buyers use The Alchemist; sellers buy LEAD and burn it. A zero-seed pile in another listed test coin keeps 5% of each share except a whole-supply exit. LEAD does not turn into metal. Resolve a mature Alchemist row for the selected price coin and pile coin. No route is presumed.',
  'frog-kiln': '420 clay toads stay wrapped until drawn. Buyers fees eat the price coin after graduation, using its checked burn. Sellers fees buy KILN for the toads outside; the share of toads inside buys KILN and burns it. Glazes and cracks change nothing about fees. Sepolia test setup; no promise of value.',
  'paper-certificates': '1,929 paper certificates stay sealed until drawn. Buyers fees buy SCRIP and burn it. Sellers fees buy SCRIP for certificates outside; the share of certificates inside buys SCRIP and burns it. Every picture shows specimen 0. Companies, ink and series change nothing about fees. These are invented certificates with no claim on metal, shares or a company. Sepolia test setup.',
  'one-collection-shop': 'A shop for one outside collection. The coin is SHOP. The creator loads ten of their own NFTs and seeds SHOP worth two sell-backs. After graduation anyone picks an NFT for twice the sell-back price, and any holder of the collection can sell one back, within weekly limits. The list is fixed: no curator and no new collections. The last NFT stays. Buyers fees go to holders. Sellers fees buy SHOP for the shop up to twice its seed; excess goes to holders. Sepolia test setup. The collection is Test Junk Bent Cans, an owner-minted test stand-in.',
  // SH-LAKE-HOUSE: the About line exactly as the design gives it (agent-examples design §2B): the label and the
  // mechanics only, since it stays public for good. No earn, yield, APY, rent income or returns (F158).
  'lake-house': 'Test coins. Mock house, not legal title. Payments go into the pile; hand in HOUSE for a share.',
  // SH-262: the one-collection shop's sentences, with four collections, one per rarity tier, on the test network.
  'card-shop': 'A shop for trading cards in four rarity tiers. The coin is CARD. The creator loads sixteen test cards, four of each tier, and seeds the shop. After graduation anyone picks a card for twice the sell-back price. Sell-backs open seven days after the box was created: then any holder of a listed card can sell one back for its tier\'s price, within weekly limits. The list is fixed: no curator and no new collections. The last card stays. Buyers fees go to holders. Sellers fees buy CARD for the shop up to twice its seed; excess goes to holders. Test network setup. The cards are owner-minted test stand-ins with our own art.',
});
/**
 * The descriptions of a kit built for BNB Chain testnet (the `bnb` profile, chain 97), where its recipe or network
 * differs from Sepolia's: the kit's own sentences, a sentence that is untrue there left out, the network named.
 * A kit without an entry here is not built for that profile.
 */
export const KIT_TEXT_BNB = Object.freeze({
  // Both fee sides To holders in the price coin (SH-261): the Burn sentences are untrue here and left out.
  'gpu-poor': 'Too poor for a GPU. No collection, shop or pile. Buyers fees go to holders. Sellers fees go to holders. BNB Chain test setup; the selected price coin is a test stand-in, not stock or a claim on a company.',
  // Rent Free's recipe is unchanged (SH-261): only the network is named.
  'rent-free': 'Five hundred little houses, living Rent Free in your head. Buyers fees go to the houses outside the box; the share of houses inside buys RENT and burns it. Sellers fees buy RENT and burn it too. Rent and property tax are jokes. Nobody lives in these houses. Every item has its own picture; traits change nothing about fees. BNB Chain test setup; no promise of value.',
  // The converter box (SH-261): The Alchemist priced in BNB, its pile in the stock stand-in; the setup sentence for
  // the Sepolia template (resolve a row, no route presumed) is left out: the route is chain 97's id 4.
  'the-alchemist': 'Fees buy the pile coin. Buyers use The Alchemist; sellers buy LEAD and burn it. A zero-seed pile in another listed test coin keeps 5% of each share except a whole-supply exit. LEAD does not turn into metal. BNB Chain test setup; no promise of value.',
});
/** Each profile's descriptions (scripts/kits/settings.mjs `--profile`). */
export const KIT_TEXTS = Object.freeze({ sepolia: KIT_TEXT, bnb: KIT_TEXT_BNB });
export const KIT_IDS = Object.freeze(Object.keys(KIT_TEXT));

// Deliberately recognizable offline slots, NEVER deployment addresses. The app uses PROBE_OWNER (address 1)
// for validation before a wallet connects. The remaining slots preserve external-asset and starter identity in
// portable specs. inventory.json records every unresolved slot. A loader MUST resolve them before Create.
const slot = suffix => `0x${'0'.repeat(32)}${suffix}`;
/**
 * The Junkyard's Sepolia stock (TA-40, `examples/boxes/junkyard/test-collections/catalog.json`): five Test Junk
 * ERC-721s, ids 1 and 2 each, all tier 0. The registry row keeps its local-life collections (`scrap-a` to `scrap-d`,
 * bound by the local fixture); on Sepolia these five keys and ids replace them. A shop row that names TA-40 keys itself
 * (the one-collection shop: `bent-cans`, ids 3 to 12) keeps its own keys and ids, on the same slots.
 */
const junk = JSON.parse(readFileSync(new URL('../../examples/boxes/junkyard/test-collections/catalog.json', import.meta.url), 'utf8'));
export const JUNKYARD_SEPOLIA_COLLECTIONS = Object.freeze(junk.collections.map(c =>
  Object.freeze({ id: c.key, tier: '0', starterIds: Object.freeze(c.items.map(item => item.id)) })));
/**
 * The card shop's stock (SH-262, `examples/boxes/card-shop/test-cards/catalog.json`): four test trading-card ERC-721s,
 * one per rarity tier (0 Common to 3 Legendary), ids 1 to 4 each. The registry row names these keys itself.
 */
const cards = JSON.parse(readFileSync(new URL('../../examples/boxes/card-shop/test-cards/catalog.json', import.meta.url), 'utf8'));
export const CARD_SHOP_COLLECTIONS = Object.freeze(cards.collections.map(c =>
  Object.freeze({ id: c.key, tier: c.tier, starterIds: Object.freeze(c.items.map(item => item.id)) })));
/** Every public test collection a shop kit may name: the Junkyard's test junk and the card shop's cards. */
export const SHOP_STOCK_COLLECTIONS = Object.freeze([...JUNKYARD_SEPOLIA_COLLECTIONS, ...CARD_SHOP_COLLECTIONS]);
export const BINDING_SLOTS = Object.freeze({
  TEST_USDC: slot('00230001'), TEST_GOLD: slot('00230002'),
  TEST_NVDA: slot('00230003'), TEST_LINK: slot('00230004'), TEST_FROG: slot('00230005'), TEST_PEPE: slot('00230006'),
  ...Object.fromEntries(JUNKYARD_SEPOLIA_COLLECTIONS.map((c, i) => [c.id, slot(`002300${11 + i}`)])),
  ...Object.fromEntries(CARD_SHOP_COLLECTIONS.map((c, i) => [c.id, slot(`002300${21 + i}`)])),
});
/**
 * A registry coin's Sepolia stand-in (TA-30). A row with a local life keeps the real coin it runs with locally (One
 * Dollar's USDC, the Junkyard's PAXG) and maps here; a Sepolia-only row (The Alchemist) already names the TEST_* key.
 * An unbound price stays in ETH with priceCoin unresolved; a separate pile carries its stand-in's offline slot.
 * Classes match the Sepolia listing presets: STABLE=3, STOCK=4, OTHER=5.
 */
const TEST_GOLD = Object.freeze({ key: 'TEST_GOLD', symbol: 'tGOLD', name: 'Test Gold stand-in', decimals: 18, class: 5 });
export const SEPOLIA_STAND_INS = Object.freeze({
  USDC: Object.freeze({ key: 'TEST_USDC', symbol: 'tUSDC', name: 'Test USDC stand-in', decimals: 6, class: 3 }),
  PAXG: TEST_GOLD, TEST_GOLD,
  NVDAon: Object.freeze({ key: 'TEST_NVDA', symbol: 'tNVDA', name: 'Test NVDA stand-in', decimals: 18, class: 4 }),
  LINK: Object.freeze({ key: 'TEST_LINK', symbol: 'tLINK', name: 'Test LINK stand-in', decimals: 18, class: 5 }),
  TEST_FROG: Object.freeze({ key: 'TEST_FROG', symbol: 'tFROG', name: 'Test Frog stand-in', decimals: 18, class: 5 }),
  TEST_PEPE: Object.freeze({ key: 'TEST_PEPE', symbol: 'tPEPE', name: 'Test PEPE stand-in', decimals: 18, class: 5 }),
});
