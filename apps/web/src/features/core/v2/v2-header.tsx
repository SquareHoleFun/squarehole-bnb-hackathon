/**
 * A v2 box's header (the box template's v2 part; F99, F100, F104), numbers first. A box anyone may close now shows why
 * in its band, with no curve figure and no price (every swap reverts from the deadline, IBoxHookV2), and its phase line
 * says anyone may close it, with the closer's tip cap. A box before its deadline counts the days left from the deadline
 * itself. A closed box shows "Closed", its closing price per 1M tokens and its closing pool, both in its own pricing
 * token, and what its closer was paid. A broken answer (decimals outside 0-36, a negative amount) shows "Not available".
 */
import { formatTokenAmount } from '@squarehole/domain';
import type { Band, Stat } from '../../boxes/BoxHeader';
import type { BoxRecord } from '../../boxes/box-model';
import { formatBps } from '../../fit-pair/fit-format';
import { closeStateOf, closingPricePerMillion, showableDecimals, type BoxV2Facts } from './box-v2';
import { CLOSING_POOL, CLOSING_PRICE, closableFigure, closableLine, closedLine, closingPriceInfo, endsInLine } from './v2-words';

export interface HeaderParts {
  stats: Stat[];
  band: Band;
  phase: string | null;
}

/** A raw amount in the box's pricing token, at most 4 decimals, truncated (it never overstates); null when broken. */
export const pricingAmount = (raw: bigint, facts: BoxV2Facts): string | null =>
  raw < 0n || !showableDecimals(facts.pricing.decimals) ? null : formatTokenAmount(raw, facts.pricing.decimals, { maxFractionDigits: Math.min(facts.pricing.decimals, 4) });

const na = () => <span className="sh-na">Not available</span>;

/** A closable box's stats: the price goes (no swap can happen), the curve's progress at the deadline stays. */
function closableStats(base: HeaderParts): Stat[] {
  const progress = base.band.barBps;
  return base.stats.flatMap((stat) => (stat.label !== 'Price' ? [stat] : progress === null ? [] : [{ label: 'Progress', value: formatBps(progress), unit: 'at the deadline' }]));
}

export function v2Header(record: BoxRecord, base: HeaderParts, nowSec: bigint): HeaderParts {
  const facts = record.v2;
  if (!facts) return base;
  const symbol = facts.pricing.symbol;
  const close = closeStateOf(facts, nowSec);
  if (close.kind === 'closable') {
    const cause = close.call === 'fail' ? 'deadline' : 'closed-past-cap';
    return { stats: closableStats(base), band: { figure: closableFigure(cause), barBps: null }, phase: closableLine(pricingAmount(facts.tipMaxQ, facts), symbol) };
  }
  if (close.kind === 'waiting') return facts.gateOpen ? { ...base, phase: endsInLine(close.from - nowSec) } : base;
  if (close.kind !== 'closed') return base;
  const closing = close.closing;
  const price = closing ? closingPricePerMillion(closing, facts.pricing.decimals) : null;
  const pool = closing ? pricingAmount(closing.pInRange, facts) : null;
  return {
    stats: [
      ...base.stats.slice(0, 1),
      { label: CLOSING_PRICE, value: price ?? na(), unit: `${symbol} per 1M ${record.ticker}`, info: closingPriceInfo(symbol) },
      { label: CLOSING_POOL, value: pool ?? na(), unit: symbol },
    ],
    band: { figure: price === null ? null : `${price} ${symbol} per 1M`, barBps: null },
    phase: closedLine(close.cause, closing ? pricingAmount(closing.tip, facts) : null, symbol),
  };
}
