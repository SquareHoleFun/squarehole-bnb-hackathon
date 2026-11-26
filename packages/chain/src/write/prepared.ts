/**
 * What a writer hands the executor: the exact call, what the person reviews before the wallet opens, and how the
 * receipt is checked before the app may call the result a success.
 */
import type { Address } from '@squarehole/domain';
import type { WriteCall } from './calls';
import type { ChainReader, TxReceipt } from './rpc';

export interface WriteDetail {
  readonly label: string;
  readonly value: string;
}

export type VerifyStage = 'included' | 'finalized';

export type VerifyOutcome<R = unknown> = { readonly ok: true; readonly result: R } | { readonly ok: false; readonly reason: string };

/**
 * Checks a successful receipt against what was requested. At `finalized` it re-reads the chain at the receipt's
 * block (e.g. the registry record of a new launch); only an `ok` outcome at `finalized` counts as success.
 */
export type WriteVerifier<R = unknown> = (receipt: TxReceipt, reader: ChainReader, stage: VerifyStage) => Promise<VerifyOutcome<R>>;

export interface PreparedWrite<R = unknown> {
  readonly call: WriteCall;
  /** `claim` only: the ledger the registry reported for the pair (the call's only allowed target). */
  readonly expectedLedger: Address | null;
  /** Shown before the wallet request (template, bounds, quote, minimum, deadline…). */
  readonly details: readonly WriteDetail[];
  readonly verify: WriteVerifier<R>;
}

export type RefusalCode =
  | 'wiring'
  | 'unsupported_chain'
  | 'invalid_input'
  | 'template_unknown'
  | 'template_not_in_manifest'
  | 'bounds'
  | 'unknown_pair'
  | 'wrong_payout_side'
  | 'nothing_to_claim'
  | 'sold_out'
  | 'not_sold_out'
  | 'quote_failed'
  | 'read_failed';

/**
 * Preparation refused the request before any simulation (it would fail, or the app cannot tell). The reason is shown
 * as `simulation_failed`; nothing reaches the wallet. `fallback` names a DIFFERENT, separately labelled request the
 * page may offer (never selected automatically).
 */
export class PrepareRefusal extends Error {
  readonly code: RefusalCode;
  readonly fallback: 'claim_as_q_when_sold_out' | null;
  constructor(code: RefusalCode, message: string, fallback: 'claim_as_q_when_sold_out' | null = null) {
    super(message);
    this.name = 'PrepareRefusal';
    this.code = code;
    this.fallback = fallback;
  }
}
