/**
 * SH-EXISTING-NFTS-E08C: a set box as its card and page show it, derived from the raw state the indexer publishes
 * (`SetBoxData.state`, design § 4.10: "clients derive loading/partial/failure presentation without a new protocol
 * state"). Pure data; amounts and ids bigint, read from decimal strings at this boundary only.
 *
 * Five states, numbers first:
 * - pending: the creator is loading the committed list (`loaded` of `count`), or every item is in and trading has
 *   not opened yet (Loading N/N): the wire's `seedReady` says only that every committed item is loaded;
 * - open: the coordinator's trading gate, which the loader's complete() opens, read on chain and its time come
 *   (`SetTrading`); conversion waits for graduation;
 * - graduated: the vault's conversion gate opened: named picks and returns;
 * - failed: the raise failed; the loaded items can go back to the creator;
 * - recovering: failed, and some (not all) of the loaded items are back with the creator.
 */
import type { Address } from 'viem';
import { formatUnits } from '@squarehole/domain';
import type { SetBoxData, SetFeedWire, SetMemberState } from '@squarehole/chain/core/set-v2';
import { formatBoxId } from '../boxes/box-id';
import type { BoxRecord, BoxState, BoxSummary } from '../boxes/box-model';
import { picturesOf } from '../boxes/box-pictures';
import { formatCount } from '../fit-pair/fit-format';
import type { SetSource } from './set-build';

export type SetPhase = 'pending' | 'open' | 'graduated' | 'failed' | 'recovering';
export const SET_PHASES: readonly SetPhase[] = /* @__PURE__ */ Object.freeze(['pending', 'open', 'graduated', 'failed', 'recovering']);

/** The page's state words (one or two each; the figures carry the rest). */
export const PHASE_WORDS: Readonly<Record<SetPhase, string>> = /* @__PURE__ */ Object.freeze({ pending: 'Loading', open: 'Open', graduated: 'Graduated', failed: 'Failed', recovering: 'Failed' });

/** The feed's state chip for each phase (the box template's six states). */
const FEED_STATE: Readonly<Record<SetPhase, BoxState>> = /* @__PURE__ */ Object.freeze({ pending: 'upcoming', open: 'bonding', graduated: 'graduated', failed: 'failed', recovering: 'failed' });

export interface SetCounts {
  /** N, the committed count. */
  readonly count: bigint;
  /** Guarded initial deposits so far. */
  readonly loaded: bigint;
  /** Recorded inside the vault now. */
  readonly inside: bigint;
  /** Picked out (a box that never failed). */
  readonly outside: bigint;
  /** Back with the creator (a failed box). */
  readonly released: bigint;
}

const raw = (value: string): bigint => BigInt(value);

export function countsOf(box: Pick<SetBoxData, 'spec' | 'state'>): SetCounts {
  const count = BigInt(box.spec.count);
  const loaded = raw(box.state.loaded);
  const inside = raw(box.state.inside);
  const gone = loaded > inside ? loaded - inside : 0n;
  return box.state.failed ? { count, loaded, inside, outside: 0n, released: gone } : { count, loaded, inside, outside: gone, released: 0n };
}

/**
 * Whether trading has opened, as the chain says it: the coordinator's trading gate (opened by the loader's complete())
 * and its effective opening time come. Not on the indexer's wire: read over the source's RPC by the page and the feed.
 */
export interface SetTrading {
  readonly open: boolean;
}

/**
 * Open once the gate has opened and a trade sent now would land at or after its opening time: block times strictly
 * increase, so the next block is at least `now + 1` (the loader's complete() opens the gate one second after its block).
 */
export const tradingOf = (gate: { readonly gateOpen: boolean; readonly effectiveOpenAt: bigint; readonly now: bigint }): SetTrading =>
  ({ open: gate.gateOpen && gate.effectiveOpenAt > 0n && gate.now + 1n >= gate.effectiveOpenAt });

/** The box's state from the wire, with the trading gate read on chain; while that is not known the box shows loading. */
export function phaseOf(box: Pick<SetBoxData, 'spec' | 'state'>, trading: SetTrading | null = null): SetPhase {
  if (box.state.failed) {
    const c = countsOf(box);
    return c.released > 0n && c.released < c.loaded ? 'recovering' : 'failed';
  }
  if (box.state.gateOpen) return 'graduated';
  // seedReady is custody (every committed item loaded), not trading: Open needs the gate itself.
  return box.state.seedReady && trading?.open === true ? 'open' : 'pending';
}

/** Basis points of a part of a whole (0..10,000), truncated; 0 for an empty whole. Only this bounded ratio is a number. */
export const bpsOf = (part: bigint, whole: bigint): number => {
  if (whole <= 0n || part <= 0n) return 0;
  const bps = (part * 10_000n) / whole;
  return bps >= 10_000n ? 10_000 : Number(bps);
};

/** "16/40": a part of the count, both grouped. */
export const ofCount = (part: bigint, whole: bigint): string => `${formatCount(part)}/${formatCount(whole)}`;

/** The page's one line under the name: the state and, while loading or going back, how far. */
export function phaseLine(box: Pick<SetBoxData, 'spec' | 'state'>, trading: SetTrading | null = null): string {
  const phase = phaseOf(box, trading);
  const c = countsOf(box);
  if (phase === 'pending') return `${PHASE_WORDS.pending} ${ofCount(c.loaded, c.count)}`;
  if (phase === 'recovering') return `${PHASE_WORDS.failed} · ${ofCount(c.released, c.loaded)} back`;
  if (phase === 'failed' && c.loaded > 0n && c.released === c.loaded) return `${PHASE_WORDS.failed} · all back`;
  return PHASE_WORDS[phase];
}

/** "1%", "5%", "25%". */
export const percentOfBps = (bps: number | bigint): string => `${formatUnits(BigInt(bps), 2)}%`;

export const isNative = (token: string): boolean => /^0x0{40}$/i.test(token);

/** The raise in the price coin, when its decimals are known (ETH: 18); null otherwise (shown as not available). */
export function raiseText(box: Pick<SetBoxData, 'spec'>, coin: { readonly symbol: string; readonly decimals: number } | null): string | null {
  const known = coin ?? (isNative(box.spec.pricing.token) ? { symbol: 'ETH', decimals: 18 } : null);
  return known ? `${formatUnits(raw(box.spec.raise), known.decimals)} ${known.symbol}` : null;
}

/** An add-on box as the feed and the page read it; `set` carries the indexer's row for the page. */
export function setRecord(box: SetBoxData, source: SetSource, asOf: SetFeedWire['asOf']): BoxRecord {
  const native = isNative(box.spec.pricing.token);
  return {
    id: formatBoxId(source.chainId, box.token), chainId: source.chainId, networkLabel: 'Local chain', kind: 'existing',
    name: box.spec.tokenName, ticker: box.spec.tokenSymbol, pairAsset: native ? 'ETH' : 'P', pairDecimals: 18, token: box.token as Address,
    vault: box.vault as Address, itemCount: BigInt(box.spec.count), itemNoun: 'items', demo: false, featured: false, rehearsal: true, order: 0,
    market: null, demoState: null, demoFigures: null, art: null, line: box.spec.description || null, setup: 'Named picks and returns', claims: 'none', spec: null, row: null,
    // The logo the spec commits, shown only once its bytes match (box-pictures.ts); the outside items' pictures are the page's.
    pictures: picturesOf(box.spec.logoSha256, null, source.art),
    set: { source, box, asOf },
  };
}

/** The card: its state chip and one figure (loading and going back with a bar); no price, volume or market cap here. */
export function setSummary(record: BoxRecord, box: SetBoxData, stale: boolean, trading: SetTrading | null = null): BoxSummary {
  const phase = phaseOf(box, trading);
  const c = countsOf(box);
  const figure = phase === 'pending' ? { text: `${PHASE_WORDS.pending} ${ofCount(c.loaded, c.count)}`, barBps: bpsOf(c.loaded, c.count) }
    : phase === 'recovering' ? { text: `${ofCount(c.released, c.loaded)} back`, barBps: bpsOf(c.released, c.loaded) }
      : phase === 'graduated' ? { text: `${ofCount(c.inside, c.count)} inside`, barBps: null }
        : phase === 'open' ? { text: raiseText(box, null) === null ? PHASE_WORDS.open : `Raise ${raiseText(box, null) ?? ''}`, barBps: null }
          : { text: PHASE_WORDS.failed, barBps: null };
  return { record, state: FEED_STATE[phase], figure, mcapRaw: null, progressBps: phase === 'pending' ? bpsOf(c.loaded, c.count) : null, volumeRaw: null, notice: stale ? 'Stale' : null };
}

/** The members as the page lists them: accepted order, each id and its state (Deferred counts as inside, as on chain). */
export interface SetMemberRow {
  readonly index: number;
  readonly id: bigint;
  readonly state: SetMemberState;
}

export function memberRows(members: readonly { readonly index: string; readonly id: string; readonly state: SetMemberState }[]): readonly SetMemberRow[] {
  return members.map((member, position) => ({ index: position, id: raw(member.id), state: member.state }));
}

/** The members a pick may name (inside, not deferred: a failed box has no picks anyway). */
export const pickable = (row: SetMemberRow): boolean => row.state === 'Inside';
/**
 * What a failed box's recovery sends next, at most `batch` each: the items never sent back yet (Inside), and apart the
 * ones its collection refused before (Deferred, still inside, to retry). A full page of refused items never stands in
 * front of items that can go. Retries take turns: `retryAfter` is the accepted position of the last item the previous
 * retry sent, and the next retry starts with the first deferred item after it, wrapping round to the start, so items
 * that stay refused never stand in front of later ones whose refusal has cleared.
 */
export function recoveryOf(rows: readonly SetMemberRow[], batch: number, retryAfter: number | null = null): { readonly untried: readonly bigint[]; readonly retry: readonly bigint[] } {
  const deferred = rows.filter((row) => row.state === 'Deferred');
  const start = retryAfter === null ? -1 : deferred.findIndex((row) => row.index > retryAfter);
  const turn = start <= 0 ? deferred : [...deferred.slice(start), ...deferred.slice(0, start)];
  return {
    untried: rows.filter((row) => row.state === 'Inside').slice(0, batch).map((row) => row.id),
    retry: turn.slice(0, batch).map((row) => row.id),
  };
}
