/**
 * A core v1 box's card figure from ITS OWN feed card (BC-085: each card its own state and figure; BC-094: Stale or
 * Unverified only on the box that is, with no FDV then), numbers first (BOX-INTERFACE § 3):
 * - upcoming: "Opens in ~N min": from the head's time to the first block at or after the box's openAt (a clock time,
 *   open-at-clock-time.md; on mainnet a round time is met in the block 11 s later, on Sepolia at the time itself);
 * - window: "Window · tax N% · ~M min" (the next block's 12-second step of the tax, the time left until the window ends);
 * - bonding: "62.0% · 2.6112 / 4.206980085 ETH" with a bar (in the row's own Q and decimals);
 * - graduating: "Filled · graduating" (the contract's Closed: filled, waiting for anyone's graduate());
 * - graduated: "FDV 41.8 ETH" (price × supply; never shown for an Unverified box).
 *
 * A Stale card (the gateway's per-box flag, a failed refresh, or on Sepolia an answer over a minute old by the clock)
 * counts nothing down from its frozen head: "Opens 18:00 UTC", "Window until 18:06 UTC" (S10a review, BC-094).
 */
import { WINDOW_STEPS } from '@squarehole/box-spec';
import { LAUNCH_TAX_TABLE_PIPS, type CorePhase, type FeedCard } from '@squarehole/indexer/client';
import { firstBlockTimeAtOrAfter, SLOT_GENESIS_TIME, SLOT_SECONDS, windowStepAt, type BoxRow } from '@squarehole/chain';
import { approxDuration, formatPair, raiseText, utcTime } from '../boxes/box-figure';
import type { BoxRecord, BoxState, BoxSummary } from '../boxes/box-model';
import { formatBlock, formatBps, formatTaxPips, formatTokenShort } from '../fit-pair/fit-format';
import { perMillion } from '../boxes/price-format';
import { NO_FIGURE } from './v2/stats-v2';

/** T in short form ("2.56M"), without the symbol. */
const shortT = (raw: bigint): string => formatTokenShort(raw, '').trim();

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

export type RowNetwork = 'local' | 'sepolia' | 'demo';

/** The beacon genesis that places a row's blocks in time: a public chain's (Sepolia, mainnet); none locally or in the Demo. */
export function slotGenesisOf(row: Pick<BoxRow, 'chainId'>, network: RowNetwork): bigint | null {
  return network === 'local' || (DEMO_BUILD && network === 'demo') ? null : (SLOT_GENESIS_TIME[row.chainId] ?? null);
}

/** When a row's box is seen open: the time of the first block at or after its openAt (Unix seconds). */
export function opensAtBlockTime(row: Pick<BoxRow, 'chainId' | 'openAt'>, network: RowNetwork): bigint {
  return firstBlockTimeAtOrAfter(row.openAt, slotGenesisOf(row, network));
}
/** A live answer older than this by the clock is Stale (about five Sepolia blocks). */
export const STALE_AFTER_SECONDS = 60n;

/**
 * Whether an answer is Stale by the clock: on Sepolia only, whose blocks follow the wall clock (12 s). A local twin's
 * clock is its own (anvil mines on demand and the life moves time by days), so its freshness is the gateway's word.
 */
export function staleByClock(network: 'local' | 'sepolia' | 'demo', asOfTimestamp: string, nowMs: number): boolean {
  if (network !== 'sepolia' || !/^\d+$/.test(asOfTimestamp)) return false;
  return BigInt(Math.floor(nowMs / 1000)) - BigInt(asOfTimestamp) > STALE_AFTER_SECONDS;
}

export const STATE_OF_PHASE: Readonly<Record<CorePhase, BoxState>> = Object.freeze({
  upcoming: 'upcoming',
  window: 'window',
  bonding: 'bonding',
  graduating: 'graduating',
  graduated: 'graduated',
});

/**
 * The launch tax of the next block (12 s after the head's time) in the window: the BoxSpecV1 table at its step,
 * (time − openAt) / 12; null outside the window.
 */
export function windowTaxPips(row: Pick<BoxRow, 'openAt'>, headTime: bigint): number | null {
  const step = windowStepAt(row.openAt, headTime + SLOT_SECONDS);
  return step === null ? null : (LAUNCH_TAX_TABLE_PIPS[step] ?? null);
}

/** The window at the head: the seconds left until it ends, and the bar (the steps of the 32 up to the head's, counted in). */
export function windowProgress(row: Pick<BoxRow, 'openAt' | 'windowEndsAt'>, headTime: bigint): { readonly left: bigint; readonly barBps: number } {
  const left = row.windowEndsAt > headTime ? row.windowEndsAt - headTime : 0n;
  const step = windowStepAt(row.openAt, headTime);
  const done = step !== null ? BigInt(step + 1) : headTime >= row.windowEndsAt ? WINDOW_STEPS : 0n;
  return { left, barBps: Number((done * 10_000n) / WINDOW_STEPS) };
}

const headTimeOf = (asOf: { readonly timestamp: string }): bigint => (/^\d+$/.test(asOf.timestamp) ? BigInt(asOf.timestamp) : 0n);

export function cardNotice(card: Pick<FeedCard, 'stale' | 'verified' | 'asOf'>): string | null {
  if (card.verified === false) return 'Unverified';
  if (card.stale) return `Stale · since block ${formatBlock(BigInt(card.asOf.block))}`;
  return null;
}

export function rowSummary(record: BoxRecord, row: BoxRow, card: FeedCard, options: { readonly stale?: boolean } = {}): BoxSummary {
  const state = STATE_OF_PHASE[card.phase];
  const headTime = headTimeOf(card.asOf);
  const network = record.row?.network ?? 'local';
  const stale = card.stale || options.stale === true;
  const fdv = card.verified === false || card.fdvQ === null ? null : BigInt(card.fdvQ);
  // SH-TA-12: once trading has opened, the price (never an Unverified box's) and the T burned, under the figure.
  const cells: BoxSummary['cells'] = card.phase === 'upcoming' ? undefined : [
    ['Price', card.verified === false || card.qPerT === null ? NO_FIGURE : perMillion(card.qPerT)],
    ['Burned', card.burnedT === undefined ? NO_FIGURE : shortT(BigInt(card.burnedT))],
  ];
  const base: BoxSummary = { record, state, figure: { text: 'Unavailable', barBps: null }, mcapRaw: fdv, progressBps: card.fillBps, volumeRaw: card.volumeQ === null ? null : BigInt(card.volumeQ), notice: cardNotice({ ...card, stale }), ...(cells ? { cells } : {}) };
  const q = record.pairAsset;
  switch (card.phase) {
    case 'upcoming': {
      const opens = opensAtBlockTime(row, network);
      if (stale) return { ...base, figure: { text: `Opens ${utcTime(Number(opens) * 1000, Number(headTime) * 1000)}`, barBps: null }, progressBps: 0 };
      const left = opens > headTime ? opens - headTime : 0n;
      return { ...base, figure: { text: `Opens in ${approxDuration(left)}`, barBps: null }, progressBps: 0 };
    }
    case 'window': {
      if (stale) return { ...base, figure: { text: `Window until ${utcTime(Number(row.windowEndsAt) * 1000, Number(headTime) * 1000)}`, barBps: null } };
      const tax = windowTaxPips(row, headTime);
      const { left, barBps } = windowProgress(row, headTime);
      return { ...base, figure: { text: `Window · tax ${tax === null ? '—' : formatTaxPips(tax)} · ${approxDuration(left)}`, barBps } };
    }
    case 'bonding': {
      const fill = card.fillBps ?? 0;
      const retained = card.retainedQ === null ? null : BigInt(card.retainedQ);
      return { ...base, figure: { text: `${formatBps(fill)} · ${retained === null ? '—' : formatPair(retained, record, q === 'ETH' ? 4 : 2)} / ${raiseText(row.raise, record)} ${q}`, barBps: fill } };
    }
    case 'graduating':
      return { ...base, figure: { text: 'Filled · graduating', barBps: 10_000 }, progressBps: 10_000 };
    case 'graduated':
      return { ...base, figure: { text: fdv === null ? 'FDV not available' : `FDV ${formatPair(fdv, record, 2)} ${q}`, barBps: null }, progressBps: 10_000 };
  }
}
