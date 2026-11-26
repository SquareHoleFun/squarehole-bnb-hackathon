/**
 * Typed domain errors. Every error carries a stable `code` so callers (UI, providers) can branch without parsing
 * messages. Messages never include untrusted input verbatim beyond short, bounded excerpts.
 */

abstract class CodedError<Code extends string> extends Error {
  readonly code: Code;

  constructor(code: Code, message: string) {
    super(message);
    this.code = code;
  }
}

/** `malformed_id`: a core v2 typed id (asset, collection, NFT, launch, market or policy id; SH-V2-T03). */
export type IdentityErrorCode = 'malformed_address' | 'malformed_chain_id' | 'malformed_pair_id' | 'malformed_id';
/** Malformed chain id, address or pair id. */
export class IdentityError extends CodedError<IdentityErrorCode> {
  override readonly name = 'IdentityError';
}

export type AmountErrorCode =
  | 'malformed_raw_amount'
  | 'malformed_decimal'
  | 'negative_amount'
  | 'invalid_decimals'
  // Core v2 amounts (SH-V2-T03): bound to one asset, uint256 range, exact integer division.
  | 'asset_mismatch'
  | 'amount_out_of_range'
  | 'underflow'
  | 'division_by_zero';
/** Malformed raw/decimal amount string or unsupported decimals. Never falls back to a float. */
export class AmountError extends CodedError<AmountErrorCode> {
  override readonly name = 'AmountError';
}

export type CoreModelErrorCode = 'invalid_snapshot' | 'invariant_violation' | 'asset_binding' | 'invalid_quote' | 'not_live';
/**
 * Core v2 model (SH-V2-T03): a vault snapshot, quote or manifest cannot be used. `invariant_violation` means the
 * numbers contradict the escrow identities of v2 docs/03 (for example E*n < m*A); such state is never repaired.
 */
export class CoreModelError extends CodedError<CoreModelErrorCode> {
  override readonly name = 'CoreModelError';
}

export type TimeErrorCode = 'malformed_timestamp' | 'launch_after_now';
/** Malformed ISO-8601 timestamp, or an age requested for a launch after "now". */
export class TimeError extends CodedError<TimeErrorCode> {
  override readonly name = 'TimeError';
}

export type FeedQueryErrorCode = 'unknown_sort' | 'invalid_limit' | 'unknown_snapshot';
/** The query itself is invalid (unknown sort, limit out of range, snapshot not held by the provider). */
export class FeedQueryError extends CodedError<FeedQueryErrorCode> {
  override readonly name = 'FeedQueryError';
}

export type FeedCursorErrorCode = 'malformed' | 'snapshot_mismatch' | 'query_mismatch' | 'out_of_range';
/**
 * The cursor cannot be used for this read. `snapshot_mismatch` means the cursor belongs to another snapshot:
 * the caller must reset its cursor state (03-FEED: "A new snapshot resets cursor state").
 */
export class FeedCursorError extends CodedError<FeedCursorErrorCode> {
  override readonly name = 'FeedCursorError';
}

export type FeedDataErrorCode = 'duplicate_pair' | 'duplicate_platform';
/** Feed items violate an identity invariant (duplicate canonical pair id, more than one platform item). */
export class FeedDataError extends CodedError<FeedDataErrorCode> {
  override readonly name = 'FeedDataError';
}

export interface ValidationIssue {
  /** Dotted path into the validated value, e.g. `items.3.token.address`. Empty for the root. */
  readonly path: string;
  readonly message: string;
}

function summarize(subject: string, issues: readonly ValidationIssue[]): string {
  const first = issues[0];
  const summary = first ? `${first.path || '(root)'}: ${first.message}` : 'unknown problem';
  return `Invalid ${subject} (${issues.length} issue${issues.length === 1 ? '' : 's'}; first: ${summary})`;
}

/**
 * ADR-0008: runtime validation of an M2/M3 contract value (pair detail, position, claim, registry entry, launch
 * draft, fixture file) failed. `issues` lists every problem found, in a deterministic order.
 */
export class DataValidationError extends CodedError<'invalid_data'> {
  override readonly name = 'DataValidationError';
  readonly issues: readonly ValidationIssue[];

  constructor(subject: string, issues: readonly ValidationIssue[]) {
    super('invalid_data', summarize(subject, issues));
    this.issues = Object.freeze([...issues]);
  }
}

export type AccountQueryErrorCode = 'unknown_pair';
/** ADR-0008: an account read names a pair the provider does not know. Never answered with a zero claim. */
export class AccountQueryError extends CodedError<AccountQueryErrorCode> {
  override readonly name = 'AccountQueryError';
}

/** Runtime schema validation failed. `issues` lists every problem found, in a deterministic order. */
export class FeedValidationError extends CodedError<'invalid_feed_data'> {
  override readonly name = 'FeedValidationError';
  readonly issues: readonly ValidationIssue[];

  constructor(subject: string, issues: readonly ValidationIssue[]) {
    super('invalid_feed_data', summarize(subject, issues));
    this.issues = Object.freeze([...issues]);
  }
}

export type VaultRuleCode =
  | 'invalid_totals'
  | 'invalid_amount'
  | 'invalid_quantity'
  | 'last_misfit'
  | 'max_fit_exceeded'
  | 'min_fit_not_met'
  | 'insufficient_fit'
  | 'reserved_account'
  | 'ineligible_ids'
  | 'invalid_id_list'
  | 'not_owner'
  | 'return_below_unit'
  | 'escrow_insolvent'
  | 'dust_guard'
  | 'stream_not_funded'
  | 'unsolicited_misfit'
  // Placeholder tickets (F36 a; docs/design/draw-and-reveal.md), stage 1.
  /** A delivery, named pick or return before graduation (the vault's gate is closed). */
  | 'gate_closed'
  /** The gate opens once, at graduation. */
  | 'gate_already_open'
  /** A ticket needs an unreserved hidden Misfit (h ≥ k); the shelf does not count. */
  | 'no_hidden'
  /** A named pick listed a Misfit that never left the vault (Fable R-09). */
  | 'hidden_misfit'
  /** A named pick or return listed a Misfit whose art is not revealed (Fable R-14). */
  | 'not_revealed'
  /** A reveal for a Misfit that has never left the vault (the collection's exit trigger). */
  | 'not_revealable'
  | 'already_revealed'
  /** The coordinator waives the hand-back fee once (F38 4 hook; stage-1 review). */
  | 'fee_already_waived';
/**
 * v2 T05: a Misfit withdrawal or return, a FIT burn or transfer, or a stream allocation broke a rule of the reference
 * vault arithmetic (`vault-math.ts`, `vault-ledger.ts`). Stage 1 of the placeholder tickets adds the ticket, gate and
 * reveal rules. Nothing changes when this is thrown.
 */
export class VaultRuleError extends CodedError<VaultRuleCode> {
  override readonly name = 'VaultRuleError';
}
