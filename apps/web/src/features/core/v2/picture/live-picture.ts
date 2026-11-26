/**
 * SH-255: the box page's picture input, the second input of the shared drawing (box-picture/picture.ts; Create's is
 * create/picture/picture-input.ts). Built from the page's own snapshot (`V2Snapshot`, the feed's card for this box), so
 * the picture makes no read of its own. It says what IS and what HAPPENED: how full the raise is and how long is left,
 * or that the box graduated or closed; what each side's fees did so far, the pool, Square Hole, holders, items, the coin
 * pile and the inbox. Every figure is a field of the box API except the two computed in box-picture/live-figures.ts.
 *
 * Where the data has no figure, nothing is shown: before graduation the fees wait (the API publishes them once they
 * are split), so no fee amount shows until then; an unpublished field leaves its place empty, never zero.
 * ONE population for every fee amount (round 3, D1): a side's fee, its three parts on the stations, in its sheet and in
 * Where the fees go, the pool's and Square Hole's parts are the rule's parts of that side's COLLECTED trade fees
 * (`fees.buyersP`, `fees.sellersP`). The box's own totals (Buy-back progress, Coin pile, Eaten, the shop's rows, the
 * Safes' payouts) stay under their cards' titles in the sheets, never in an amount column: the snapshot has no booked
 * amount per destination, side and source (finding N26 on the line).
 * Pure: no React, no DOM; the site's own formatters print (stats-v2.ts, fit-format.ts, @squarehole/domain).
 */
import { formatUnits } from '@squarehole/domain';
import type { BoxRecord } from '../../../boxes/box-model';
import { formatBps, formatCount } from '../../../fit-pair/fit-format';
import type { FeeChoice } from '../../../create/v2/recipes';
import { raiseText } from '../../../box-picture/amounts';
import { DRAWING_CHARS, partsOfFee, poolCoinsOf, shortAmount, squareHolePaidOf, type FeeParts } from '../../../box-picture/live-figures';
import { pictureOf, wrap, SIDES, type BoxPicture, type ContentsKind, type PartId, type PictureInput, type Side, type SideInput, type SideView, type StationIcon } from '../../../box-picture/picture';
import { PICTURE_WORDS, pictureWords } from '../../../box-picture/picture-words';
import type { FeeChoiceV2 } from '../../../../../../../packages/indexer/src/core/v2/views-v2';
import { itemPoliciesV2 } from '../../../../../../../packages/chain/src/core/v2';
import { feeText } from '../V2BoxPage';
import type { V2Snapshot } from '../indexer-v2';
import { canStillGraduateV2, lifeStageV2, type LifeStageV2 } from '../life-state';
import { pAmountV2, tShortV2 } from '../stats-v2';
import { endsInLine } from '../v2-words';
import { BOX_PICTURE_WORDS as W } from './box-picture-words';

/** A coin by name and decimals (the pile's coin, read the way CoinPileV2 reads it). */
export interface LiveCoin { readonly symbol: string; readonly decimals: number }

export interface LiveContext {
  /** Not read by the model (every time in it is the snapshot's, chain time); callers need not pass it. */
  readonly nowSec?: bigint;
  /** Each module side checked on chain as The Alchemist (V2BoxPage `useBoxAlchemist`). */
  readonly alchemist: Readonly<Record<Side, boolean>>;
  /** The coin pile's coin, once known; null while unknown or for a box without a pile. */
  readonly pileCoin: LiveCoin | null;
  /** The page's own decision that anyone may close the box now (closeStateOf, chain time), for the hatch's words. */
  readonly closable?: boolean;
}

/** The box's front: its two columns, the raise's fill, and the words a screen reader hears for it. */
export interface LiveFront {
  /** 0 to 1: how full the raise is (1 once full); null where it is not known (unpublished), drawn as the plain front. */
  readonly fill: number | null;
  readonly left: { readonly label: string; readonly value: string; readonly sub: string };
  readonly right: { readonly kind: 'figure'; readonly label: string; readonly value: string; readonly sub: string } | { readonly kind: 'state'; readonly glyph: 'graduate' | 'closed'; readonly word: string };
  readonly name: string;
}

export interface LedgerLine {
  readonly key: string;
  readonly choice: FeeChoice | 'pool' | 'mark';
  readonly label: string;
  /** Short, in the price coin: the rule's parts of the collected fees the place takes; null for no figure yet. */
  readonly amount: string | null;
  /** "After graduation" while the fees wait; null otherwise (a place's totals are in its sheet, round 3 D3). */
  readonly note: string | null;
}

export interface LiveModel {
  readonly stage: LifeStageV2;
  readonly coin: string;
  readonly ticker: string;
  readonly decimals: number;
  readonly input: PictureInput;
  readonly front: LiveFront;
  /** Each side's whole fee and its 15 parts; null before graduation or when the API has no figure. */
  readonly fees: Readonly<Record<Side, FeeParts & { readonly fee: bigint }>> | null;
  /** What Square Hole's two Safes were paid in the price coin (a box total, shown in its sheet); null when unpublished. */
  readonly squareHolePaid: bigint | null;
  /** The words under "Buys" and "Sells": the side's fees so far, or the fee's 1% before them. */
  readonly visitor: Readonly<Record<Side, string>>;
  readonly numbers: { readonly stations: Readonly<Record<Side, string>>; readonly pool: string; readonly mark: string };
  /** Where money went: a side's routes flow, a side without fees so far stays faded. */
  readonly routes: Readonly<Record<Side, 'flow' | 'idle'>>;
  readonly poolOpen: boolean;
  readonly poolCoins: { readonly price: bigint; readonly token: bigint } | null;
  /** The token's burned total, short ("2.06M"); null for none or unpublished. */
  readonly burned: string | null;
  readonly holders: string | null;
  readonly items: { readonly count: string; readonly out: string | null } | null;
  readonly pileCoin: string | null;
  /**
   * The inbox as the page's Inbox card reads it: the coins other than the price coin it holds (null when its balances
   * are unread), whether every coin was read, and the royalties held in the price coin (null when unread).
   */
  readonly inbox: { readonly coins: number | null; readonly complete: boolean; readonly royaltyHeld: bigint | null };
  /** Each side's station drawing where the picture's own would claim more than is known (an unchecked module, an unread eat). */
  readonly icons: Readonly<Record<Side, StationIcon | null | undefined>>;
  /** Whether the side's results may be shown as its pick's: false for a module not checked as The Alchemist. */
  readonly checked: Readonly<Record<Side, boolean>>;
  readonly closable: boolean;
  /** `canStillGraduateV2`: the graduation promises ("After graduation", "Opens at graduation") show only while true. */
  readonly canGraduate: boolean;
  readonly ledger: readonly LedgerLine[];
  /** The fees line over the ledger ("0.8982 tNVDA in fees · 3 trades"); null before graduation. */
  readonly feesLine: string | null;
}

const CHOICE_OF: Readonly<Record<FeeChoiceV2, FeeChoice>> = { keep: 'keep', burn: 'burn', grow: 'grow', holders: 'holders', items: 'items', eat: 'eat', 'holders-t': 'holders-t', 'items-t': 'items-t', pile: 'pile', module: 'alchemist', shop: 'shop' };

function contentsOf(view: V2Snapshot): { readonly contents: ContentsKind; readonly pile: boolean } {
  if (view.spec.boxType === 4) return { contents: 'shop', pile: false };
  if (view.spec.boxType === 5) return { contents: 'token', pile: true };
  if (view.spec.boxType === 3 || view.spec.n === 0) return { contents: 'token', pile: false };
  return { contents: 'collection', pile: false };
}

/** A side whose items' share in the vault buys back and burns (item policy 2, Burn). */
function insideBurnsOf(view: V2Snapshot, side: Side): boolean {
  try { return itemPoliciesV2(view.spec)[side] === 2; } catch { return false; }
}

function sideInput(view: V2Snapshot, side: Side, coin: string, ticker: string, alchemist: boolean): SideInput {
  const picked = view.choices[side];
  const label = feeText(view, side, coin, ticker, alchemist);
  return {
    // A module side keeps the module's place in the ledger; its drawing and results are The Alchemist's only once checked.
    choice: picked ? CHOICE_OF[picked] : null,
    label,
    tag: null,
    insideBurns: insideBurnsOf(view, side),
    warn: false,
    issue: null,
    ledgerLabel: null,
  };
}

/** Whether the box can still graduate (life-state.ts `canStillGraduateV2`, the contract's rules with its lines). */
export { canStillGraduateV2 } from '../life-state';

/** Past its deadline by chain time: the snapshot's block time, never the browser clock (record-v2.ts phaseV2's rule). */
export const deadlinePassedV2 = (view: Pick<V2Snapshot, 'gate' | 'timestamp'>): boolean => view.gate.deadline > 0n && view.gate.deadline <= view.timestamp;
/**
 * The time left to the deadline by chain time, the same clock that decides it has passed: it only ever counts down as
 * blocks come, and reaches the deadline exactly when the page says Deadline passed.
 */
export const timeLeftV2 = (view: Pick<V2Snapshot, 'gate' | 'timestamp'>): bigint => view.gate.deadline - view.timestamp;

/** The causes as the indexer names them; a box that timed out at graduation had filled its raise. */
const FILLED_CAUSES: ReadonlySet<string> = new Set(['GraduationTimedOut']);

/** How full the raise is, where it is known: the published share, else what the box's life says; null when unknown. */
function fillOf(view: V2Snapshot, stage: LifeStageV2): number | null {
  if (stage === 'graduated' || stage === 'graduating') return 1;
  if (stage === 'failed' && ((view.failed && FILLED_CAUSES.has(view.failed.cause)) || view.closedAt > 0n)) return 1;
  const progress = view.statistics?.raiseProgress ?? null;
  return progress ? Number(progress.progressBps) / 10_000 : null;
}

/** The box's front, from the site's own rules for each moment of its life (life-state.ts, v2-words.ts). */
function frontOf(view: V2Snapshot, stage: LifeStageV2, coin: string): LiveFront {
  const raise = raiseText(view.record.raise, view.decimals);
  const plan = { label: W.raise, value: raise, sub: coin };
  const name = (left: LiveFront['left'], right: LiveFront['right']) => [`${left.label} ${left.value} ${left.sub}`, right.kind === 'figure' ? `${right.label} ${right.value} ${right.sub}` : right.word].join(' · ');
  const fill = fillOf(view, stage);
  const make = (left: LiveFront['left'], right: LiveFront['right']): LiveFront => ({ fill, left, right, name: name(left, right) });
  const deadline = { kind: 'figure' as const, label: W.deadline, value: String(view.spec.deadlineDays), sub: W.days };
  const progress = view.statistics?.raiseProgress ?? null;
  const raised = progress ? { label: W.raised, value: formatBps(Number(progress.progressBps)), sub: W.ofRaise(raise, coin) } : plan;
  switch (stage) {
    case 'graduated': return make(plan, { kind: 'state', glyph: 'graduate', word: W.graduated });
    case 'graduating': return make(plan, { kind: 'state', glyph: 'graduate', word: W.graduating });
    case 'failed': return make(plan, { kind: 'state', glyph: 'closed', word: W.closed });
    // A scheduled box can hold a start buy already: its share shows as soon as it is published.
    case 'scheduled': return make(raised, deadline);
    default: {
      if (view.gate.deadline <= 0n) return make(raised, deadline);
      // Past its deadline by chain time (the snapshot's block, as the site's close state reads it), not full and not
      // closed yet: the site's own words for it (anyone may close it now).
      if (deadlinePassedV2(view)) return make(raised, { kind: 'state', glyph: 'closed', word: W.deadlinePassed });
      // endsInLine's own count and unit ("Ends in 8 d if the curve does not fill"), its unit as a word, by chain time.
      const words = /^Ends in (\d+) ([dh]) /.exec(endsInLine(timeLeftV2(view)));
      const right = words ? { kind: 'figure' as const, label: W.endsIn, value: words[1] ?? '', sub: words[2] === 'd' ? W.days : W.hours } : deadline;
      return make(raised, right);
    }
  }
}

/** The inbox's coins other than the price coin (the price coin's royalties have their own row); null when unread. */
function inboxOf(view: V2Snapshot): LiveModel['inbox'] {
  const inbox = view.money?.inbox ?? null;
  const q = view.record.q.toLowerCase();
  const coins = inbox ? Object.entries(inbox.balances).filter(([coin, amount]) => amount > 0n && coin.toLowerCase() !== q).length : null;
  return { coins, complete: inbox ? inbox.complete : false, royaltyHeld: view.money ? view.money.owed.royaltyHeldP : null };
}

/** A figure the drawing prints, each by itself: the site's short amount, K/M/B when longer than the drawing's room. */
const drawn = (raw: bigint, decimals: number): string => { const full = pAmountV2(raw, decimals); return full.length > DRAWING_CHARS ? shortAmount(raw, decimals) : full; };

export function liveModelOf(record: BoxRecord, view: V2Snapshot, context: LiveContext): LiveModel {
  const coin = record.pairAsset;
  const ticker = record.ticker;
  const decimals = view.decimals;
  const stage = lifeStageV2(view);
  const graduated = stage === 'graduated';
  const canGraduate = canStillGraduateV2(view);
  const { contents, pile } = contentsOf(view);
  const eatBurns = view.eat?.burned ?? false;
  const input: PictureInput = {
    ticker,
    price: { symbol: coin, decimals, raise: view.record.raise },
    deadlineDays: view.spec.deadlineDays,
    contents,
    pile,
    items: contents === 'collection' ? view.spec.n : null,
    buyers: sideInput(view, 'buyers', coin, ticker, context.alchemist.buyers),
    sellers: sideInput(view, 'sellers', coin, ticker, context.alchemist.sellers),
    eatBurns,
    holderWindow: null,
    totals: null,
  };
  const p = (raw: bigint) => pAmountV2(raw, decimals);
  // Before graduation the fees wait in the box (sale fees burn): the API has no figure of them, so none shows.
  const fees = graduated && view.feesP ? { buyers: { fee: view.feesP.buyers, ...partsOfFee(view.feesP.buyers) }, sellers: { fee: view.feesP.sellers, ...partsOfFee(view.feesP.sellers) } } : null;
  const squareHolePaid = squareHolePaidOf(view.safePaid, view.record.q);
  const stats = view.statistics ?? null;
  const out = view.vaultItems ? view.vaultItems.known.filter((item) => !item.inside).length : null;
  const position = view.position && view.position.kind === 'full_range' ? view.position : null;
  const poolCoins = graduated ? poolCoinsOf(position, view.pool?.sqrtPriceX96, view.record.q, view.token) : null;
  // A module side's results and drawing are The Alchemist's only when that side is checked as The Alchemist.
  const checked = { buyers: view.choices.buyers !== 'module' || context.alchemist.buyers, sellers: view.choices.sellers !== 'module' || context.alchemist.sellers };
  // An unchecked module and an unread eat draw no station: the drawing would claim what is not known.
  const icons = { buyers: iconOverride(view, 'buyers', checked.buyers), sellers: iconOverride(view, 'sellers', checked.sellers) };

  // Where the fees go: one line per place (two sides with the same pick share one), then the pool and Square Hole; each
  // the rule's parts of the collected fees (D1).
  const ledger: LedgerLine[] = [];
  for (const side of SIDES) {
    const picked = input[side].choice;
    if (picked === null) continue;
    const same = ledger.find((line) => line.choice === picked && line.label === input[side].label);
    if (same) {
      const sum = fees ? fees.buyers.pick + fees.sellers.pick : null;
      ledger[ledger.indexOf(same)] = { ...same, key: 'both', amount: sum === null ? null : p(sum) };
      continue;
    }
    const pick = fees ? fees[side].pick : null;
    // Before graduation the fees wait: "After graduation"; never a number about the place as a whole (D3).
    ledger.push({ key: side, choice: picked, label: input[side].label, amount: pick === null ? null : p(pick), note: canGraduate ? W.afterGraduation : null });
  }
  // A closed box's pool never opens: no "Opens at graduation" there.
  ledger.push({ key: 'pool', choice: 'pool', label: PICTURE_WORDS.pool, amount: fees ? p(fees.buyers.pool + fees.sellers.pool) : null, note: canGraduate ? W.poolOpens : null });
  ledger.push({ key: 'mark', choice: 'mark', label: PICTURE_WORDS.squareHole, amount: fees ? p(fees.buyers.squareHole + fees.sellers.squareHole) : null, note: null });

  return {
    stage, coin, ticker, decimals, input,
    front: frontOf(view, stage, coin),
    fees, squareHolePaid,
    visitor: { buyers: fees ? drawn(fees.buyers.fee, decimals) : PICTURE_WORDS.fee, sellers: fees ? drawn(fees.sellers.fee, decimals) : PICTURE_WORDS.fee },
    numbers: {
      stations: { buyers: fees ? drawn(fees.buyers.pick, decimals) : '', sellers: fees ? drawn(fees.sellers.pick, decimals) : '' },
      pool: fees ? drawn(fees.buyers.pool + fees.sellers.pool, decimals) : '',
      mark: fees ? drawn(fees.buyers.squareHole + fees.sellers.squareHole, decimals) : '',
    },
    routes: { buyers: fees && fees.buyers.fee > 0n ? 'flow' : 'idle', sellers: fees && fees.sellers.fee > 0n ? 'flow' : 'idle' },
    poolOpen: graduated,
    poolCoins,
    burned: stats && stats.burnedT > 0n ? tShortV2(stats.burnedT) : null,
    holders: stats ? formatCount(stats.holderCount) : null,
    items: contents === 'collection' ? { count: formatCount(BigInt(view.spec.n)), out: out === null ? null : W.out(String(out)) } : null,
    pileCoin: pile ? context.pileCoin?.symbol ?? null : null,
    inbox: inboxOf(view),
    icons, checked,
    closable: context.closable ?? false,
    canGraduate,
    ledger,
    feesLine: fees && stats ? W.feesLine(p(fees.buyers.fee + fees.sellers.fee), coin, formatCount(stats.tradeCount)) : null,
  };
}

/** undefined: the picture's own drawing; null: none (a module not checked as The Alchemist, an eat side not read yet). */
function iconOverride(view: V2Snapshot, side: Side, checked: boolean): StationIcon | null | undefined {
  if (view.choices[side] === 'module' && !checked) return null;
  if (view.choices[side] === 'eat' && !view.eat) return null;
  return undefined;
}

/** A side's description: what sits beside it as plain text (its fees, its pick, its number). */
const describe = (view: SideView, visitor: string): string => [visitor, view.label.join(' '), view.tag, view.number || null].filter(Boolean).join(' · ');

/**
 * The shared picture of the box (pictureOf), with the page's numbers in place of a run of "What happens" and each part's
 * name and description holding the words that now sit on it or beside it.
 */
export function livePictureOf(model: LiveModel): BoxPicture {
  const base = pictureOf(model.input);
  const sideOf = (side: Side) => ({
    ...base.sides[side],
    ...(model.icons[side] !== undefined ? { icon: model.icons[side] ?? null } : {}),
    label: wrap(model.input[side].label),
    number: model.numbers.stations[side],
  });
  const sides = { buyers: sideOf('buyers'), sellers: sideOf('sellers') };
  const named = (id: PartId, name: string, description: string | null) => ({ id, name, description });
  const contentsWords = model.items ? [model.items.count, model.items.out].filter(Boolean).join(' · ') : model.pileCoin;
  const extra: Partial<Record<PartId, { name: string; description: string | null }>> = {
    buyers: named('buyers', pictureWords.sideName('buyers'), describe(sides.buyers, model.fees ? `${model.visitor.buyers} ${model.coin}` : model.visitor.buyers)),
    sellers: named('sellers', pictureWords.sideName('sellers'), describe(sides.sellers, model.fees ? `${model.visitor.sellers} ${model.coin}` : model.visitor.sellers)),
    token: named('token', pictureWords.tokenName(model.ticker), model.burned ? `${W.burned} ${model.burned} ${model.ticker}` : null),
    raise: named('raise', model.front.name, null),
    holders: named('holders', PICTURE_WORDS.holders, model.holders),
    contents: named('contents', base.parts.find((part) => part.id === 'contents')?.name ?? PICTURE_WORDS.contents, contentsWords || null),
    pool: named('pool', PICTURE_WORDS.pool, model.poolOpen ? model.numbers.pool || null : model.canGraduate ? W.poolOpens : null),
    mark: named('mark', PICTURE_WORDS.squareHole, model.numbers.mark || null),
  };
  return {
    ...base,
    parts: base.parts.map((part) => ({ ...part, ...(extra[part.id] ?? {}) })),
    sides,
    pool: { number: model.poolOpen ? model.numbers.pool : '' },
    mark: { number: model.numbers.mark },
  };
}

/** Exact amounts for the sheets, as the money cards printed them: every digit, then the coin. */
export const exactIn = (raw: bigint, decimals: number, unit: string): string => `${formatUnits(raw, decimals)} ${unit}`;
