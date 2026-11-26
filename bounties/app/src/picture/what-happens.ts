/**
 * SH-318: "What happens" on the launch forms: where the money of N made-up trades goes, from the form's own rates and
 * the creator's rules. Pure and bigint only: no chain reads, no sends. It claims no more than the code it follows.
 *
 * The trades: `count` trades of `size` each (one whole coin), buys and sells alternating, buys first; a buy pays the
 * buy rate, a sell the sell rate.
 *
 * The rounding:
 * - Flap's curve fee: per trade, rounded UP, as `CurveMath.feeOf` (bounties/flap/src/CurveMath.sol line 49,
 *   `fullMulDivUp(amount, bps, 10_000)`) on the trade's cost (RulesCurveLauncher.sol lines 252 and 400).
 * - Four.meme's fee and tax: per trade, rounded DOWN. The fee tier and the tax are taken by OpenFour's own contracts,
 *   which are not in this repository; this model rounds down and says so.
 * - The rules: one share-out of the whole income, as `RuleSplitter.distribute` (bounties/core/src/RuleSplitter.sol
 *   line 172): in rule order (creator, pile, buy back and burn: lib/rules.ts `rulesArg`), only parts above 0, each
 *   floor(income x bps / 10,000), the last one takes the remainder. The parts add up to the income to the last unit.
 *
 * What it does not know, and so shows as shares, never amounts: Flap's share of the tax (part of each tax goes to
 * Flap's protocol fee; its rate is Flap's, not in this code), and therefore what reaches the rules from Flap's tax.
 */

export const BPS = 10_000n;

/** The creator's three parts in basis points (lib/rules.ts `RulesParts`); without rules everything is the pile's. */
export interface Parts {
  readonly creator: bigint;
  readonly pile: bigint;
  readonly burn: bigint;
}

export const PILE_ONLY: Parts = Object.freeze({ creator: 0n, pile: BPS, burn: 0n });

/** The amount each part receives. */
export interface Split {
  readonly creator: bigint;
  readonly pile: bigint;
  readonly burn: bigint;
}

/** One share-out as `RuleSplitter.distribute` does it (see the head of this file). */
export function splitByRules(income: bigint, parts: Parts): Split {
  if (income < 0n) throw new RangeError('income is never negative');
  const keys = (['creator', 'pile', 'burn'] as const).filter((k) => parts[k] > 0n);
  if (keys.reduce((a, k) => a + parts[k], 0n) !== BPS) throw new RangeError('the parts add up to 10,000');
  const out = { creator: 0n, pile: 0n, burn: 0n };
  let assigned = 0n;
  keys.forEach((k, i) => {
    const part = i === keys.length - 1 ? income - assigned : (income * parts[k]) / BPS;
    out[k] = part;
    assigned += part;
  });
  return out;
}

export type Round = 'up' | 'down';

/** `bps` of `amount`, rounded as stated. */
export function feeOn(amount: bigint, bps: bigint, round: Round): bigint {
  if (amount < 0n || bps < 0n) throw new RangeError('never negative');
  const product = amount * bps;
  return round === 'up' ? (product + BPS - 1n) / BPS : product / BPS;
}

export interface Run {
  readonly count: number;
  readonly size: bigint;
  /** Everything traded. */
  readonly traded: bigint;
  /** What the trades paid at the rates. */
  readonly income: bigint;
}

/** `count` trades of `size`, buys and sells alternating (buys first), each paying its side's rate, rounded per trade. */
export function runTrades(count: number, size: bigint, buyBps: bigint, sellBps: bigint, round: Round): Run {
  const buys = BigInt(Math.ceil(count / 2));
  const sells = BigInt(Math.floor(count / 2));
  const traded = size * BigInt(count);
  const income = buys * feeOn(size, buyBps, round) + sells * feeOn(size, sellBps, round);
  return { count, size, traded, income };
}

/** A flow: the trades, what they paid, and where it went. */
export interface Flow {
  readonly run: Run;
  readonly split: Split;
}

export function flowOf(count: number, size: bigint, buyBps: bigint, sellBps: bigint, round: Round, parts: Parts): Flow {
  const run = runTrades(count, size, buyBps, sellBps, round);
  return { run, split: splitByRules(run.income, parts) };
}

/**
 * Flap: the curve fees of `count` curve trades reach the rules (or, without rules, the pile) at the launch: amounts.
 * After the launch the tax: `burnBps` of it burned, Flap's share taken from the rest at a rate this code does not
 * hold, the rest shared by the parts: shares only.
 */
export interface FlapFlow {
  readonly curve: Flow;
  readonly tax: { readonly burnedBps: bigint; readonly restBps: bigint; readonly parts: Parts };
}

export function flapFlow(count: number, size: bigint, tradeFeeBps: bigint, burnShareBps: bigint, parts: Parts): FlapFlow {
  return {
    curve: flowOf(count, size, tradeFeeBps, tradeFeeBps, 'up', parts),
    tax: { burnedBps: burnShareBps, restBps: BPS - burnShareBps, parts },
  };
}

/**
 * Four.meme: the curve-fee kind pays every curve trade's fee to the pile; the tax kind pays the whole tax (founder
 * share 100% to our vault, lib/four-create.ts) to the rules, or without rules to the pile. Amounts, rounded down.
 */
export function fourFlow(count: number, size: bigint, buyBps: bigint, sellBps: bigint, parts: Parts): Flow {
  return flowOf(count, size, buyBps, sellBps, 'down', parts);
}

/** Basis points as a percent for the screen: "20%", "12.5%", "0.25%". */
export function bpsText(bps: bigint): string {
  const whole = bps / 100n;
  const frac = (bps % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}%` : `${whole}%`;
}
