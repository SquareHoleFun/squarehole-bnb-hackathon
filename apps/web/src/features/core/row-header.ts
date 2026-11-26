/**
 * What a core v1 box's header says per phase (S10a § 5 Header; BOX-INTERFACE § 3-4), from its row and its snapshot,
 * numbers first:
 * - the band: "in ~N min" (upcoming: to the first block at or after the box's openAt, a clock time), "tax 84.25% ·
 *   ~4 min left" with the 32-step bar (window: the next block's 12-second step, the time until the window ends), the
 *   fill of the one raise (bonding), "filled · graduating" (the contract's Closed), the pool price (graduated);
 * - the phase line: the launch tax before and during the window, "Waiting for anyone's graduate()" when filled,
 *   "Graduated at block B"; a deadline line only for a box that has one (box 0 has none, BC-090);
 * - four stats: Price (Q per 1M T, the pool's), FDV, Burned (T since the one-time issuance), Items (N from the spec).
 * A box shown as Unverified gets no price-built figure (BC-094); a Stale one counts nothing down from its frozen head
 * (the open and the window's end as UTC times instead).
 */
import { ISSUANCE } from '@squarehole/box-spec';
import type { BoxRow } from '@squarehole/chain';
import type { CoreBoxView } from '@squarehole/indexer/client';
import { createElement, type ReactNode } from 'react';
import { approxDuration, formatPair, raiseText, utcTime } from '../boxes/box-figure';
import type { BoxRecord } from '../boxes/box-model';
import type { Band, Stat } from '../boxes/BoxHeader';
import { TAX_RANGE } from '../boxes/box-stats';
import { perMillion } from '../boxes/price-format';
import { formatBlock, formatBps, formatCount, formatTaxPips, formatTokenShort } from '../fit-pair/fit-format';
import { opensAtBlockTime, windowProgress, windowTaxPips } from './row-summary';

const na = (): ReactNode => createElement('span', { className: 'sh-na' }, 'Not available');

export interface RowHeaderInput {
  readonly record: BoxRecord;
  readonly row: BoxRow;
  readonly view: CoreBoxView | null;
  /** The snapshot is Stale (the gateway's flag, a failed refresh, or too old by the clock): no countdown. */
  readonly stale?: boolean;
}

/** The head's time (Unix seconds): every countdown runs from the snapshot's block, never from this browser's clock. */
const headTime = (view: CoreBoxView): bigint => (/^\d+$/.test(view.asOf.timestamp) ? BigInt(view.asOf.timestamp) : 0n);
const priceShown = (view: CoreBoxView | null): view is CoreBoxView => view !== null && view.verified !== false && view.price.qPerT !== null;

export function rowBand({ record, row, view, stale = false }: RowHeaderInput): Band {
  if (!view) return { figure: null, barBps: null };
  const t = headTime(view);
  switch (view.phase) {
    case 'upcoming': {
      const opens = opensAtBlockTime(row, record.row?.network ?? 'local');
      if (stale) return { figure: `at ${utcTime(Number(opens) * 1000, Number(t) * 1000)}`, barBps: null };
      return { figure: `in ${approxDuration(opens > t ? opens - t : 0n)}`, barBps: null };
    }
    case 'window': {
      if (stale) return { figure: `until ${utcTime(Number(row.windowEndsAt) * 1000, Number(t) * 1000)}`, barBps: null };
      const tax = windowTaxPips(row, t);
      const { left, barBps } = windowProgress(row, t);
      return { figure: `tax ${tax === null ? '—' : formatTaxPips(tax)} · ${approxDuration(left)} left`, barBps };
    }
    case 'bonding': {
      const retained = view.curve.retainedQ === null ? null : BigInt(view.curve.retainedQ);
      return { figure: `${formatBps(view.curve.fillBps ?? 0)} · ${retained === null ? '—' : formatPair(retained, record, record.pairAsset === 'ETH' ? 4 : 2)} / ${raiseText(row.raise, record)} ${record.pairAsset}`, barBps: view.curve.fillBps };
    }
    case 'graduating':
      return { figure: 'filled · graduating', barBps: 10_000 };
    case 'graduated':
      return { figure: priceShown(view) ? `${perMillion(view.price.qPerT as string)} ${record.pairAsset} per 1M ${record.ticker}` : 'price not shown', barBps: null };
  }
}

export function rowPhaseLine({ row, view, stale = false }: RowHeaderInput): string | null {
  const deadline = row.spec.deadlineDays > 0 ? `Ends ${row.spec.deadlineDays} d after the open if the curve does not fill` : null;
  if (!view) return deadline;
  switch (view.phase) {
    case 'upcoming':
      return deadline ? `${TAX_RANGE} · ${deadline}` : TAX_RANGE;
    case 'window': {
      if (stale) return TAX_RANGE;
      const tax = windowTaxPips(row, headTime(view));
      return `Launch tax ${tax === null ? '—' : formatTaxPips(tax)} on buys`;
    }
    case 'bonding':
      return deadline;
    case 'graduating':
      return 'Filled: waiting for anyone’s graduate()';
    case 'graduated':
      return view.blocks.migratedAt ? `Graduated at block ${formatBlock(BigInt(view.blocks.migratedAt))}` : 'Graduated';
  }
}

export function rowStats({ record, row, view }: RowHeaderInput): Stat[] {
  const t = record.ticker;
  const price: Stat = {
    label: 'Price',
    value: priceShown(view) ? perMillion(view.price.qPerT as string) : na(),
    unit: `${record.pairAsset} per 1M ${t}`,
    info: 'The pool’s price, before the 1% pool fee and any launch tax: not an execution quote.',
  };
  const fdv: Stat = {
    label: 'FDV',
    value: view && view.fdvQ !== null && view.verified !== false ? formatPair(BigInt(view.fdvQ), record, 2) : na(),
    unit: record.pairAsset,
    info: `The pool’s price × the ${t} supply (the ${t} locked in the vault included).`,
  };
  const burned: Stat = {
    label: 'Burned',
    value: view ? formatTokenShort(BigInt(view.supply.burned), '') : na(),
    unit: t,
    info: `${t} burned since the one-time issuance of ${formatTokenShort(ISSUANCE, t)}.`,
  };
  const items: Stat = record.kind === 'token' ? { label: 'Supply', value: formatTokenShort(ISSUANCE, ''), unit: t } : { label: 'Items', value: formatCount(BigInt(row.spec.n)) };
  return [price, fdv, burned, items];
}
