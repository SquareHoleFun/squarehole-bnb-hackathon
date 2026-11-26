/**
 * SH-287 on the launch page (SH-281 step 4): the creator's rules for a rail's income, as the form holds them and as the
 * contracts take them (bounties/core/src/IRuleSplitter.sol: kinds CREATOR = 1, PILE = 2, BUY_BURN = 3; parts in basis
 * points summing to 10,000; a rule with 0 is not there). The form takes whole percent; the default is Pile 100,
 * today's behaviour.
 */
import { zeroAddress, type Address } from 'viem';

export interface RulesForm {
  creator: string;
  pile: string;
  burn: string;
}

export const RULES_DEFAULT: RulesForm = { creator: '0', pile: '100', burn: '0' };

export type RulesField = keyof RulesForm;

export const RULE_KIND = { creator: 1, pile: 2, burn: 3 } as const;

export interface RulesParts {
  /** Basis points: whole percent times 100. */
  readonly creator: number;
  readonly pile: number;
  readonly burn: number;
}

const WHOLE = /^\d{1,3}$/;

/** Each part's own refusal, then the sum's (it belongs to the pile, the part that is there by default). */
export function rulesRefusals(f: RulesForm): Partial<Record<RulesField, string>> {
  const out: Partial<Record<RulesField, string>> = {};
  for (const key of ['creator', 'pile', 'burn'] as const) {
    const t = f[key].trim();
    if (!WHOLE.test(t) || Number(t) > 100) out[key] = 'A whole number from 0 to 100.';
  }
  if (Object.keys(out).length === 0 && Number(f.creator) + Number(f.pile) + Number(f.burn) !== 100) out.pile = 'The three parts add up to 100.';
  return out;
}

export function readRules(f: RulesForm): { ok: true; parts: RulesParts } | { ok: false; field: RulesField; text: string } {
  const r = rulesRefusals(f);
  const first = (['creator', 'pile', 'burn'] as const).find((k) => r[k]);
  if (first) return { ok: false, field: first, text: r[first]! };
  return { ok: true, parts: { creator: Number(f.creator) * 100, pile: Number(f.pile) * 100, burn: Number(f.burn) * 100 } };
}

/** Pile 100: no rules to send (a sale created without them is Pile 100%). */
export const isPileOnly = (p: RulesParts): boolean => p.pile === 10_000;

/** The rules as the contracts take them: only the parts above 0; the creator's paid to `creator`. */
export function rulesArg(p: RulesParts, creator: Address): { kind: number; bps: number; target: Address }[] {
  const out: { kind: number; bps: number; target: Address }[] = [];
  if (p.creator > 0) out.push({ kind: RULE_KIND.creator, bps: p.creator, target: creator });
  if (p.pile > 0) out.push({ kind: RULE_KIND.pile, bps: p.pile, target: zeroAddress });
  if (p.burn > 0) out.push({ kind: RULE_KIND.burn, bps: p.burn, target: zeroAddress });
  return out;
}

/** A rule's name on screen. */
export const RULE_NAME: Readonly<Record<number, string>> = Object.freeze({ 1: 'Creator', 2: 'Pile', 3: 'Buy back and burn' });

/**
 * A rule's name on screen (SH-281 step 4c).
 *
 * The seam (`named`, wired in RulesPanel through lib/payee-names.ts). A payee is named only after these checks on
 * chain, for this launch:
 * - "Card shop": our shop factory's `isShop(payee)` is true AND the shop's `token()` equals this token;
 * - "Holders" (a stake): `RailStakeFactory.stakeOf(launchCreator, token) == payee`, `isStake(payee)` is true, AND the
 *   stake's `token()` and `factory()` equal this token and our stake factory (lane m's `findStake` does exactly this);
 * anything else stays "Paid to <address>". A CREATOR rule pays an address: it is "Creator" only when that address is
 * the launch's creator; a payee another lane names (a shop of our factory, a stake: `named`) gets that name; any other
 * is "Paid to" its address (the caller shows the address).
 */
export function ruleName(kind: number, target: Address, creator: Address | undefined, named?: (a: Address) => string | undefined): string {
  if (kind !== RULE_KIND.creator) return RULE_NAME[kind] ?? `Rule ${kind}`;
  if (creator && target.toLowerCase() === creator.toLowerCase()) return 'Creator';
  return named?.(target) ?? 'Paid to';
}

/** The addresses the launch's rules pay (CREATOR rules), in rule order, without repeats: for the panels of other lanes. */
export function payeesOf(rules: readonly { kind: number; target: Address }[]): Address[] {
  const out: Address[] = [];
  for (const r of rules) if (r.kind === RULE_KIND.creator && !out.some((a) => a.toLowerCase() === r.target.toLowerCase())) out.push(r.target);
  return out;
}

/**
 * The tax box's line on a Flap sale: what the token's tax processor holds in the quote coin, ready to send. Zero says
 * only that nothing waits there: no tax may have been taken yet, or it may still be held as tokens inside the token.
 */
export function dispatchWaitingText(waiting: bigint): string | null {
  return waiting === 0n ? 'Nothing waiting to send.' : null;
}

/**
 * A Four.meme tax-rules token's state, from its clone: before `createRules()` (no splitter) one press sets up the
 * splitter and the pile; after it, the pile panel when the rules have a pile, none for a pile part of 0.
 */
/** The set-up line before `createRules()`: true with or without a pile part (no pile is made for a pile part of 0). */
export const FOUR_SET_UP_SAYS = 'The rules are fixed; one press (anyone, once) sets them up.';

export function fourRulesState(splitter: Address | undefined, pile: Address | undefined): 'set-up' | 'pile' | 'no-pile' {
  if (!splitter) return 'set-up';
  return pile ? 'pile' : 'no-pile';
}
