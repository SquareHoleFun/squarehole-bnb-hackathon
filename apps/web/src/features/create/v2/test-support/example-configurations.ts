/**
 * Test data: the named example boxes the template row showed until the founder asked for generic templates
 * (2026-10-11). Tests build whole boxes from them (a price coin per listing class, a pile, items); no page shows them.
 */
import { INSIDE, branch, pickFor, type BranchPick, type SidePick } from '../recipes';
import { Dest, Leg } from '../spec-types';
import type { Configuration } from '../configurations';
import { newShop, type ShopChoice } from '../shop';

const only = (a: BranchPick): SidePick => ({ a, split: { kind: 'none' }, b: branch(0, 0) });
const burnBoth = { buyers: only(branch(Leg.BuyT, Dest.Eat)), sellers: only(branch(Leg.BuyT, Dest.Eat)) };
const toCreator = { buyers: only(branch(Leg.AsPaid, Dest.Creator)), sellers: only(branch(Leg.AsPaid, Dest.Creator)) };
const growBoth = { buyers: only(branch(Leg.AsPaid, Dest.Depth)), sellers: only(branch(Leg.AsPaid, Dest.Depth)) };
const itemsKeep = { buyers: pickFor('items', INSIDE.keep), sellers: pickFor('items', INSIDE.keep) };
const holdersBoth = { buyers: pickFor('holders'), sellers: pickFor('holders') };
/** SH-V21-FE13: a shop priced in gold, holders paid on both sides, two starting collections (test addresses). */
const CURIO_SHOP: ShopChoice = { ...newShop(), seed: '1000', prices: ['1', '2', '4', '8'],
  collections: [{ address: '0x00000000000000000000000000000000000000a1', tier: 0 }, { address: '0x00000000000000000000000000000000000000b2', tier: 2 }] };
export const CONFIGURATIONS: readonly Configuration[] = Object.freeze([
  { id: 'link-marines', name: 'Link Marines', ticker: 'MARINE', pricing: 'LINK', ...growBoth, royaltyBps: 250, deadlineDays: 90 },
  { id: 'depth-reward', name: 'Deep End', ticker: 'DEEP', pricing: 'USDC', ...growBoth },
  { id: 'stock-priced', name: 'GPU Poor', ticker: 'GPU', pricing: 'NVDAon', ...burnBoth },
  { id: 'gold-priced', name: 'Gold Rush', ticker: 'RUSH', pricing: 'PAXG', ...burnBoth },
  { id: 'box-token-priced', name: 'Next Stop', ticker: 'STOP', pricing: 'CHOO', ...burnBoth },
  { id: 'gas-guzzlers', name: 'Gas Guzzlers', ticker: 'GUZZ', pricing: 'ETH', ...toCreator },
  { id: 'rug-rugs', name: 'Rug Rugs', ticker: 'RUGS', pricing: 'ETH', ...toCreator, tokenOnly: true },
  { id: 'ultrasound-owls', name: 'Ultrasound Owls', ticker: 'OWL', pricing: 'ETH', ...burnBoth, hidden: true },
  { id: 'square-pegs', name: 'Square Pegs', ticker: 'PEGS', pricing: 'FIT', ...burnBoth },
  // M3-11's Demo examples: every item paid in P with Keep on both sides, and a seed-only USDC pile.
  { id: 'bag-holders', name: 'Bag Holders', ticker: 'TOTE', pricing: 'ETH', ...itemsKeep },
  { id: 'dragons-hoard', name: "Dragon's Hoard", ticker: 'HOARD', pricing: 'ETH', ...burnBoth, tokenOnly: true, pile: { coin: 'USDC', seed: '1000' } },
  { id: 'curio-corner', name: 'Curio Corner', ticker: 'CURIO', pricing: 'PAXG', ...holdersBoth, tokenOnly: true, shop: CURIO_SHOP, firstIn: '0.05' },
  // SH-V21-FE14: the same shop with its sellers' fees Into the shop up to 4x the seed (v2.1 step 7), buyers to holders.
  { id: 'scrap-shop', name: 'Scrap Shop', ticker: 'SCRAP', pricing: 'PAXG', buyers: pickFor('holders'), sellers: pickFor('shop', undefined, 4), tokenOnly: true, shop: CURIO_SHOP, firstIn: '0.05' },
]);

