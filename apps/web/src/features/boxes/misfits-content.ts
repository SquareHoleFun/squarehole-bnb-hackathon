/**
 * What the Misfits box shows under "What's in the box?" (F45 (2): mimic OpenSea, explain the collection, "maybe spoil a
 * few Misfits"; F47 (1): "You should not spoil the very rare items - we should show some normal ones"). Used only for a
 * market with the launch's own names (`names.kind === 'launch'`): a rehearsal shows none of it.
 *
 * - The edition size N always comes from the data (the vault, the market record), never from here: this module holds
 *   one composition table per edition size and shows the one whose rows add up to N, or none.
 *   4,200 (F35, F44; docs/research/edition-size-4200.md): Sorter 880, Coin 520, Stonk 840, Frame 880, RWA 864, Shapes
 *   about 200, one-of-ones 12, Classics 4; finishes Diamond 26, Glass 28, Gold 31 (Gold still proposed).
 *   4,269 (F49 E8: an Icons series for the last 69): the same plus Icons 69, shown as a count only (assumption to
 *   confirm: the 69 come on top of the 4,200 table).
 * - The sneak peek: one ordinary piece per family in the legend's order (Sorter, Coin, Stonk, Frame, RWA, Shapes), then
 *   two more named by family and role ("Coin · Mechanic"), from the generator's benchmark renders, under one "Examples"
 *   chip, never with a token number. None is a one-of-one, a Classic (the cast's own art: B01 The Coin, B05 The Stonk, B10 The Sorter,
 *   B12 The Collector), a Diamond (D01–D06), the Glass Shape (B16), a Gold finish or an Icon (the F47 guard below,
 *   tested). The family avatars come from the same ordinary pool.
 */

export interface FamilyRow {
  readonly id: string;
  readonly count: bigint;
  /** "~200": an approximate count (the Shapes are hand-picked). */
  readonly approx: boolean;
  /** An ordinary piece of this family as its avatar, or null (rare rows are never shown by picture). */
  readonly avatar: TeaserSlug | null;
  /** Rare rows: shown as a count with a lock, never by picture. */
  readonly sealed: boolean;
}

export interface FinishRow {
  readonly id: 'Diamond' | 'Glass' | 'Gold';
  readonly count: bigint;
}

export interface Composition {
  readonly size: bigint;
  readonly families: readonly FamilyRow[];
  readonly finishes: readonly FinishRow[];
  /** The table is an assumption still to confirm (4,269: open question 3, the 69 Icons on top of the 4,200 table). */
  readonly assumed: boolean;
}

/** The ordinary pieces the page may show (generator benchmark renders, art keys of packages/design `MISFITS_ART`). */
export type TeaserSlug = 'B02' | 'B04' | 'B06' | 'B09' | 'B13' | 'B15' | 'B17' | 'B18' | 'B19';

export interface Teaser {
  readonly slug: TeaserSlug;
  /** The tile's name: the family, or "Family · Role" for a second piece of a family. */
  readonly title: string;
  readonly family: string;
  /** The role its art carries (generator packs r4/r5), so two pieces of one family stay apart. */
  readonly role: string;
  /** Every teaser is a standard finish: the rare finishes are never shown. */
  readonly finish: 'Standard';
}

/**
 * The eight sneak-peek pieces, in order (F47: ordinary only): one per family in the legend's order, then two more named
 * by their role. B15 is the Shapes' ordinary piece (a standard finish; the Glass Shape B16 is the rare one).
 */
export const TEASERS: readonly Teaser[] = Object.freeze([
  { slug: 'B09', title: 'Sorter', family: 'Sorter', role: 'Launcher', finish: 'Standard' },
  { slug: 'B02', title: 'Coin', family: 'Coin', role: 'Launcher', finish: 'Standard' },
  { slug: 'B06', title: 'Stonk', family: 'Stonk', role: 'Explorer', finish: 'Standard' },
  { slug: 'B13', title: 'Frame', family: 'Frame', role: 'Mechanic', finish: 'Standard' },
  { slug: 'B17', title: 'RWA', family: 'RWA', role: 'Vault Keeper', finish: 'Standard' },
  { slug: 'B15', title: 'Shapes', family: 'Shapes', role: 'Creator', finish: 'Standard' },
  { slug: 'B04', title: 'Coin · Mechanic', family: 'Coin', role: 'Mechanic', finish: 'Standard' },
  { slug: 'B18', title: 'RWA · Explorer', family: 'RWA', role: 'Explorer', finish: 'Standard' },
] as const);

/**
 * Art keys that must never appear as a teaser or an avatar (F47): the twelve one-of-ones, the four Classics' art, the
 * Diamonds and the Glass Shape. Gold and the Icons have no art in this build.
 */
export const RARE_ART: ReadonlySet<string> = new Set([
  'glass-sorter', 'golden-sorter', 'the-hole', 'the-box', 'two-in-one', 'headstand', 'marble', 'origami-star', 'knitted-ball', 'spectrum-arch', 'disco-ball', 'snow-globe',
  'B01', 'B05', 'B10', 'B12',
  'D01', 'D02', 'D03', 'D04', 'D05', 'D06',
  'B16',
]);

/** The ordinary art per family (the generator's benchmark pool), for the guard. */
export const ORDINARY_POOL: ReadonlyMap<string, readonly TeaserSlug[]> = new Map<string, readonly TeaserSlug[]>([
  ['Sorter', ['B09']],
  ['Coin', ['B02', 'B04']],
  ['Stonk', ['B06']],
  ['Frame', ['B13']],
  ['RWA', ['B17', 'B18', 'B19']],
  ['Shapes', ['B15']],
]);

const family = (id: string, count: bigint, avatar: TeaserSlug | null, approx = false): FamilyRow => ({ id, count, approx, avatar, sealed: avatar === null });

const FAMILIES_4200: readonly FamilyRow[] = [
  family('Sorter', 880n, 'B09'),
  family('Coin', 520n, 'B02'),
  family('Stonk', 840n, 'B06'),
  family('Frame', 880n, 'B13'),
  family('RWA', 864n, 'B17'),
  family('Shapes', 200n, 'B15', true),
  family('One-of-ones', 12n, null),
  family('Classics', 4n, null),
];

const FINISHES: readonly FinishRow[] = [
  { id: 'Diamond', count: 26n },
  { id: 'Glass', count: 28n },
  { id: 'Gold', count: 31n },
];

/** One table per edition size. A Map: the size comes from the chain. */
const COMPOSITIONS: ReadonlyMap<bigint, Composition> = new Map<bigint, Composition>([
  [4_200n, Object.freeze({ size: 4_200n, families: Object.freeze(FAMILIES_4200), finishes: Object.freeze(FINISHES), assumed: false })],
  [4_269n, Object.freeze({ size: 4_269n, families: Object.freeze([...FAMILIES_4200, family('Icons', 69n, null)]), finishes: Object.freeze(FINISHES), assumed: true })],
]);

/** The rows add up to the size (the Shapes' "about" is the plan's 200). */
export function compositionAddsUp(composition: Composition): boolean {
  return composition.families.reduce((sum, row) => sum + row.count, 0n) === composition.size;
}

/** The composition for the edition size N the data reports, or null when no table adds up to it (then no card). */
export function compositionFor(size: bigint | null): Composition | null {
  if (size === null) return null;
  const table = COMPOSITIONS.get(size);
  return table && compositionAddsUp(table) ? table : null;
}

/** The family row of a teaser, for its sheet's "Family · 880" chip. */
export function familyCount(composition: Composition | null, familyId: string): FamilyRow | null {
  return composition?.families.find((row) => row.id === familyId) ?? null;
}

export const MISFITS_TAGLINE = 'Different shapes. Same hole.';

/** "4,200 toy blocks that don't fit, trying anyway." with N from the data. */
export const misfitsLine = (size: string): string => `${size} toy blocks that don’t fit, trying anyway.`;

/** The facts row: what every Misfit has (generator packs r4/r5). The (i) lists them. */
export const MISFIT_ROLES = Object.freeze(['Launcher', 'Vault Keeper', 'Collector', 'Explorer', 'Creator', 'Mechanic', 'Holder', 'Curator']);
export const MISFIT_ROOMS = Object.freeze(['Feed Deck', 'Launch Workshop', 'Vault Shelf', 'Portfolio Cabinet', 'Collection Gallery', 'Market Observatory', 'Control Nook', 'Claims Desk']);
export const MISFIT_SLOTS = Object.freeze(['head', 'face', 'neck', 'chest', 'waist', 'back', 'held', 'orbit']);
