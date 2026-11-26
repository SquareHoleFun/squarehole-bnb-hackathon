/**
 * What the box header says per state (BOX-INTERFACE § 3-4), one fact in one place and one unit:
 *
 * - the state band on the cover: the state and its one figure ("opens in 13 blocks", "22 blocks left", the progress,
 *   "not graduated yet", the FDV, "refunds open");
 * - the phase line: what the band does not say (the launch tax whenever it applies, graduation pending, since when the
 *   vault is open, a deadline);
 * - four stats for a launch box: Items, then Reserved or Inside (Target before the open), then the founder's two numbers
 *   side by side, "1 Misfit" in FIT (the vault's quote) and "Price" in ETH per 1M FIT (the pool's), never multiplied
 *   (F49 M1); three for a Demo box (no vault model behind its invented figures).
 */
import { ISSUANCE } from '@squarehole/box-spec';
import { LAUNCH_TAX_TABLE_PIPS } from '@squarehole/indexer/client';
import type { ReactNode } from 'react';
import { blocks, ethDecimal, formatBlock, formatBps, formatCount, formatTaxPips, raiseDecimal } from '../fit-pair/fit-format';
import { v2Header, type HeaderParts } from '../core/v2/v2-header';
import { graduationBandSqrtX96, type FitMarketTarget } from '../fit-pair/fit-target';
import type { LiveData } from '../fit-pair/live-model';
import { decimalToRaw, demoSummary, raiseText } from './box-figure';
import type { BoxRecord, BoxState, BoxSummary } from './box-model';
import type { Band, Stat } from './BoxHeader';
import type { ContentsCounts, EditionSize } from './ContentsPanel';
import { costTokens, perMillion } from './price-format';
import { bpsText, ethText } from './spec-record';
import type { PriceCheck } from './price-model';

const FIRST_TAX = formatTaxPips(LAUNCH_TAX_TABLE_PIPS[0] ?? 0);
const LAST_TAX = formatTaxPips(LAUNCH_TAX_TABLE_PIPS.at(-1) ?? 0);
/** The launch tax before the open, in the phase line (F33: named on the first screen whenever it is about to apply). */
export const TAX_RANGE = `Launch tax ${FIRST_TAX} → ${LAST_TAX} on buys`;

const na = (): ReactNode => <span className="sh-na">Not available</span>;
const singular = (noun: string): string => noun.replace(/s$/, '');

function itemsStat(edition: EditionSize): Stat {
  return { label: 'Items', value: formatCount(edition.size), unit: edition.check === 'mismatch' ? 'Unverified' : undefined };
}

export interface LaunchHeaderInput {
  readonly record: BoxRecord;
  readonly target: FitMarketTarget;
  readonly state: BoxState | null;
  readonly data: LiveData | null;
  /** The pool price may be shown (not for unverified or unavailable data). */
  readonly priceShown: boolean;
  readonly edition: EditionSize;
  readonly counts: ContentsCounts;
  /** What one item costs in the token (the vault's quote; the chain's own when they disagree), or null. */
  readonly cost: bigint | null;
  readonly check: PriceCheck | null;
  readonly summary: BoxSummary;
}

export function launchStats({ record, target, state, data, priceShown, edition, counts, cost, check }: LaunchHeaderInput): Stat[] {
  const t = record.ticker;
  const one = singular(record.itemNoun);
  const price: Stat = {
    label: 'Price',
    value: data && priceShown ? perMillion(data.state.figures.priceEthPerToken) : na(),
    unit: `ETH per 1M ${t}`,
    info: 'The pool’s price, before the 1% pool fee and any launch tax: not an execution quote.',
  };
  const quote: Stat = {
    label: `1 ${one}`,
    value: cost === null ? na() : costTokens(cost),
    unit: check === 'mismatch' ? `${t} · unverified` : t,
    info: `The vault’s quote for one ${one}, rounded up: all ${t} not locked in the vault divided by the ${record.itemNoun} inside. Taking one out locks it in the vault and putting one back releases it, so it stays the same; only burned ${t} lowers it, slowly. Not an ETH price.`,
  };
  if (state === 'upcoming') return [itemsStat(edition), quote, price, { label: 'Target', value: raiseDecimal(target.curve.targetWei), unit: 'ETH', fit: true }];
  if (state === 'graduated') return [itemsStat(edition), { label: 'Inside', value: counts.inside === null ? na() : formatCount(counts.inside) }, quote, price];
  return [
    itemsStat(edition),
    { label: 'Reserved', value: counts.reserved === null ? na() : formatCount(counts.reserved), info: `Placeholders taken for ${t} during the curve; each opens as one of the ${record.itemNoun} at graduation.` },
    quote,
    price,
  ];
}

export function launchBand({ state, data, target, summary }: Pick<LaunchHeaderInput, 'state' | 'data' | 'target' | 'summary'>): Band {
  if (state === null || data === null) return { figure: null, barBps: null };
  const w = data.window;
  const figures = data.confirmed.figures;
  switch (state) {
    case 'upcoming':
      return { figure: `in ${blocks(w.blocksToOpen + 1n)}`, barBps: null };
    case 'window':
      return { figure: `${blocks(w.blocksToClose)} left`, barBps: null };
    case 'bonding':
      return { figure: `${formatBps(figures.fillBps)} · ${ethDecimal(figures.retainedWei)} / ${raiseDecimal(target.curve.targetWei)} ETH`, barBps: figures.fillBps };
    case 'graduating':
      return { figure: 'not graduated yet', barBps: 10_000 };
    case 'graduated':
      return { figure: summary.figure.text, barBps: null };
    default:
      return { figure: null, barBps: null };
  }
}

/**
 * Graduating: when graduation can run (the band already says "not graduated yet"; Terms 5.6 (f): the price within the
 * band, from the latch block on).
 */
function graduationLine(data: LiveData, target: FitMarketTarget): string {
  const from = data.state.graduatesFromBlock;
  const head = data.head.number;
  if (from === null) return 'Graduation pending';
  if (from > head) return `Graduation possible in ${blocks(from - head)}`;
  return data.state.sqrtPriceX96 <= graduationBandSqrtX96(target.curve) ? 'Anyone can trigger graduation' : 'Price outside the graduation band';
}

/** The phase line's words: what the band does not say. */
export function launchPhase({ state, data, target }: Pick<LaunchHeaderInput, 'state' | 'data' | 'target'>): string | null {
  if (state === null || data === null) return null;
  switch (state) {
    case 'upcoming':
      return TAX_RANGE;
    case 'window':
      return `Launch tax ${formatTaxPips(data.window.nextBlockTaxPips)} on buys`;
    case 'graduating':
      return graduationLine(data, target);
    case 'graduated':
      return `Graduated at block ${formatBlock(data.state.migratedBlock ?? data.head.number)}`;
    default:
      // An open curve needs no line (as on the FIT pair page); the deadline ("None") is under About.
      return null;
  }
}

/** The fixed supply in short words: 1e27 raw → "1B" (whole billions), else the count. */
export function supplyWords(raw: bigint = ISSUANCE): string {
  const whole = raw / 10n ** 18n;
  return whole % 1_000_000_000n === 0n ? `${whole / 1_000_000_000n}B` : formatCount(whole);
}

/** The Target cell of an upcoming Demo box: the one raise, exactly ("4.206980085", F74 U5), as box 0's header states it. */
function targetStat(target: string | undefined, record: BoxRecord): Stat {
  const asset = record.pairAsset;
  if (target === undefined) return { label: 'Target', value: na(), unit: asset };
  return { label: 'Target', value: raiseText(decimalToRaw(target, record.pairDecimals), record), unit: asset, info: 'Every box raises the same.', fit: true };
}

/** A Demo box's header: its fixed figures, three stats, the band and the phase line; a v2 box's closing parts on top. */
export function demoHeader(record: BoxRecord, nowMs: number = Date.now()): HeaderParts {
  const base = demoBase(record);
  return record.v2 ? v2Header(record, base, BigInt(Math.floor(nowMs / 1000))) : base;
}

function demoBase(record: BoxRecord): HeaderParts {
  const f = record.demoFigures;
  const state = record.demoState;
  const asset = record.pairAsset;
  // A token-only box has no items: its first figure is the token's fixed supply.
  const items: Stat = record.kind === 'token' ? { label: 'Supply', value: supplyWords(), unit: record.ticker } : { label: 'Items', value: formatCount(record.itemCount) };
  const price: Stat = { label: 'Price', value: f?.price ?? na(), unit: `${asset} per 1M ${record.ticker}` };
  const summary = demoSummary(record);
  switch (state) {
    case 'upcoming': {
      const stats: Stat[] = [items, targetStat(f?.target, record), { label: 'Deadline', value: `${f?.deadlineDays ?? 0} d`, unit: 'from the open' }];
      const first = record.spec;
      // The creator's ETH at start (before the open), below the raise, and the token share it came to (F61 O2, BC-117).
      if (first && first.firstInRaw > 0n) {
        stats.push({
          label: 'Creator',
          value: ethText(first.firstInRaw),
          unit: first.firstTokensBps === null ? `${asset} at start` : `${asset} at start · ≈ ${bpsText(first.firstTokensBps)} of ${record.ticker}`,
          info: 'What the creator put in at creation, before anyone else, and the share of the token it came to (an estimate). It is shown on every box that has one.',
        });
      }
      return {
        stats,
        band: { figure: f?.upcomingText ?? `in ${f?.opensIn ?? 'a while'}`, barBps: null },
        phase: TAX_RANGE,
      };
    }
    case 'graduated':
      return {
        stats: [items, { label: 'Inside', value: formatCount(record.itemCount - (f?.outside ?? 0n)) }, price],
        band: { figure: summary.figure.text, barBps: null },
        phase: null,
      };
    case 'failed':
      return {
        stats: [items, { label: 'Kept', value: formatCount(f?.reserved ?? 0n) }, { label: 'Progress', value: formatBps(f?.progressBps ?? 0), unit: 'at the deadline' }],
        band: { figure: 'refunds open', barBps: null },
        phase: 'Deadline passed',
      };
    default:
      return {
        stats: [items, record.kind === 'existing' ? { label: 'Pick fee', value: '25%', unit: 'No draw' } : { label: 'Reserved', value: formatCount(f?.reserved ?? 0n) }, price],
        band: { figure: summary.figure.text, barBps: summary.figure.barBps },
        phase: `Ends in ${f?.deadlineDays ?? 0} d if the curve does not fill`,
      };
  }
}
