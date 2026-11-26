/**
 * The Demo boxes (mock data, labelled Demo; BOX-INTERFACE § 7): other people's boxes in every other state, so the feed
 * and the one box template can be seen from upcoming to failed before any factory box exists. Invented addresses on
 * the local demo chain (nothing is deployed), amounts as decimal strings in each box's pair asset, our own art only
 * (closed box covers; Toy Trains' items are toy blocks drawn in SVG). The Demo Misfits come from the Demo market
 * (fit-target.ts `DEMO_FIT_TARGET`), not from here.
 *
 * F74 U5: every box raises the same, 4.206980085 ETH (box 0's); each progress is a share of it. Every Demo box is paired
 * with native ETH, the curated list's only asset: the "ETH equivalent" for another pair asset is open (S12), so no box
 * shows one. Holder claims (Pocket Stamps, Clay Pots) carry "Pending legal review" (F74 U1).
 */
import { DEMO_CHAIN_ID, type Address } from '@squarehole/domain';
import { formatBoxId } from './box-id';
import { PAIR_DECIMALS, type BoxKind, type BoxRecord, type BoxState, type DemoBoxArt, type DemoBoxFigures, type DemoPairAsset } from './box-model';

interface DemoBoxSpec {
  readonly slug: string;
  readonly name: string;
  readonly ticker: string;
  readonly kind: BoxKind;
  readonly pairAsset: DemoPairAsset;
  readonly state: BoxState;
  readonly items: bigint;
  readonly itemNoun: string;
  readonly order: number;
  readonly line: string | null;
  readonly figures: DemoBoxFigures;
  readonly art: DemoBoxArt;
  readonly setup: string;
  readonly claims: BoxRecord['claims'];
}

const BURN = 'Buyers’ and sellers’ fees buy back and burn this box’s token.';
/** The one raise every box has (F74 U5), as a decimal string in ETH. */
const RAISE = '4.206980085';

/** Invented, recognisably fake addresses: `0xde00…` + the box's number. */
const demoAddress = (n: number, role: 'token' | 'vault'): Address => `0xde00${role === 'token' ? '7' : 'b'}${'0'.repeat(31)}${n.toString(16).padStart(4, '0')}` as Address;

const SPECS: readonly DemoBoxSpec[] = [
  {
    slug: 'kites',
    name: 'Paper Kites',
    ticker: 'KITE',
    kind: 'new',
    pairAsset: 'ETH',
    state: 'upcoming',
    items: 120n,
    itemNoun: 'kites',
    order: 6,
    line: '120 paper kites in five patterns.',
    figures: { opensIn: '~2 h', target: RAISE, volume24h: '0', reserved: 0n, outside: 0n, deadlineDays: 60 },
    art: { cover: 'cover-feed-deck-gilded', sealed: 'sealed-gilded', toyBlocks: false },
    setup: BURN,
    claims: 'none',
  },
  {
    slug: 'stamps',
    name: 'Pocket Stamps',
    ticker: 'STMP',
    kind: 'existing',
    pairAsset: 'ETH',
    state: 'bonding',
    items: 64n,
    itemNoun: 'stamps',
    order: 5,
    line: '64 stamps that already exist, held in the box.',
    figures: { progressBps: 3_400, retained: '1.4303732289', target: RAISE, price: '0.00062', volume24h: '0.82', reserved: 0n, outside: 0n, deadlineDays: 90 },
    art: { cover: 'cover-collection-gallery-mirror', sealed: 'sealed-mirror', toyBlocks: false },
    setup: 'Buyers’ fees burn the token. Sellers’ fees go to token holders as claims in the token.',
    claims: 'holders',
  },
  {
    slug: 'trains',
    name: 'Toy Trains',
    ticker: 'CHOO',
    kind: 'new',
    pairAsset: 'ETH',
    state: 'graduated',
    items: 500n,
    itemNoun: 'toy blocks',
    order: 3,
    line: '500 toy blocks for one long train.',
    figures: { target: RAISE, mcap: '18.4', price: '0.0184', volume24h: '3.9', reserved: 0n, outside: 48n, deadlineDays: 30 },
    art: { cover: 'cover-control-nook-toy', sealed: 'sealed-toy', toyBlocks: true },
    setup: BURN,
    claims: 'none',
  },
  {
    slug: 'pots',
    name: 'Clay Pots',
    ticker: 'POTS',
    kind: 'new',
    pairAsset: 'ETH',
    state: 'bonding',
    items: 300n,
    itemNoun: 'pots',
    order: 2,
    line: '300 pots in six forms.',
    figures: { progressBps: 6_200, retained: '2.6083276527', target: RAISE, price: '0.0011', volume24h: '1.7', reserved: 112n, outside: 0n, deadlineDays: 30 },
    art: { cover: 'cover-launch-workshop-walnut', sealed: 'sealed-walnut', toyBlocks: false },
    setup: 'Buyers’ fees go to token holders as claims in ETH. Sellers’ fees burn the token.',
    claims: 'holders',
  },
  {
    slug: 'cans',
    name: 'Tin Cans',
    ticker: 'TINS',
    kind: 'new',
    pairAsset: 'ETH',
    state: 'failed',
    items: 50n,
    itemNoun: 'cans',
    order: 1,
    line: null,
    figures: { progressBps: 4_100, retained: '1.72486183485', target: RAISE, volume24h: '0', reserved: 9n, outside: 0n, deadlineDays: 30 },
    art: { cover: 'cover-claims-desk-glass', sealed: 'sealed-glass', toyBlocks: false },
    setup: BURN,
    claims: 'none',
  },
];

function recordOf(spec: DemoBoxSpec, index: number): BoxRecord {
  const token = demoAddress(index + 1, 'token');
  return Object.freeze({
    id: formatBoxId(DEMO_CHAIN_ID, token),
    chainId: DEMO_CHAIN_ID,
    networkLabel: 'Local chain 31337',
    kind: spec.kind,
    name: spec.name,
    ticker: spec.ticker,
    pairAsset: spec.pairAsset,
    pairDecimals: PAIR_DECIMALS[spec.pairAsset],
    token,
    vault: demoAddress(index + 1, 'vault'),
    itemCount: spec.items,
    itemNoun: spec.itemNoun,
    demo: true,
    featured: false,
    rehearsal: false,
    order: spec.order,
    market: null,
    demoState: spec.state,
    demoFigures: Object.freeze(spec.figures),
    art: Object.freeze(spec.art),
    line: spec.line,
    setup: spec.setup,
    claims: spec.claims,
    spec: null,
    row: null,
  });
}

/** The five Demo boxes, in a fixed order (the feed sorts them). */
export const DEMO_BOXES: readonly BoxRecord[] = Object.freeze(SPECS.map(recordOf));
