import { minOut, parseAmount, parsePercentToBps, type ParseRefusal } from './amounts';

/** Every refusal a form can show, and its words. */
export const REFUSALS = {
  empty: 'Enter an amount.',
  'not-a-number': 'That is not a number.',
  'too-many-decimals': 'Too many decimals.',
  zero: 'The amount is zero.',
  'over-balance': 'More than you hold.',
  // SH-290: Unstake, more than the visitor's stake.
  'over-staked': 'More than you have staked.',
  'over-circulating': 'More than all tokens in circulation.',
  'bad-guard': 'The guard is a percentage from 0 to 100.',
} as const;
export type Refusal = keyof typeof REFUSALS;

export type Checked<T> = { ok: true; value: T } | { ok: false; refusal: Refusal };

const fromParse = (r: ParseRefusal): Refusal => r;

/** The redeem box: what is typed, checked against what the holder has and what circulates. */
export function checkRedeem(args: {
  amountText: string;
  guardText: string;
  decimals: number;
  balance?: bigint;
  circulating?: bigint;
}): Checked<{ amount: bigint; guardBps: bigint }> {
  const a = parseAmount(args.amountText, args.decimals);
  if (!a.ok) return { ok: false, refusal: fromParse(a.reason) };
  if (args.balance !== undefined && a.value > args.balance) return { ok: false, refusal: 'over-balance' };
  if (args.circulating !== undefined && a.value > args.circulating) return { ok: false, refusal: 'over-circulating' };
  const g = parsePercentToBps(args.guardText);
  if (!g.ok) return { ok: false, refusal: 'bad-guard' };
  return { ok: true, value: { amount: a.value, guardBps: g.value } };
}

/** The minimum a redemption accepts, from the contract's own quote and the guard. */
export function redeemMinOut(quote: bigint, guardBps: bigint): bigint {
  return minOut(quote, guardBps);
}
