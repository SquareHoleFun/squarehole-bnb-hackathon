/**
 * SH-251: the picture's input from the SAME state the six steps edit (draft.ts CreateForm, v2-draft.ts V2Choices) and
 * the SAME checks (model.ts `v2Issues`). Nothing here decides anything about a box: it reads the choices with the
 * site's own readers (recipes.ts `choiceOf`, `choiceLabel`, `payoutCoinOf`, `insideOf`, `ceilingOf`) and says where
 * each of the site's issues is fixed on the picture.
 */
import { CONTROL, CONTROL_LABEL, summaryLine, type ControlId } from '../reason-copy';
import type { CreateForm } from '../create-model';
import { V2_CONTROL, type V2Choices, type V2Issue } from '../v2/model';
import { SHOP_CONTROL } from '../v2/shop';
import { sideText } from '../v2/OverviewV2';
import { INSIDE, INSIDE_LABEL, ceilingOf, choiceLabel, choiceOf, insideOf, payoutCoinOf, type RecipeCtx, type SidePick } from '../v2/recipes';
import type { SimTotals } from '../../box-picture/fee-split';
import type { PartId, PictureInput, SideInput } from '../../box-picture/picture';

export interface PictureSource {
  readonly form: Pick<CreateForm, 'contents'>;
  readonly v2: Pick<V2Choices, 'buyers' | 'sellers' | 'deadlineDays' | 'pile' | 'shop'>;
  readonly ctx: RecipeCtx;
  readonly issues: readonly V2Issue[];
  /** A collection's item count once its art is in (draft.ts `art.items`), else null. */
  readonly items: number | null;
  readonly totals: SimTotals | null;
}

function sideInput(side: 'buyers' | 'sellers', pick: SidePick, source: PictureSource): SideInput {
  const choice = choiceOf(pick);
  const ticker = source.ctx.ticker?.trim() ?? '';
  const coin = payoutCoinOf(choice);
  const inside = insideOf(pick);
  const ceiling = ceilingOf(pick);
  const coinName = coin === 'T' ? ticker : coin === 'P' ? source.ctx.pricing.symbol : null;
  const tag = ceiling !== null ? `${ceiling}x` : coinName !== null ? [coinName, inside !== null ? INSIDE_LABEL[inside] : null].filter(Boolean).join(' · ') : null;
  const issue = source.issues.find((entry) => entry.step === 'v2-fees' && entry.control === V2_CONTROL[side]) ?? null;
  return {
    choice,
    label: choice === null ? '' : choiceLabel(choice, source.ctx),
    tag: tag === '' ? null : tag,
    insideBurns: inside === INSIDE.burn,
    warn: issue !== null,
    issue: issue ? issueLine(issue) : null,
    // Paid in the box's token: the steps' own words say what is paid in what (OverviewV2 `sideText`).
    ledgerLabel: coin === 'T' ? sideText(side, pick, source.ctx) : null,
  };
}

/** The picture of the box these choices build. */
export function pictureInputOf(source: PictureSource): PictureInput {
  const { form, v2, ctx } = source;
  const contents = form.contents === 'collection' ? 'collection' : form.contents === 'token' ? (v2.shop ? 'shop' : 'token') : null;
  return {
    ticker: ctx.ticker?.trim() ?? '',
    price: { symbol: ctx.pricing.symbol, decimals: ctx.pricing.decimals, raise: ctx.pricing.raise },
    deadlineDays: v2.deadlineDays,
    contents,
    pile: contents === 'token' && v2.pile !== null,
    items: contents === 'collection' ? source.items : null,
    buyers: sideInput('buyers', v2.buyers, source),
    sellers: sideInput('sellers', v2.sellers, source),
    eatBurns: ctx.pricing.checkedBurn === true,
    // Seam for the next release's holder payout window: its label goes here (and its control into the holders' sheet).
    holderWindow: null,
    totals: source.totals,
  };
}

/**
 * Where an issue of the steps is fixed on the picture: the sheet that holds its control; null for the Overview's own
 * issues (their controls live on the Overview, which the picture's Overview button opens and which checks them).
 */
export function partOfIssue(issue: Pick<V2Issue, 'step' | 'control'>): PartId | null {
  switch (issue.step) {
    case 'v2-basics': return issue.control === V2_CONTROL.pricing ? 'price' : 'token';
    case 'v2-contents': return 'contents';
    case 'v2-fees': return issue.control === V2_CONTROL.sellers ? 'sellers' : 'buyers';
    case 'v2-raise': return 'raise';
    case 'v2-opening': return 'creator';
    case 'v2-overview': return null;
  }
}

/**
 * SH-254: the part that holds a step's fields on the picture (a step with several parts: its first, Basics' token);
 * null for the Overview, which has no part.
 */
export function partOfStep(step: V2Issue['step']): PartId | null {
  return partOfIssue({ step, control: '' });
}

/** SH-254: a visit to the visual way that opens a part's sheet and puts focus on one of its fields (router state). */
export interface PictureVisit { readonly open: { readonly part: PartId; readonly control: string | null } }
export const isPictureVisit = (state: unknown): state is PictureVisit =>
  typeof state === 'object' && state !== null && 'open' in state && typeof (state as PictureVisit).open?.part === 'string';

const isControlId = (control: string): control is ControlId => Object.hasOwn(CONTROL_LABEL, control);

/**
 * SH-254: the visible label of each v2 field a problem can name (the legend or label the step shows, without its
 * changing part: "Seed" of "Seed · KITE"), so two problems with the same message ("Choose a fee destination.", "More
 * than 0") never share a name. Sources: V2Steps.tsx (Priced in, Pick fee), FeesStep.tsx and fee-words.ts `feeLegend`
 * (Buyers’ fees, Sellers’ fees), PileStep.tsx, ShopStep.tsx, OverviewV2.tsx (Curator, Starter items).
 */
const V2_LABEL: Readonly<Record<string, string>> = {
  [V2_CONTROL.pricing]: 'Priced in',
  [V2_CONTROL.buyers]: 'Buyers’ fees',
  [V2_CONTROL.sellers]: 'Sellers’ fees',
  [V2_CONTROL.pickFee]: 'Pick fee',
  [V2_CONTROL.pile]: 'Coin pile',
  [V2_CONTROL.pileCoin]: 'Seed coin',
  [V2_CONTROL.pileSeed]: 'Seed',
  [V2_CONTROL.pileLeave]: 'Leave behind',
  [SHOP_CONTROL.seed]: 'Seed',
  [SHOP_CONTROL.tiers]: 'Give tiers',
  [SHOP_CONTROL.pick]: 'Pick',
  [SHOP_CONTROL.weekly]: 'Gives a week',
  [SHOP_CONTROL.perCollection]: 'Per collection a week',
  [SHOP_CONTROL.delay]: 'New entries wait · days',
  [SHOP_CONTROL.curator]: 'Curator',
  [SHOP_CONTROL.curatorAddress]: 'Curator address',
  [SHOP_CONTROL.collections]: 'Collections',
  [SHOP_CONTROL.curatorRow]: 'Curator',
  [SHOP_CONTROL.startersRow]: 'Starter items',
};
/** A v2 field's visible label, also for the numbered ones ("Tier 2", "Collection 3", "Starter ids 3", as their fields are named). */
export function v2Label(control: string): string | null {
  const fixed = V2_LABEL[control];
  if (fixed !== undefined) return fixed;
  const tier = /^create-v2-shop-tier-(\d+)$/.exec(control);
  if (tier?.[1] !== undefined) return `Tier ${Number(tier[1]) + 1}`;
  const ids = /^create-v2-shop-collection-(\d+)-ids$/.exec(control);
  if (ids?.[1] !== undefined) return `Starter ids ${Number(ids[1]) + 1}`;
  const collection = /^create-v2-shop-collection-(\d+)$/.exec(control);
  if (collection?.[1] !== undefined) return `Collection ${Number(collection[1]) + 1}`;
  return null;
}

/**
 * An issue as one line, named the way the steps' summaries name it ("Name: Required"), and (SH-254) a v2 field's
 * problem by its visible label the same way ("Sellers’ fees: Choose a fee destination."); the site's words only.
 */
export function issueLine(issue: Pick<V2Issue, 'control' | 'message'>, symbol?: string): string {
  // The first buy's field is named with the box's price coin on the v2 steps ("Your USDC at start", OpeningV2).
  const label = issue.control === CONTROL.firstIn && symbol ? `Your ${symbol} at start` : isControlId(issue.control) ? null : v2Label(issue.control);
  if (label === null && isControlId(issue.control)) return summaryLine({ control: issue.control, message: issue.message });
  return label === null || issue.message.toLowerCase().includes(label.toLowerCase()) ? issue.message : `${label}: ${issue.message}`;
}
