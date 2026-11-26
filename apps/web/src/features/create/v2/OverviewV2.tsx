import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { formatUnits, type Address } from '@squarehole/domain';
import { Details } from '../../fit-pair/InfoTip';
import { EditGlyph } from '../create-parts';
import { pickedTimeText } from '../ChoiceSteps';
import type { CreateForm } from '../create-model';
import { boxStatus, type CreationPlan, type PlanBlock, type PlanStep } from './creation-plan';
import { amountText, raiseText, type SiteListing } from './listings';
import type { Played, V2Choices } from './model';
import type { AlchemistRowV21 } from '../../../../../../packages/chain/src/core/v2';
import { ALCHEMIST_WARNING, SHOP_FEES_WARNING, buyBackBurnLabel, dustText, feeClaimLine, feeInputLine, hopText, triggerText } from './fee-words';
import { INSIDE, INSIDE_LABEL, ceilingOf, choiceLabel, choiceOf, insideOf, moduleIdOf, payoutCoinOf, type FeeSide, type RecipeCtx, type SidePick } from './recipes';
import { SHOP_CONTROL, bpsPercent, curatorOf, pickPriceOf, pickText, shopConfigOf, starterItemsOf, tOf, type ShopChoice } from './shop';
import { RisksLink } from './RisksLink';
import { ChunkPart, type BoxSpecV2 } from './spec-types';
import { V2_STEPS, v2Path, type V2StepId } from './v2-steps';
import { OffMark } from './CreateOptionsLines';
import type { OverviewRow } from './create-options';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

/**
 * A side's choice, its in-vault rule, and what it is paid in: the price coin, or the box token its fees buy (v2.1). Into
 * the shop names its ceiling, with the amount once the shop's seed (`shopSeedT`, raw T) is typed.
 */
export function sideText(side: FeeSide, pick: SidePick, ctx: RecipeCtx, shopSeedT: bigint | null = null): string {
  const choice = choiceOf(pick);
  const inside = insideOf(pick);
  const ceiling = ceilingOf(pick);
  const ticker = ctx.ticker || 'the box coin';
  const input = feeInputLine(side, ticker, ctx.pricing.symbol);
  if (!choice) return `Choose a fee destination · ${input}`;
  const paid = payoutCoinOf(choice) === 'T'
    ? ` · ${input} · ${feeClaimLine(inside !== null, ticker)}`
    : ` · ${input}`;
  const room = ceiling === null ? '' : ` · ceiling ${ceiling}x the seed${shopSeedT !== null && shopSeedT > 0n ? ` (${formatUnits(shopSeedT * BigInt(ceiling), 18)} ${ctx.ticker || 'T'})` : ''}`;
  const row = choice === 'alchemist' ? ` · row ${moduleIdOf(pick)}` : '';
  return `${choiceLabel(choice, ctx)}${inside !== null ? ` · ${inside === INSIDE.burn ? buyBackBurnLabel(ticker) : INSIDE_LABEL[inside]}` : ''}${room}${row}${paid}`;
}

type Seed = { readonly listing: SiteListing; readonly amount: bigint } | null;

function stepText(step: PlanStep, listing: SiteListing, seed: Seed, ticker: string): string {
  if (step.call === 'approve') return `approve · ${amountText(step.amount ?? 0n, listing)}`;
  if (step.call === 'approveStarter') return `approve starter · ${(step.index ?? 0) + 1}`;
  if (step.call === 'loadStarter') return `load starters · page ${(step.index ?? 0) + 1}`;
  if (step.call === 'approveShopSeed') return `approve seed · ${formatUnits(step.amount ?? 0n, 18)} ${ticker}`;
  if (step.call === 'fundSeed') return `fundSeed · ${formatUnits(step.amount ?? 0n, 18)} ${ticker}`;
  if (step.call === 'complete') return 'complete · opens the box';
  if (step.call === 'approveSeed') return `approve seed · ${seed ? amountText(step.amount ?? 0n, seed.listing) : '?'}`;
  if (step.call === 'loadSeed') return `loadSeed · ${seed ? amountText(step.amount ?? 0n, seed.listing) : '?'}`;
  if (step.call === 'createBox') return `createBox${step.value ? ` · ${amountText(step.value, listing)}` : ''}${step.gasLimit ? ` · gas limit ${step.gasLimit.toLocaleString('en-US')}` : ''}`;
  return `loadChunk · ${step.part === ChunkPart.Table ? 'table' : 'texts'} ${(step.index ?? 0) + 1}`;
}

export const BLOCKED_TITLE: Readonly<Record<PlanBlock, string>> = { 'too-heavy': 'Too heavy to create', 'listing-changed': 'Price coin changed: refresh this plan', unread: 'Create waits for the chain’s figures' };

/** A Create played in the Demo: the plan, how many of its steps are in, and what it played (`stillPlayed`). */
export interface DemoRun {
  readonly plan: CreationPlan;
  readonly sent: number;
  readonly played: Played;
}

export function statusText(run: DemoRun): string {
  const status = boxStatus(run.plan, run.sent);
  if (status.state === 'sending') return `Sending · ${status.done}/${status.total}`;
  if (status.state === 'waiting') return `Waiting for its ${status.waitsFor} · ${status.loaded}/${status.chunks}`;
  return 'Open';
}

type Rows = readonly (readonly [string, ReactNode])[];
/** SH-218 rail 2 af1: the rows (by name) that hold a switched-off option the draft needs; each says so under its value. */
const OFF_ROW_NAMES: Readonly<Record<OverviewRow, string>> = { price: 'Priced in', contents: 'Contents', seed: 'Seed', buyers: 'Buyers’ fees', sellers: 'Sellers’ fees' };
const RowList = ({ rows, off = NO_OFF }: { rows: Rows; off?: ReadonlySet<string> }) => (
  <dl className="sh-newbox-rows">
    {rows.map(([name, value]) => (
      <div key={name} className="sh-newbox-row" data-create-off={off.has(name) || undefined}>
        <dt>{name}</dt>
        <dd>{value}{off.has(name) ? <OffMark /> : null}</dd>
      </div>
    ))}
  </dl>
);
const NO_OFF: ReadonlySet<string> = new Set();
const Warnings = ({ lines }: { lines: readonly string[] }) => (lines.length > 0 ? <ul className="sh-newbox-warnings">{lines.map((line) => <li key={line}>{line}</li>)}</ul> : null);

/**
 * What a group keeps behind its closed Details (SH-ALCHEMIST-LESS-TEXT: rule rows and risk lines are never in the default
 * view): its rows, then its warnings in their warning style, then the link to the Terms' risks. `name` says what it opens.
 */
interface GroupDetails { readonly name: string; readonly rows: Rows; readonly warnings: readonly string[] }
/** SH-254: where a group's Edit leads instead of its step (an Overview reached from the visual way: back to its part). */
export type EditTo = (step: V2StepId) => { readonly to: string; readonly state: unknown };

function Group({ step, fix, rows, warnings = [], details = null, off, editTo }: { step: V2StepId; fix: boolean; rows: Rows; warnings?: readonly string[]; details?: GroupDetails | null; off?: ReadonlySet<string>; editTo?: EditTo }) {
  const label = V2_STEPS.find((entry) => entry.id === step)?.label ?? step;
  const edit = editTo?.(step) ?? { to: v2Path(step), state: { fromOverview: true } };
  return (
    <section className="sh-newbox-group" aria-labelledby={`overview-${step}`} data-fix={fix || undefined}>
      <div className="sh-newbox-group__head">
        <h2 id={`overview-${step}`}>
          {label}
          {fix ? <span className="sh-newbox-group__fix"> · Fix</span> : null}
        </h2>
        <Link to={edit.to} state={edit.state} aria-label={`Edit ${label}`} className="sh-newbox-edit">
          <EditGlyph />
          Edit
        </Link>
      </div>
      <RowList rows={rows} off={off} />
      <Warnings lines={warnings} />
      {details ? (
        <Details name={details.name}>
          <RowList rows={details.rows} />
          <Warnings lines={details.warnings} />
          <RisksLink />
        </Details>
      ) : null}
    </section>
  );
}

export interface OverviewV2Props {
  readonly spec: BoxSpecV2;
  readonly hash: string;
  readonly form: CreateForm;
  readonly v2: V2Choices;
  readonly ctx: RecipeCtx;
  readonly plan: CreationPlan;
  readonly nowMs: number;
  readonly fix: ReadonlySet<V2StepId>;
  /** The Demo's run of this very plan; null when there is none, or when it played other choices. */
  readonly run: DemoRun | null;
  /** A pile's seed coin and raw seed (model.ts `pileSeedOf`); null without a pile or with an unparsed seed. */
  readonly seed?: Seed;
  /** The connected wallet: a shop's curator when the creator chose themselves. */
  readonly owner?: Address | null;
  /** The Alchemist rows the page resolved for this pile (alchemist.ts); a side's row names its route. */
  readonly alchemist?: readonly AlchemistRowV21[];
  /** A real build's Create (TA-22, CreateSendPanel): shown in place of the plan's list once it is sending. */
  readonly sending?: ReactNode;
  /** What still holds a shop's starter items (the page's own check on its row: no wallet, being checked, not yours). */
  readonly startersNote?: string | null;
  /** SH-218 rail 2 af1: the rows holding a switched-off option this draft needs (the Create line says it once). */
  readonly offRows?: ReadonlySet<OverviewRow>;
  /** SH-254: where each group's Edit leads (default: its step). */
  readonly editTo?: EditTo;
}

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/**
 * A shop's rows (shop.ts): its seed, give and pick prices per tier, limits, wait, curator, collections and starter items,
 * their count with what still holds them (`startersNote`, the page's own check), as the curator's row names its wallet.
 */
function shopRows(shop: ShopChoice, ticker: string, owner: Address | null, startersNote: string | null): (readonly [string, ReactNode])[] {
  const config = shopConfigOf(shop, owner);
  const seed = tOf(shop.seed);
  const prices = shop.prices.map((text) => tOf(text));
  const priced = prices.every((price): price is bigint => price !== null && price > 0n);
  const list = (values: readonly bigint[]) => `${values.map((value) => formatUnits(value, 18)).join(' · ')} ${ticker}`;
  const curator = curatorOf(shop, owner);
  const starters = starterItemsOf(shop);
  const curatorText = shop.curator === 'creator' ? (curator ? `You · ${short(curator)}` : 'You · connect a wallet') : shop.curator === 'none' ? 'None' : curator ?? 'Fix the address';
  return [
    ['Contents', 'Shop'],
    ['Seed', seed !== null && seed > 0n ? `${formatUnits(seed, 18)} ${ticker}` : 'Fix the seed'],
    ['Give tiers', priced ? list(prices) : 'Fix the tiers'],
    ['Pick', priced ? `${pickText(shop.pickBps)} · ${list(prices.map((price) => pickPriceOf(price, shop.pickBps)))}` : pickText(shop.pickBps)],
    ['Gives a week', `${bpsPercent(shop.weeklyBps)} · ${bpsPercent(shop.collectionBps)} per collection`],
    ['New entries wait', `${shop.listDelayDays} days`],
    ['Curator', <span key="curator" id={SHOP_CONTROL.curatorRow} tabIndex={-1}>{curatorText}</span>],
    ['Collections', String(config.collections.length)],
    ['Starter items', <span key="starters" id={SHOP_CONTROL.startersRow} tabIndex={-1}>{starters === null ? 'Fix the ids' : starters.length === 0 ? 'None' : startersNote ? `${starters.length} · ${startersNote}` : String(starters.length)}</span>],
  ];
}

export function OverviewV2({ spec, hash, form, v2, ctx, plan, nowMs, fix, run, seed = null, owner = null, alchemist = [], sending = null, startersNote = null, offRows, editTo }: OverviewV2Props) {
  const off = new Set([...(offRows ?? [])].map((row) => OFF_ROW_NAMES[row]));
  const listing = ctx.pricing;
  const token = form.contents === 'token';
  const ticker = ctx.ticker || 'T';
  const contents: (readonly [string, ReactNode])[] = token && v2.shop ? shopRows(v2.shop, ticker, owner, startersNote) : token && v2.pile
    ? [['Contents', 'Token and coin pile'], ['Seed', seed ? amountText(seed.amount, seed.listing) : 'Fix the seed'], ['Leave behind', `${(v2.pile.leaveBehindBps ?? 0) / 100}%`]]
    : token ? [['Contents', 'Token']] : [['Contents', `${spec.n} items · ${form.artMode === 'hidden' ? 'hidden' : 'open'}`], ['Pick fee', `${spec.pickFeeBps / 100}%`]];
  // Into the shop (R48B): the accepted warning stays beside the fee rows the creator confirms (The Alchemist's is in the
  // group's Details since SH-ALCHEMIST-LESS-TEXT: a box cannot have a shop and The Alchemist together).
  const shopSeed = token && v2.shop ? tOf(v2.shop.seed) : null;
  const shopFees = token && v2.shop !== null && choiceOf(v2.sellers) === 'shop';
  const routeOf = (pick: SidePick) => (choiceOf(pick) === 'alchemist' ? alchemist.find((row) => row.id === moduleIdOf(pick)) ?? null : null);
  // One short label ("Route", or "Route · row 5" beside another row), so it keeps its column at 375 px.
  const chosen = [...new Map((['buyers', 'sellers'] as const).flatMap((side) => { const row = routeOf(v2[side]); return row ? [[row.id, row] as const] : []; })).values()];
  const routes = chosen.map((row) => [chosen.length > 1 ? `Route · row ${row.id}` : 'Route', row] as const);
  // G1: each chosen row's admitted per-step cap, dust size and fixed trigger, beside its route; the fallback's warning with the rows.
  const terms = chosen.flatMap((row) => {
    const suffix = chosen.length > 1 ? ` · row ${row.id}` : '';
    return [[`Each step${suffix}`, `Up to ${amountText(row.inputCap, listing)}`], [`Too small${suffix}`, dustText(amountText(row.dustMax, listing))],
      [`Started by${suffix}`, triggerText(row.conversionTrigger)]] as const;
  });
  const feeWarnings = shopFees ? [SHOP_FEES_WARNING] : [];
  // SH-ALCHEMIST-LESS-TEXT (founder, 2026-10-27): The Alchemist's route, limits, trigger and warning, in this order,
  // behind the Fees group's closed Details; the two side rows stay.
  const feeDetails: GroupDetails | null = chosen.length > 0 ? {
    name: 'Alchemist',
    // The Alchemist's fixed route, as its helper holds it, into the pile's coin.
    rows: [...routes.map(([name, row]) => [name, row.route.map((hop) => hopText(hop, ctx.listings)).join(' · then ')] as const), ...terms],
    warnings: [ALCHEMIST_WARNING],
  } : null;
  const groups: [V2StepId, (readonly [string, ReactNode])[]][] = [
    ['v2-basics', [['Priced in', listing.symbol], ['Token', `${spec.tokenName || '?'} · ${spec.tokenSymbol || '?'}`]]],
    ['v2-contents', contents],
    ['v2-fees', [['Buyers’ fees', sideText('buyers', v2.buyers, ctx, shopSeed)], ['Sellers’ fees', sideText('sellers', v2.sellers, ctx, shopSeed)]]],
    ['v2-raise', [['Raise', raiseText(listing, spec.raise)], ['Deadline', `${spec.deadlineDays} days`]]],
    ['v2-opening', [['Opens', spec.openAt === 0 ? 'Now' : (pickedTimeText(spec.openAt, nowMs) ?? 'Pick a time')], [`Your ${listing.symbol} at start`, amountText(spec.creatorBuy, listing)]]],
  ];
  return (
    <>
      {groups.map(([step, rows]) => (
        <Group key={step} step={step} fix={fix.has(step)} rows={rows} off={off} warnings={step === 'v2-fees' ? feeWarnings : []} details={step === 'v2-fees' ? feeDetails : null} editTo={editTo} />
      ))}
      {sending ?? <section className="sh-newbox-group" aria-labelledby="overview-v2-plan">
        <div className="sh-newbox-group__head">
          <h2 id="overview-v2-plan">{plan.blocked ? BLOCKED_TITLE[plan.blocked] : `Create · ${plan.steps.length} ${plan.steps.length === 1 ? 'transaction' : 'transactions'}`}</h2>
        </div>
        <ol className="sh-v2-plan">
          {plan.steps.map((step, index) => (
            <li key={`${step.call}-${step.part ?? 0}-${step.index ?? index}`} data-done={run && run.sent > index ? '' : undefined}>
              {stepText(step, listing, seed, ticker)}
            </li>
          ))}
        </ol>
      </section>}
      {DEMO_BUILD && run ? (
        <p className="sh-newbox-status sh-v2-status" role="status" data-create-status="">
          {statusText(run)}
        </p>
      ) : null}
      <details className="sh-newbox-more sh-newbox-spec">
        <summary>Details</summary>
        <p className="sh-newbox-hash">
          <span>Spec hash</span> <code data-spec-hash={hash}>{hash}</code>
        </p>
      </details>
    </>
  );
}
