/**
 * Transaction state machine shared by launch creation and reward claims (06-ARCHITECTURE; UI-08; ECO-07).
 *
 *   idle -> preparing -> simulation_failed | awaiting_signature -> rejected | submitted -> pending
 *        -> confirmed_unfinalized -> finalized | reverted | replaced | timed_out | unknown
 *   wrong_chain: the wallet is on another chain when the request is prepared (a described switch, never a silent
 *                transaction on another network); switching to the expected chain re-simulates.
 *   invalidated: the account, chain or quote deadline changed BEFORE signing, so the simulated request is stale.
 *
 * Rules: a pure reducer over a discriminated union. Illegal events return the SAME state object (no-op). A hash is
 * never success: only `finalized` is terminal success. A reorg returns confirmed_unfinalized to pending. After
 * signing, chain/account/deadline changes do not alter the submitted transaction (the contract enforces its own
 * deadline and minimum, which surface as `reverted`). Late inclusion after timed_out/unknown is still tracked.
 * Malformed payloads (hash, block, context) are ignored as illegal: events can originate from an untrusted wallet/RPC.
 */
import { isRawAmount } from './amounts';
import { isAddress, isChainId, sameAddress } from './ids';
import { isIsoTimestamp, parseIsoTimestamp } from './time';
import type { Address, TxHash } from './types';

export type TxKind = 'create_launch' | 'claim';

export interface TxContext {
  readonly kind: TxKind;
  /** The chain the request is built and simulated for (the app's configured chain). */
  readonly chainId: number;
  readonly account: Address;
  /** Quote deadline (ISO) for claim conversions; null when the request has none. */
  readonly deadline: string | null;
}

export type InvalidationCause = 'account_changed' | 'chain_changed' | 'deadline_passed';

export type TxState =
  | { readonly status: 'idle' }
  | { readonly status: 'preparing'; readonly ctx: TxContext }
  | { readonly status: 'simulation_failed'; readonly ctx: TxContext; readonly reason: string }
  | { readonly status: 'wrong_chain'; readonly ctx: TxContext; readonly walletChainId: number }
  | { readonly status: 'awaiting_signature'; readonly ctx: TxContext }
  | { readonly status: 'rejected'; readonly ctx: TxContext }
  | { readonly status: 'invalidated'; readonly ctx: TxContext; readonly cause: InvalidationCause }
  | { readonly status: 'submitted'; readonly ctx: TxContext; readonly hash: TxHash }
  | { readonly status: 'pending'; readonly ctx: TxContext; readonly hash: TxHash }
  | { readonly status: 'replaced'; readonly ctx: TxContext; readonly hash: TxHash; readonly newHash: TxHash }
  | { readonly status: 'confirmed_unfinalized'; readonly ctx: TxContext; readonly hash: TxHash; readonly block: string }
  | { readonly status: 'finalized'; readonly ctx: TxContext; readonly hash: TxHash; readonly block: string }
  | { readonly status: 'reverted'; readonly ctx: TxContext; readonly hash: TxHash; readonly reason: string }
  | { readonly status: 'timed_out'; readonly ctx: TxContext; readonly hash: TxHash }
  | { readonly status: 'unknown'; readonly ctx: TxContext; readonly hash: TxHash; readonly reason: string };

export type TxStatus = TxState['status'];

export type TxEvent =
  | { readonly type: 'prepare'; readonly ctx: TxContext; readonly walletChainId: number }
  | { readonly type: 'simulate_ok' }
  | { readonly type: 'simulate_fail'; readonly reason: string }
  | { readonly type: 'chain_changed'; readonly chainId: number }
  | { readonly type: 'account_changed'; readonly account: Address }
  | { readonly type: 'deadline_passed'; readonly at: string }
  | { readonly type: 'sign'; readonly hash: TxHash }
  | { readonly type: 'reject' }
  | { readonly type: 'broadcast' }
  | { readonly type: 'included'; readonly block: string }
  | { readonly type: 'reorged' }
  | { readonly type: 'finalized' }
  | { readonly type: 'reverted'; readonly reason: string }
  | { readonly type: 'replaced'; readonly newHash: TxHash }
  | { readonly type: 'timeout' }
  | { readonly type: 'status_unknown'; readonly reason: string }
  | { readonly type: 'reset' };

export type TxEventType = TxEvent['type'];

export const TX_STATUSES: readonly TxStatus[] = Object.freeze([
  'idle',
  'preparing',
  'simulation_failed',
  'wrong_chain',
  'awaiting_signature',
  'rejected',
  'invalidated',
  'submitted',
  'pending',
  'replaced',
  'confirmed_unfinalized',
  'finalized',
  'reverted',
  'timed_out',
  'unknown',
] as const);

export const TX_EVENT_TYPES: readonly TxEventType[] = Object.freeze([
  'prepare',
  'simulate_ok',
  'simulate_fail',
  'chain_changed',
  'account_changed',
  'deadline_passed',
  'sign',
  'reject',
  'broadcast',
  'included',
  'reorged',
  'finalized',
  'reverted',
  'replaced',
  'timeout',
  'status_unknown',
  'reset',
] as const);

export const TX_IDLE: TxState = Object.freeze({ status: 'idle' });

const TERMINAL: ReadonlySet<TxStatus> = new Set(['simulation_failed', 'rejected', 'invalidated', 'replaced', 'finalized', 'reverted']);

/** Only `finalized` is success. A hash, `submitted`, `pending` or `confirmed_unfinalized` never is (UI-08). */
export function isTxSuccess(state: TxState): boolean {
  return state.status === 'finalized';
}

/** Terminal states accept only `reset`. `timed_out` and `unknown` are not terminal: the transaction may still land. */
export function isTxTerminal(state: TxState): boolean {
  return TERMINAL.has(state.status);
}

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const isTxHash = (value: unknown): value is TxHash => typeof value === 'string' && HASH_PATTERN.test(value);
const isReason = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 500;

function isValidContext(ctx: unknown): ctx is TxContext {
  if (typeof ctx !== 'object' || ctx === null) return false;
  const c = ctx as Record<string, unknown>;
  return (
    (c.kind === 'create_launch' || c.kind === 'claim') &&
    isChainId(c.chainId) &&
    isAddress(c.account) &&
    (c.deadline === null || isIsoTimestamp(c.deadline))
  );
}

const freeze = (state: TxState): TxState => Object.freeze(state);

/** States in which the request has been simulated/prepared but not yet signed. */
type BeforeSigning = Extract<TxState, { status: 'preparing' | 'wrong_chain' | 'awaiting_signature' }>;
/** States in which a signed transaction's outcome is still open. */
type Unresolved = Extract<TxState, { status: 'submitted' | 'pending' | 'timed_out' | 'unknown' }>;

const isBeforeSigning = (state: TxState): state is BeforeSigning =>
  state.status === 'preparing' || state.status === 'wrong_chain' || state.status === 'awaiting_signature';
const isUnresolved = (state: TxState): state is Unresolved =>
  state.status === 'submitted' || state.status === 'pending' || state.status === 'timed_out' || state.status === 'unknown';

function beforeSigning(state: BeforeSigning, event: TxEvent): TxState {
  const { ctx } = state;
  switch (event.type) {
    case 'account_changed':
      if (!isAddress(event.account) || sameAddress(event.account, ctx.account)) return state;
      return freeze({ status: 'invalidated', ctx, cause: 'account_changed' });
    case 'deadline_passed':
      if (ctx.deadline === null || !isIsoTimestamp(event.at)) return state;
      if (parseIsoTimestamp(event.at) < parseIsoTimestamp(ctx.deadline)) return state;
      return freeze({ status: 'invalidated', ctx, cause: 'deadline_passed' });
    case 'chain_changed':
      if (!isChainId(event.chainId)) return state;
      if (state.status === 'wrong_chain') {
        if (event.chainId === ctx.chainId) return freeze({ status: 'preparing', ctx });
        if (event.chainId === state.walletChainId) return state;
        return freeze({ status: 'wrong_chain', ctx, walletChainId: event.chainId });
      }
      if (event.chainId === ctx.chainId) return state;
      return freeze({ status: 'invalidated', ctx, cause: 'chain_changed' });
    case 'simulate_ok':
      return state.status === 'preparing' ? freeze({ status: 'awaiting_signature', ctx }) : state;
    case 'simulate_fail':
      return state.status === 'preparing' && isReason(event.reason) ? freeze({ status: 'simulation_failed', ctx, reason: event.reason }) : state;
    case 'sign':
      return state.status === 'awaiting_signature' && isTxHash(event.hash) ? freeze({ status: 'submitted', ctx, hash: event.hash }) : state;
    case 'reject':
      return state.status === 'awaiting_signature' ? freeze({ status: 'rejected', ctx }) : state;
    default:
      return state;
  }
}

function afterSigning(state: Unresolved, event: TxEvent): TxState {
  const { ctx, hash } = state;
  switch (event.type) {
    case 'broadcast':
      return state.status === 'submitted' ? freeze({ status: 'pending', ctx, hash }) : state;
    case 'included':
      return isRawAmount(event.block) ? freeze({ status: 'confirmed_unfinalized', ctx, hash, block: event.block }) : state;
    case 'reverted':
      return isReason(event.reason) ? freeze({ status: 'reverted', ctx, hash, reason: event.reason }) : state;
    case 'replaced':
      return isTxHash(event.newHash) && event.newHash.toLowerCase() !== hash.toLowerCase()
        ? freeze({ status: 'replaced', ctx, hash, newHash: event.newHash })
        : state;
    case 'timeout':
      return state.status === 'submitted' || state.status === 'pending' ? freeze({ status: 'timed_out', ctx, hash }) : state;
    case 'status_unknown':
      return (state.status === 'submitted' || state.status === 'pending') && isReason(event.reason)
        ? freeze({ status: 'unknown', ctx, hash, reason: event.reason })
        : state;
    default:
      return state;
  }
}

/** Pure reducer. Never mutates `state`; returns the same object for every illegal or malformed event. */
export function txReducer(state: TxState, event: TxEvent): TxState {
  if (event.type === 'reset') return state.status === 'idle' ? state : TX_IDLE;
  if (state.status === 'idle') {
    if (event.type !== 'prepare' || !isValidContext(event.ctx) || !isChainId(event.walletChainId)) return state;
    const ctx = Object.freeze({ ...event.ctx });
    return event.walletChainId === ctx.chainId
      ? freeze({ status: 'preparing', ctx })
      : freeze({ status: 'wrong_chain', ctx, walletChainId: event.walletChainId });
  }
  if (isBeforeSigning(state)) return beforeSigning(state, event);
  if (isUnresolved(state)) return afterSigning(state, event);
  if (state.status === 'confirmed_unfinalized') {
    if (event.type === 'finalized') return freeze({ status: 'finalized', ctx: state.ctx, hash: state.hash, block: state.block });
    if (event.type === 'reorged') return freeze({ status: 'pending', ctx: state.ctx, hash: state.hash });
  }
  return state;
}
