/**
 * SH-319: a launched token's page drawn as the same picture as its create form (launch-picture.ts), read only, with
 * the chain's numbers on the parts. Pure: no React, no DOM, no reads. Every value comes from a read the page already
 * makes (the screens' own reads and the panels' shared figures, live-figures.tsx); amounts stay bigint until the
 * formatters (lib/amounts.ts) turn them into the picture's short text.
 */
import { formatAmount, formatBps } from '../lib/amounts';
import { RULE_KIND } from '../lib/rules';
import { PAYEE_NAME } from '../lib/payee-names';
import { cellsOf, WORDS, type LaunchPicture, type PartId } from './launch-picture';

/** An amount with its unit, as a panel read it. */
export interface LiveAmount {
  readonly value: bigint;
  readonly decimals: number;
  readonly symbol: string;
}

/** One rule as the rules panel shows it: its kind, part, name and, after the launch, what it was sent (and burned). */
export interface LiveRule {
  readonly kind: number;
  readonly bps: number;
  readonly name: string;
  readonly sent?: bigint;
  readonly burned?: bigint;
}

/** What the page's panels read and share with the picture (none of them reads anything for it). */
export interface LiveFigures {
  readonly rules?: { readonly rows: readonly LiveRule[]; readonly decimals: number; readonly symbol: string };
  readonly pile?: LiveAmount;
  readonly holders?: LiveAmount;
  readonly shops?: number;
}

/** The picture's short amount (the panels below hold the exact one). */
export const short = (value: bigint, decimals: number): string => formatAmount(value, decimals, { maxFraction: 2, significant: 2 });
const pct = (bps: number | bigint): string => formatBps(BigInt(bps));

/** Where a rule's money goes on the picture: a rule paying an address goes to its proven payee (payee-names.ts:
 * the holders' stake, a card shop), else to the creator's part, as the rules panel names it. */
type Group = 'creator' | 'pile' | 'burn' | 'holders' | 'shop';
function groupOf(r: LiveRule): Group {
  if (r.kind === RULE_KIND.pile) return 'pile';
  if (r.kind === RULE_KIND.burn) return 'burn';
  if (r.name === PAYEE_NAME.holders) return 'holders';
  if (r.name === PAYEE_NAME.shop) return 'shop';
  return 'creator';
}

export type LiveParts = { creator: number; pile: number; burn: number; holders: number; shop: number };

/** The rules' parts in basis points (each payee's rules summed), or null without rules. */
export function partsOf(rows: readonly LiveRule[] | undefined): LiveParts | null {
  if (!rows || rows.length === 0) return null;
  const sum = (g: Group) => rows.filter((r) => groupOf(r) === g).reduce((a, r) => a + r.bps, 0);
  return { creator: sum('creator'), pile: sum('pile'), burn: sum('burn'), holders: sum('holders'), shop: sum('shop') };
}

/** What one payee's rules were sent (or burned), or undefined before a splitter has been read. */
function total(rows: readonly LiveRule[] | undefined, group: Group, field: 'sent' | 'burned'): bigint | undefined {
  const own = (rows ?? []).filter((r) => groupOf(r) === group);
  if (own.length === 0 || own.some((r) => r[field] === undefined)) return undefined;
  return own.reduce((a, r) => a + (r[field] ?? 0n), 0n);
}

/** "sent X" for one payee's rules, or null before the splitter is read. */
function sentText(rows: readonly LiveRule[] | undefined, group: Group, figures: LiveFigures): string | null {
  const sent = total(rows, group, 'sent');
  return sent === undefined || !figures.rules ? null : `sent ${short(sent, figures.rules.decimals)}`;
}

/** The creator's lines: the paying rule's name (one payee) or "Creator", and what it was sent. */
function creatorLines(rows: readonly LiveRule[] | undefined, figures: LiveFigures): string[] {
  const own = (rows ?? []).filter((r) => groupOf(r) === 'creator');
  const name = own.length === 1 ? own[0]!.name : WORDS.creator;
  const sent = sentText(rows, 'creator', figures);
  return sent ? [name, sent] : [name];
}

/** The creator part's name for screen readers: its lines, with its percent. */
function creatorName(lines: readonly string[], parts: LiveParts | null): string {
  const head = parts && parts.creator > 0 ? `${lines[0]} ${pct(parts.creator)}` : lines[0]!;
  return lines.length > 1 ? `${head}: ${lines.slice(1).join(', ')}` : head;
}

/** The rest's parts in words, for the tax part's name. */
function restWords(parts: LiveParts): string {
  const out = [`creator ${pct(parts.creator)}`, `pile ${pct(parts.pile)}`];
  if (parts.holders > 0) out.push(`holders ${pct(parts.holders)}`);
  if (parts.shop > 0) out.push(`card shop ${pct(parts.shop)}`);
  out.push(`buy back and burn ${pct(parts.burn)}`);
  return out.join(', ');
}

function extras(ticker: string, figures: LiveFigures, rows: readonly LiveRule[] | undefined, parts: LiveParts | null, names: Partial<Record<PartId, string>>, order: PartId[]) {
  const holdersTag = figures.holders ? short(figures.holders.value, figures.holders.decimals) : null;
  const holdersPart = parts && parts.holders > 0 ? pct(parts.holders) : null;
  const holdersSent = holdersPart ? sentText(rows, 'holders', figures) : null;
  const holdersLines = holdersPart ? [`${WORDS.holders} ${holdersPart}`, ...(holdersSent ? [holdersSent] : [])] : null;
  if (figures.holders || holdersPart) {
    const said = [holdersSent, figures.holders ? `${short(figures.holders.value, figures.holders.decimals)} ${figures.holders.symbol} staked` : null].filter(Boolean).join(', ');
    names.holders = `${WORDS.holders}${holdersPart ? ` ${holdersPart}` : ''}${said ? `: ${said}` : ''}`;
    order.push('holders');
  }
  const shopPart = parts && parts.shop > 0 ? pct(parts.shop) : null;
  const shopSent = shopPart ? sentText(rows, 'shop', figures) : null;
  const shop = shopPart ? [`Cards ${shopPart}`, ...(shopSent ? [shopSent] : [])] : figures.shops ? ['Cards'] : null;
  if (shop) {
    names.shop = `${ticker} cards${shopPart ? ` ${shopPart}` : ''}${shopSent ? `: ${shopSent}` : ''}`;
    order.push('shop');
  }
  return { holdersTag, holdersLines, shop };
}

export interface FlapLiveInput {
  readonly ticker: string;
  readonly quote: { readonly symbol: string; readonly decimals: number };
  readonly tradeFeeBps: number;
  readonly buyTaxBps: number;
  readonly sellTaxBps: number;
  readonly burnShareBps: number;
  /** The tax's run in seconds (CurveConfig.taxDuration). */
  readonly taxSeconds: number | bigint;
  /** The raise on the box's front: the curve's balance while it sells, the target once launched. */
  readonly raised: bigint;
  readonly target: bigint;
  readonly soldBps: bigint;
  /** "In the sale" after a missed sale; else "Raised". */
  readonly raisedLabel: string;
  /** While selling: the time left as the stats show it. */
  readonly timeLeft?: string;
  /** A rules sale (the rules come from the rules panel). */
  readonly ruled: boolean;
  readonly figures: LiveFigures;
}

const FLAP_LIVE_ORDER: readonly PartId[] = ['buyers', 'token', 'sellers', 'creator', 'raise', 'price', 'deadline', 'tax', 'pool', 'pile'];

/** A Flap sale's page as the picture (FlapSale's reads: the sale's config and progress; the panels' figures). */
export function flapLivePicture(input: FlapLiveInput): LaunchPicture {
  const { ticker, quote, figures } = input;
  const rows = input.ruled ? figures.rules?.rows : undefined;
  const parts = partsOf(rows);
  const burnCells = input.burnShareBps <= 0 ? 0 : Math.min(9, Math.max(1, Math.round(input.burnShareBps / 1000)));
  const days = (BigInt(input.taxSeconds) / 86400n).toString();
  const raised = short(input.raised, quote.decimals);
  const target = short(input.target, quote.decimals);
  const sold = pct(input.soldBps);
  const buyers = [`fee ${pct(input.tradeFeeBps)}`, `tax ${pct(input.buyTaxBps)}`];
  const sellers = [`fee ${pct(input.tradeFeeBps)}`, `tax ${pct(input.sellTaxBps)}`];
  const burned = total(rows, 'burn', 'burned');
  const pileAmount = figures.pile ? `${short(figures.pile.value, figures.pile.decimals)} ${figures.pile.symbol}` : null;
  const share = parts ? `${pct(parts.pile)} of the rest` : input.ruled ? null : 'the rest';
  const creator = creatorLines(rows, figures);
  const names: Partial<Record<PartId, string>> = {
    token: `${WORDS.token} ${ticker}`,
    buyers: `${WORDS.buys}: ${buyers.join(', ')}`,
    sellers: `${WORDS.sells}: ${sellers.join(', ')}`,
    creator: creatorName(creator, parts),
    raise: `${input.raisedLabel} ${raised} of ${target} ${quote.symbol}`,
    price: `Paid in ${quote.symbol}`,
    deadline: input.timeLeft ? `Sold ${sold}, ${input.timeLeft} left` : `Sold ${sold}`,
    tax: `Tax: ${pct(input.burnShareBps)} burned, for ${days} days${
      parts ? `; the rest: ${restWords(parts)}` : ''
    }`,
    pool: `${WORDS.pool}: at ${target} ${quote.symbol}`,
    pile: pileAmount ? `${WORDS.pile}: ${pileAmount}` : WORDS.pile,
  };
  const order = [...FLAP_LIVE_ORDER];
  const { holdersTag, holdersLines, shop } = extras(ticker, figures, rows, parts, names, order);
  return {
    ticker,
    buyers,
    sellers,
    front: {
      left: { label: input.raisedLabel, value: raised, unit: `of ${target}` },
      right: { label: 'Sold', value: sold, unit: input.timeLeft ? `${input.timeLeft} left` : '' },
    },
    coin: quote.symbol,
    creator,
    burnCells,
    cells: cellsOf(burnCells, parts),
    creatorTag: parts && parts.creator > 0 ? pct(parts.creator) : null,
    creatorTagOf: parts && parts.creator > 0 ? 'of the rest' : null,
    burn:
      parts && parts.burn > 0
        ? [`${WORDS.burned} ${pct(input.burnShareBps)}`, `buy back ${pct(parts.burn)}`, burned !== undefined ? `${short(burned, 18)} ${ticker}` : 'of the rest']
        : [WORDS.burned, pct(input.burnShareBps)],
    pile: [WORDS.pile, ...(pileAmount ? [pileAmount] : []), ...(share ? [share] : [])],
    center: [`tax for ${days} days`],
    pool: { label: WORDS.pool, number: `at ${target}` },
    parts: order.map((id) => ({ id, name: names[id]! })),
    warn: [],
    holdersTag,
    holdersLines,
    shop,
  };
}

export interface FourLiveInput {
  readonly ticker: string;
  readonly quote: { readonly symbol: string; readonly decimals: number };
  /** The token's kind as FourToken reads it: a curve-fee preset, a tax token, a tax token with the creator's rules. */
  readonly kind: 'preset' | 'tax' | 'tax-rules';
  readonly buyBps: number;
  readonly sellBps: number;
  readonly raised: bigint;
  readonly target: bigint;
  readonly soldBps: bigint;
  /** A tax-rules token's rules as its clone fixed them (FourToken's own read), before the panel shares more. */
  readonly fixed?: readonly LiveRule[];
  readonly figures: LiveFigures;
}

const FOUR_LIVE_ORDER: readonly PartId[] = ['buyers', 'token', 'sellers', 'creator', 'raise', 'price', 'deadline', 'tax', 'pool', 'pile'];

/** An OpenFour token's page as the picture (FourToken's reads; the panels' figures). */
export function fourLivePicture(input: FourLiveInput): LaunchPicture {
  const { ticker, quote, figures } = input;
  const ruled = input.kind === 'tax-rules';
  const rows = ruled ? (figures.rules?.rows ?? input.fixed) : undefined;
  const parts = partsOf(rows);
  const word = input.kind === 'preset' ? 'fee' : 'tax';
  const buyers = [`${word} ${pct(input.buyBps)}`];
  const sellers = [`${word} ${pct(input.sellBps)}`];
  const raised = short(input.raised, quote.decimals);
  const target = short(input.target, quote.decimals);
  const sold = pct(input.soldBps);
  const burned = total(rows, 'burn', 'burned');
  const pileAmount = figures.pile ? `${short(figures.pile.value, figures.pile.decimals)} ${figures.pile.symbol}` : null;
  const share = parts ? `${pct(parts.pile)} of the tax` : ruled ? null : input.kind === 'tax' ? 'all the tax' : 'all the fees';
  const creator = creatorLines(rows, figures);
  const names: Partial<Record<PartId, string>> = {
    token: `${WORDS.token} ${ticker}`,
    buyers: `${WORDS.buys}: ${buyers[0]}`,
    sellers: `${WORDS.sells}: ${sellers[0]}`,
    creator: creatorName(creator, parts),
    raise: `Raised ${raised} of ${target} ${quote.symbol}`,
    price: `Raised in ${quote.symbol}`,
    deadline: `Sold ${sold}`,
    tax:
      input.kind === 'preset'
        ? 'Fees: all of them to the pile'
        : parts
          ? `Tax: ${restWords(parts)}`
          : ruled
            ? 'Tax'
            : 'Tax: all of it to the pile',
    pool: `${WORDS.pool}: at ${target} ${quote.symbol}`,
    pile: pileAmount ? `${WORDS.pile}: ${pileAmount}` : WORDS.pile,
  };
  const order = [...FOUR_LIVE_ORDER];
  const { holdersTag, holdersLines, shop } = extras(ticker, figures, rows, parts, names, order);
  return {
    ticker,
    buyers,
    sellers,
    front: { left: { label: 'Raised', value: raised, unit: `of ${target}` }, right: { label: 'Sold', value: sold, unit: '' } },
    coin: quote.symbol,
    creator,
    burnCells: 0,
    cells: cellsOf(0, parts),
    creatorTag: parts && parts.creator > 0 ? pct(parts.creator) : null,
    creatorTagOf: null,
    burn: parts && parts.burn > 0 ? ['Buy back', `and burn ${pct(parts.burn)}`, ...(burned !== undefined ? [`${short(burned, 18)} ${ticker}`] : [])] : null,
    pile: [WORDS.pile, ...(pileAmount ? [pileAmount] : []), ...(share ? [share] : [])],
    center: [input.kind === 'preset' ? 'fee on every curve trade' : 'tax on every trade'],
    pool: { label: WORDS.pool, number: `at ${target}` },
    parts: order.map((id) => ({ id, name: names[id]! })),
    warn: [],
    holdersTag,
    holdersLines,
    shop,
  };
}
