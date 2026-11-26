/** Bounded diagnostic data. Never carry RPC text into logs or the monitor. */
export type ValuationFailureCode = 'PIN_INVALID' | 'VALUATION_UNAVAILABLE' | 'INCOME_CAPACITY' | 'OTHER';
export interface ValuationFailure { readonly boxId: bigint; readonly code: ValuationFailureCode }

export class IncomeValuationError extends Error {
  constructor(readonly code: ValuationFailureCode, message: string) { super(message); }
}

export function valuationFailureCode(error: unknown): ValuationFailureCode {
  if (error instanceof IncomeValuationError) return error.code;
  if (!(error instanceof Error)) return 'OTHER';
  if (['income tick log capacity', 'income tick query capacity'].includes(error.message)) return 'INCOME_CAPACITY';
  if (['token income route unavailable', 'token income route changed', 'listing route missing or ambiguous'].includes(error.message)) return 'VALUATION_UNAVAILABLE';
  return 'OTHER';
}
