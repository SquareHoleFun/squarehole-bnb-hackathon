/**
 * SH-251: the picture of a box, for ANY box from its settings: the general box of the explainer's Basics 5 drawn with
 * the fixed fee map of How it works 1 (docs/marketing/explainers/compose/feemap.mjs on the landing branch). Pure: no
 * React, no DOM. It says where every part sits, what it shows (labels, numbers, the station of each side's choice) and
 * which control it is (id, accessible name, hit areas); a component draws it.
 *
 * One layout for every box (the fee map's rule): the buys lane comes in from the top left, the sells lane from the top
 * right, the token floats over the hole, the box's front shows the raise, the price coin and the deadline; the creator
 * stands left of the box, the holders right; each side's fee falls into its tray of 15 (10, 2 and 3), its 10 run down
 * to the station of that side's choice, its 2 to the pool, its 3 to Square Hole's mark between the trays.
 *
 * Used by Create today (create/picture/picture-input.ts derives the input from the draft) and meant for the box page
 * later (an input derived from a box's spec). The payout window of the next release has a seam here:
 * `PictureInput.holderWindow`, a ready label the station's tag then shows (null today).
 */
import type { FeeChoice } from '../create/v2/recipes';
import { raiseText, percentText, shortText } from './amounts';
import { PICK_PARTS, POOL_PARTS, PARTS, SQUARE_HOLE_PARTS, type FeeSide, type SimTotals } from './fee-split';
import { HOLDERS_SHARE, PART_WHY, PICTURE_WORDS, pictureWords } from './picture-words';

export type Side = FeeSide;
export const SIDES: readonly Side[] = Object.freeze(['buyers', 'sellers']);

/** The parts that are controls, in reading order; each opens the sheet of the same id. */
export type PartId = 'buyers' | 'token' | 'contents' | 'sellers' | 'creator' | 'raise' | 'price' | 'holders' | 'mark' | 'pool';
export const PART_ORDER: readonly PartId[] = Object.freeze(['buyers', 'token', 'contents', 'sellers', 'creator', 'raise', 'price', 'holders', 'mark', 'pool']);

export type ContentsKind = 'token' | 'collection' | 'shop';
/** A station's drawing: a template icon's id (brand/template-icons.tsx) or the picture's own padlock. */
export type StationIcon = 'creator' | 'burn' | 'liquidity' | 'holders' | 'collection' | 'collection-burn' | 'pile' | 'shop' | 'alchemist-pile' | 'lock';

export interface SideInput {
  /** The side's choice as the site reads it (recipes.ts `choiceOf`), null when it is no choice. */
  readonly choice: FeeChoice | null;
  /** Its name as the site says it (recipes.ts `choiceLabel`: "Buy back and burn KITE", "Lock ETH"). */
  readonly label: string;
  /** What else the choice carries, ready to show ("ETH", "KITE · Keep", "2x"); null for none. */
  readonly tag: string | null;
  /** Items whose share in the vault buys back and burns (the station draws a collection that burns). */
  readonly insideBurns: boolean;
  /** The box cannot take this choice now: the site's own check names it (v2Issues). */
  readonly warn: boolean;
  /** That check's own line, in the steps' words, when `warn` (it joins the side's description). */
  readonly issue: string | null;
  /**
   * The steps' own words for the side's choice where the payout is in the box's token (OverviewV2 `sideText`: "To
   * holders · in ETH · holders claim KITE"), so a line of "What happens" never reads as if the price coin were paid;
   * null where the choice's name says it.
   */
  readonly ledgerLabel: string | null;
}

export interface PictureInput {
  readonly ticker: string;
  readonly price: { readonly symbol: string; readonly decimals: number; readonly raise: bigint };
  readonly deadlineDays: number;
  /** Null: nothing chosen yet (the steps' "Pick what's in the box"). */
  readonly contents: ContentsKind | null;
  readonly pile: boolean;
  /** A collection's item count when its art is in, else null. */
  readonly items: number | null;
  readonly buyers: SideInput;
  readonly sellers: SideInput;
  /** Eating the price coin burns it (a checked burn) rather than locking it. */
  readonly eatBurns: boolean;
  /** Seam for the next release: the holder payout window as a label ("6 hours"); null until that release. */
  readonly holderWindow: string | null;
  /** A run of "What happens", or null before one. */
  readonly totals: SimTotals | null;
}

export interface Rect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
/**
 * A control of the picture: its name holds the words the control shows (WCAG 2.5.3); its description what sits beside
 * it as plain text (a side's pick, tag, number and issue; the pool's and Square Hole's number; the box's item count).
 * A side's pick ("Buy back and burn KITE") is plain text outside the control, never inside it or in its name.
 */
export interface PicturePart { readonly id: PartId; readonly name: string; readonly description: string | null; readonly hit: readonly Rect[] }
export interface TrayCell { readonly role: 'pick' | 'pool' | 'mark'; readonly x: number; readonly w: number }
export interface SidePaths { readonly lane: string; readonly drop: string; readonly pick: string; readonly pool: string; readonly mark: string }
export interface SideView {
  readonly side: Side;
  readonly tray: { readonly x0: number; readonly x1: number; readonly cells: readonly TrayCell[] };
  readonly stationX: number;
  readonly icon: StationIcon | null;
  readonly label: readonly string[];
  readonly tag: string | null;
  readonly number: string;
  readonly warn: boolean;
  readonly paths: SidePaths;
  /** The visitor's spot and the fee coin's spot on this side. */
  readonly visitorX: number;
  readonly feeX: number;
}

export interface BoxPicture {
  readonly width: number;
  readonly height: number;
  readonly parts: readonly PicturePart[];
  readonly ticker: string;
  readonly contents: { readonly kind: ContentsKind | null; readonly pile: boolean; readonly items: string | null; readonly name: string };
  readonly front: { readonly raise: string; readonly symbol: string; readonly deadline: string };
  readonly lit: { readonly creator: boolean; readonly holders: boolean };
  readonly sides: Readonly<Record<Side, SideView>>;
  readonly pool: { readonly number: string };
  readonly mark: { readonly number: string };
}

/** A side's lines under its station, at most two (a long pick on a phone stays inside the picture). */
const LABEL_CHARS = 18;

/* ── The fixed layout (one viewBox for every box; the component scales it) ─────────────────────────────────────── */
export const LAYOUT = Object.freeze({
  width: 400,
  height: 468,
  box: Object.freeze({ l: 92, r: 308, top: 110, face: 136, bottom: 222 }),
  hole: 'M171 114 H229 L237 131 H163 Z',
  token: Object.freeze({ x: 200, y: 66, r: 17, tickerY: 32 }),
  contents: Object.freeze({ x: 270, y: 66 }),
  front: Object.freeze({ raiseX: 128, coinX: 200, coinY: 175, deadlineX: 272 }),
  creator: Object.freeze({ x: 44, foot: 220, h: 54 }),
  holders: Object.freeze({ x: 356, foot: 222 }),
  feeY: 238,
  tray: Object.freeze({ y: 254, h: 26, buyers: [12, 190] as const, sellers: [210, 388] as const }),
  mark: Object.freeze({ x: 200, y: 267, size: 19 }),
  pool: Object.freeze({ x0: 158, x1: 242, y0: 304, y1: 346 }),
  station: Object.freeze({ y: 358, r: 27 }),
  visitor: Object.freeze({ foot: 104, h: 40, buyers: 40, sellers: 360 }),
  labelChars: LABEL_CHARS,
});

/** The tray's 15 cells grouped 10, 2 and 3 (feemap.mjs `tray15`); mirrored on the sells side, so the 3 sit by the mark. */
export function trayOf(side: Side): SideView['tray'] {
  const [x0, x1] = LAYOUT.tray[side];
  const pad = 5;
  const gap = 1.6;
  const groupGap = 6;
  const cell = (x1 - x0 - 2 * pad - 12 * gap - 2 * groupGap) / 15;
  const groups: readonly (readonly [TrayCell['role'], number])[] = side === 'buyers' ? [['pick', 10], ['pool', 2], ['mark', 3]] : [['mark', 3], ['pool', 2], ['pick', 10]];
  const cells: TrayCell[] = [];
  let x = x0 + pad;
  groups.forEach(([role, n], g) => {
    for (let i = 0; i < n; i += 1) {
      cells.push({ role, x: round(x), w: round(cell) });
      x += cell + (i < n - 1 ? gap : 0);
    }
    if (g < groups.length - 1) x += groupGap;
  });
  return { x0, x1, cells };
}

const round = (n: number): number => Math.round(n * 10) / 10;
/** The middle of a group of cells. */
function middle(cells: readonly TrayCell[], role: TrayCell['role']): number {
  const own = cells.filter((c) => c.role === role);
  const first = own[0];
  const last = own[own.length - 1];
  return first && last ? round((first.x + last.x + last.w) / 2) : 0;
}

/** Text wrapped to lines of about `chars` characters, at most three. */
export function wrap(text: string, chars: number = LAYOUT.labelChars): readonly string[] {
  const lines: string[] = [];
  for (const word of text.split(' ')) {
    const last = lines[lines.length - 1];
    if (last !== undefined && `${last} ${word}`.length <= chars) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines.slice(0, 3);
}

/** The station's drawing for a choice. */
export function iconOf(input: Pick<SideInput, 'choice' | 'insideBurns'>, eatBurns: boolean): StationIcon | null {
  switch (input.choice) {
    case 'keep': return 'creator';
    case 'burn': return 'burn';
    case 'grow': return 'liquidity';
    case 'holders': case 'holders-t': return 'holders';
    case 'items': case 'items-t': return input.insideBurns ? 'collection-burn' : 'collection';
    case 'eat': return eatBurns ? 'burn' : 'lock';
    case 'pile': return 'pile';
    case 'shop': return 'shop';
    case 'alchemist': return 'alchemist-pile';
    default: return null;
  }
}

const isHolders = (choice: FeeChoice | null): boolean => choice === 'holders' || choice === 'holders-t';

/**
 * A part's (?) lines for this box. The holders' "The token’s holders share these." only where a side's choice is To
 * holders (in the price coin or the box coin); in any other box the holders share no fees and the line would be untrue.
 * The same for the contents' second line (below).
 */
export function whyOf(id: PartId, input: Pick<PictureInput, 'buyers' | 'sellers' | 'contents' | 'pile'>): readonly string[] {
  if (id === 'holders') return SIDES.some((side) => isHolders(input[side].choice)) ? [...PART_WHY.holders, HOLDERS_SHARE] : PART_WHY.holders;
  // SH-254: "After graduation, tokens can be exchanged for an item or a slice of the pile." only where the box holds
  // something to exchange them for (a collection, a shop or a coin pile); a token-only box has neither.
  if (id === 'contents') return input.contents === 'collection' || input.contents === 'shop' || input.pile ? PART_WHY.contents : PART_WHY.contents.slice(0, 1);
  return PART_WHY[id];
}

/** Per trade before a run (the share of the traded amount), the run's own amounts after one. */
function numberOf(totals: SimTotals | null, decimals: number, part: bigint, amount: (t: SimTotals) => bigint): string {
  if (totals === null || totals.trades === 0) return percentText(part, PARTS * 100n);
  return shortText(amount(totals), decimals);
}

function sideView(side: Side, input: PictureInput): SideView {
  const own = input[side];
  const tray = trayOf(side);
  const x = middle(tray.cells, 'pick');
  const pool = middle(tray.cells, 'pool');
  const mark = middle(tray.cells, 'mark');
  const { tray: t, station, pool: p, box, mark: m, visitor } = LAYOUT;
  const feeX = side === 'buyers' ? 150 : 250;
  const poolTo = side === 'buyers' ? 178 : 222;
  const bottom = t.y + t.h;
  const tag = isHolders(own.choice) && input.holderWindow ? [own.tag, input.holderWindow].filter(Boolean).join(' · ') : own.tag;
  const warn = own.warn || own.choice === null;
  return {
    side,
    tray,
    stationX: x,
    icon: iconOf(own, input.eatBurns),
    label: wrap(own.choice === null ? PICTURE_WORDS.noChoice : own.label),
    tag,
    number: warn ? '' : numberOf(input.totals, input.price.decimals, PICK_PARTS, (s) => s[side]),
    warn,
    visitorX: visitor[side],
    feeX,
    paths: {
      lane: side === 'buyers' ? 'M70 96 C 112 98, 138 118, 166 126' : 'M330 96 C 288 98, 262 118, 234 126',
      drop: `M${feeX} ${box.bottom - 6} L ${feeX} ${t.y + t.h / 2}`,
      pick: `M${x} ${bottom} V ${station.y - station.r - 2}`,
      pool: `M${pool} ${bottom} C ${pool} ${bottom + 14}, ${poolTo} ${p.y0 - 14}, ${poolTo} ${p.y0 + 1}`,
      mark: `M${mark} ${t.y + t.h / 2} L ${m.x} ${m.y}`,
    },
  };
}

/** A side's description: what sits beside it as plain text: its pick, what the pick carries, its number, its issue. */
const describe = (view: SideView, issue: string | null): string =>
  [view.label.join(' '), view.tag, view.number || null, view.warn ? issue : null].filter(Boolean).join(' · ');

function kindName(input: PictureInput): string {
  if (input.contents === 'collection') return PICTURE_WORDS.kindCollection;
  if (input.contents === 'shop') return PICTURE_WORDS.kindShop;
  if (input.contents === 'token') return input.pile ? `${PICTURE_WORDS.kindToken} · ${PICTURE_WORDS.kindPile}` : PICTURE_WORDS.kindToken;
  return PICTURE_WORDS.contents;
}

/** The picture of one box. */
export function pictureOf(input: PictureInput): BoxPicture {
  const { box, contents, creator, holders, tray, mark, pool, station, visitor, front } = LAYOUT;
  const ticker = input.ticker.trim() || PICTURE_WORDS.token;
  const raise = raiseText(input.price.raise, input.price.decimals);
  const sides = { buyers: sideView('buyers', input), sellers: sideView('sellers', input) };
  const sideHit = (side: Side): Rect[] => {
    const [x0, x1] = tray[side];
    const v = sides[side];
    const vx = visitor[side];
    return [
      { x: vx - 30, y: 56, w: 60, h: 90 },
      { x: x0 - 2, y: tray.y - 4, w: x1 - x0 + 4, h: tray.h + 8 },
      { x: v.stationX - 64, y: station.y - station.r - 16, w: 128, h: 112 },
    ];
  };
  const decimals = input.price.decimals;
  const poolNumber = numberOf(input.totals, decimals, POOL_PARTS, (t) => t.pool);
  const markNumber = numberOf(input.totals, decimals, SQUARE_HOLE_PARTS, (t) => t.squareHole);
  const items = input.contents === 'collection' && input.items !== null ? input.items.toLocaleString('en-US') : null;
  const parts: Record<PartId, PicturePart> = {
    buyers: { id: 'buyers', name: pictureWords.sideName('buyers'), description: describe(sides.buyers, input.buyers.issue), hit: sideHit('buyers') },
    sellers: { id: 'sellers', name: pictureWords.sideName('sellers'), description: describe(sides.sellers, input.sellers.issue), hit: sideHit('sellers') },
    token: { id: 'token', name: input.ticker.trim() ? pictureWords.tokenName(ticker) : PICTURE_WORDS.token, description: null, hit: [{ x: 150, y: 8, w: 100, h: 84 }] },
    contents: { id: 'contents', name: pictureWords.contentsName(kindName(input)), description: items, hit: [{ x: contents.x - 26, y: 36, w: 70, h: 60 }, { x: box.l + 18, y: box.top, w: box.r - box.l - 36, h: box.face - box.top }] },
    creator: { id: 'creator', name: PICTURE_WORDS.creator, description: null, hit: [{ x: creator.x - 32, y: 158, w: 64, h: 90 }] },
    raise: { id: 'raise', name: pictureWords.raiseName(raise, input.price.symbol, input.deadlineDays), description: null, hit: [{ x: box.l + 4, y: box.face + 6, w: 66, h: 74 }, { x: box.r - 70, y: box.face + 6, w: 66, h: 74 }] },
    price: { id: 'price', name: pictureWords.pricedIn(input.price.symbol), description: null, hit: [{ x: front.coinX - 30, y: box.face + 6, w: 60, h: 80 }] },
    holders: { id: 'holders', name: PICTURE_WORDS.holders, description: null, hit: [{ x: holders.x - 36, y: 172, w: 72, h: 76 }] },
    mark: { id: 'mark', name: PICTURE_WORDS.squareHole, description: markNumber, hit: [{ x: mark.x - 22, y: mark.y - 14, w: 44, h: 52 }] },
    pool: { id: 'pool', name: PICTURE_WORDS.pool, description: poolNumber, hit: [{ x: pool.x0 - 6, y: pool.y0 - 6, w: pool.x1 - pool.x0 + 12, h: 92 }] },
  };
  const choices = [input.buyers.choice, input.sellers.choice];
  return {
    width: LAYOUT.width,
    height: LAYOUT.height,
    parts: PART_ORDER.map((id) => parts[id]),
    ticker,
    contents: { kind: input.contents, pile: input.contents === 'token' && input.pile, items, name: kindName(input) },
    front: { raise, symbol: input.price.symbol, deadline: String(input.deadlineDays) },
    lit: {
      creator: choices.includes('keep'),
      holders: choices.some(isHolders) || input.sellers.choice === 'shop',
    },
    sides,
    pool: { number: poolNumber },
    mark: { number: markNumber },
  };
}

/**
 * One line of "What happens": where an amount went (`raw`, in the price coin's smallest unit), and its share of what was
 * traded. A side the box cannot take keeps its line, marked `warn`, so the lines and the carried remainders always add
 * up to the fee shown.
 */
export interface LedgerRow {
  readonly key: string;
  readonly icon: StationIcon | 'pool' | 'mark' | null;
  readonly label: string;
  readonly raw: bigint;
  readonly amount: string | null;
  readonly share: string | null;
  readonly warn: boolean;
}

/** The run's lines: each side's choice (one line when both sides go to the same place), the pool, Square Hole. */
export function ledgerOf(input: PictureInput): readonly LedgerRow[] {
  const totals = input.totals;
  const decimals = input.price.decimals;
  const run = totals !== null && totals.trades > 0;
  const row = (key: string, icon: LedgerRow['icon'], label: string, raw: bigint, warn = false): LedgerRow => ({
    key, icon, label, raw, amount: run ? shortText(raw, decimals) : null, share: run && totals ? percentText(raw, totals.traded) : null, warn,
  });
  const labelOf = (side: Side): string => {
    const own = input[side];
    if (own.choice === null) return PICTURE_WORDS.noChoice;
    return own.ledgerLabel ?? (own.tag ? `${own.label} · ${own.tag}` : own.label);
  };
  const warnOf = (side: Side): boolean => input[side].warn || input[side].choice === null;
  const rows: LedgerRow[] = [];
  if (!warnOf('buyers') && !warnOf('sellers') && labelOf('buyers') === labelOf('sellers')) {
    rows.push(row('buyers', iconOf(input.buyers, input.eatBurns), labelOf('buyers'), totals ? totals.buyers + totals.sellers : 0n));
  } else {
    for (const side of SIDES) rows.push(row(side, iconOf(input[side], input.eatBurns), labelOf(side), totals ? totals[side] : 0n, warnOf(side)));
  }
  rows.push(row('pool', 'pool', PICTURE_WORDS.pool, totals ? totals.pool : 0n));
  rows.push(row('mark', 'mark', PICTURE_WORDS.squareHole, totals ? totals.squareHole : 0n));
  return rows;
}
