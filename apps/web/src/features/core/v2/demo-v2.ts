/**
 * The Demo v2 boxes (mock data, labelled Demo; M1-53-b): one box of each closing case, so the box page can be seen
 * before any v2 box exists. Glass Marbles is past its deadline with the curve open (closable by `fail()`), Brass Keys
 * is still closed 15 days after its open (its texts never arrived; closable by `failClosed()`), Felt Hats is closed and
 * pays its closing price in USDC, and Cork Boats has 21 days to go. Invented addresses (`0xde02…`) on the local demo
 * chain, times counted from the page's load, amounts raw bigint in each box's own pricing token. They open by link
 * only in wave 1: the feed shows v2 boxes once the indexer's v2 cards exist (wave 2).
 *
 * "Close box" on the Demo sends nothing: it marks the box closed in this tab (not kept after a reload).
 */
import { DEMO_CHAIN_ID, type Address } from '@squarehole/domain';
import { useSyncExternalStore } from 'react';
import { formatBoxId } from '../../boxes/box-id';
import type { BoxRecord, BoxState, DemoBoxArt, DemoBoxFigures } from '../../boxes/box-model';
import type { BoxV2Facts, ClosingFacts, PricingTokenV2 } from './box-v2';

const DAY = 86_400n;
const HOUR = 3_600n;
const E18 = 10n ** 18n;
const address = (role: '7' | 'b' | 'c', n: number): Address => `0xde02${role}${'0'.repeat(31)}${n.toString(16).padStart(4, '0')}` as Address;

/** The Demo release's T implementation (invented): every Demo v2 box's T is its clone. */
export const DEMO_V2_IMPLEMENTATION: Address = '0xde0200000000000000000000000000000000c10e';
export const DEMO_V2_TOKENS = Object.freeze({ marbles: address('7', 1), keys: address('7', 2), hats: address('7', 3), boats: address('7', 4) });

const ETH: PricingTokenV2 = { symbol: 'ETH', decimals: 18, address: null };
const LINK: PricingTokenV2 = { symbol: 'LINK', decimals: 18, address: '0xde02000000000000000000000000000000001111' };
const USDC: PricingTokenV2 = { symbol: 'USDC', decimals: 6, address: '0xde02000000000000000000000000000000002222' };

interface DemoV2Spec {
  readonly slug: keyof typeof DEMO_V2_TOKENS;
  readonly name: string;
  readonly ticker: string;
  readonly items: bigint;
  readonly noun: string;
  readonly line: string;
  readonly state: BoxState;
  readonly pricing: PricingTokenV2;
  readonly figures: DemoBoxFigures;
  readonly art: DemoBoxArt;
  readonly tipMaxQ: bigint;
  /** Seconds from now: the open, and the deadline (null: the gate still holds). */
  readonly openIn: bigint;
  readonly deadlineIn: bigint | null;
  /** What the closing range holds once closed (the curve's P and the held money, less the tip). */
  readonly closing: ClosingFacts;
  /** Closed already: how long ago. */
  readonly closedAgo?: bigint;
}

const SPECS: readonly DemoV2Spec[] = [
  {
    slug: 'marbles',
    name: 'Glass Marbles',
    ticker: 'MRBL',
    items: 80n,
    noun: 'marbles',
    line: '80 glass marbles in eight colours.',
    state: 'bonding',
    pricing: ETH,
    figures: { progressBps: 4_100, retained: '1.72486183485', target: '4.206980085', price: '0.0042', volume24h: '0', reserved: 11n, outside: 0n, deadlineDays: 30 },
    art: { cover: 'cover-claims-desk-glass', sealed: 'sealed-glass', toyBlocks: false },
    tipMaxQ: 10n ** 15n,
    openIn: -(30n * DAY + 3n * HOUR),
    deadlineIn: -3n * HOUR,
    closing: { pInRange: 1_723_861_834_850_000_000n, tOutstanding: 410_123_456n * E18, tip: 10n ** 15n },
  },
  {
    slug: 'keys',
    name: 'Brass Keys',
    ticker: 'KEYS',
    items: 40n,
    noun: 'keys',
    line: '40 brass keys, each for one door.',
    state: 'upcoming',
    pricing: LINK,
    figures: { target: '250', upcomingText: 'waiting for its texts', volume24h: '0', reserved: 0n, outside: 0n, deadlineDays: 60 },
    art: { cover: 'cover-launch-workshop-walnut', sealed: 'sealed-walnut', toyBlocks: false },
    tipMaxQ: 5n * 10n ** 16n,
    openIn: -15n * DAY,
    deadlineIn: null,
    closing: { pInRange: 11_950_000_000_000_000_000n, tOutstanding: 28_000_000n * E18, tip: 5n * 10n ** 16n },
  },
  {
    slug: 'hats',
    name: 'Felt Hats',
    ticker: 'HATS',
    items: 120n,
    noun: 'hats',
    line: '120 felt hats in four sizes.',
    state: 'failed',
    pricing: USDC,
    figures: { progressBps: 3_300, retained: '8417.5', target: '25000', volume24h: '0', reserved: 7n, outside: 0n, deadlineDays: 30 },
    art: { cover: 'cover-feed-deck-gilded', sealed: 'sealed-gilded', toyBlocks: false },
    tipMaxQ: 5_000_000n,
    openIn: -32n * DAY,
    deadlineIn: -2n * DAY,
    closing: { pInRange: 8_412_500_000n, tOutstanding: 6_123_456_789n * 10n ** 17n, tip: 5_000_000n },
    closedAgo: 2n * DAY - HOUR,
  },
  {
    slug: 'boats',
    name: 'Cork Boats',
    ticker: 'CORK',
    items: 64n,
    noun: 'boats',
    line: '64 cork boats with paper sails.',
    state: 'bonding',
    pricing: ETH,
    figures: { progressBps: 2_200, retained: '0.92553561870', target: '4.206980085', price: '0.0009', volume24h: '0.4', reserved: 5n, outside: 0n, deadlineDays: 30 },
    art: { cover: 'cover-collection-gallery-mirror', sealed: 'sealed-mirror', toyBlocks: false },
    tipMaxQ: 10n ** 15n,
    openIn: -9n * DAY,
    deadlineIn: 21n * DAY,
    closing: { pInRange: 0n, tOutstanding: 0n, tip: 0n },
  },
];

function recordOf(spec: DemoV2Spec, index: number, nowSec: bigint, closedAt: bigint | null): BoxRecord {
  const token = DEMO_V2_TOKENS[spec.slug];
  const gateOpen = spec.deadlineIn !== null;
  const at = closedAt ?? (spec.closedAgo === undefined ? null : nowSec - spec.closedAgo);
  const v2: BoxV2Facts = {
    network: 'demo',
    coordinator: address('c', index + 1),
    pricing: spec.pricing,
    openAt: nowSec + spec.openIn,
    gateOpen,
    effectiveOpenAt: gateOpen ? nowSec + spec.openIn : 0n,
    deadline: spec.deadlineIn === null ? 0n : nowSec + spec.deadlineIn,
    curve: 'open',
    failure: at === null ? null : { cause: gateOpen ? 'deadline' : 'closed-past-cap', at, closing: spec.closing },
    tipMaxQ: spec.tipMaxQ,
    tImplementation: DEMO_V2_IMPLEMENTATION,
    releaseTImplementation: DEMO_V2_IMPLEMENTATION,
  };
  return Object.freeze({
    id: formatBoxId(DEMO_CHAIN_ID, token),
    chainId: DEMO_CHAIN_ID,
    networkLabel: 'Local chain 31337',
    kind: 'new',
    name: spec.name,
    ticker: spec.ticker,
    pairAsset: spec.pricing.symbol,
    pairDecimals: spec.pricing.decimals,
    token,
    vault: address('b', index + 1),
    itemCount: spec.items,
    itemNoun: spec.noun,
    demo: true,
    featured: false,
    rehearsal: false,
    order: 0,
    market: null,
    demoState: at === null ? spec.state : 'failed',
    demoFigures: Object.freeze(spec.figures),
    art: Object.freeze(spec.art),
    line: spec.line,
    setup: 'Buyers’ and sellers’ fees buy back and burn this box’s token.',
    claims: 'none',
    spec: null,
    row: null,
    v2: Object.freeze(v2),
  });
}

/** The Demo v2 boxes at `nowSec`; `closed` holds the ids closed in this tab, with when. */
export function demoV2Boxes(nowSec: bigint, closed: ReadonlyMap<string, bigint> = new Map()): readonly BoxRecord[] {
  return SPECS.map((spec, index) => recordOf(spec, index, nowSec, closed.get(formatBoxId(DEMO_CHAIN_ID, DEMO_V2_TOKENS[spec.slug])) ?? null));
}

// ------------------------------------------------------------------------------------------------ closed in this tab

let closedInTab: ReadonlyMap<string, bigint> = new Map();
const listeners = new Set<() => void>();

/** The Demo's "Close box": nothing is sent; the box reads as closed in this tab from now on. */
export function closeDemoV2Box(id: string, nowSec: bigint): void {
  if (closedInTab.has(id)) return;
  closedInTab = new Map([...closedInTab, [id, nowSec]]);
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useDemoV2Closed = (): ReadonlyMap<string, bigint> => useSyncExternalStore(subscribe, () => closedInTab);

/** Test seam: forget what this tab closed. */
export function resetDemoV2ForTests(): void {
  closedInTab = new Map();
  listeners.forEach((listener) => listener());
}
