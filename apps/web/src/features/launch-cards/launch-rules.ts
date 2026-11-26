/**
 * SH-289: the one short line of a launch's rules on its card. A launch without the creator's rules has one rule, its
 * pile, and all of its share goes there ("pile 100"). SH-304: a launch with the creator's rules shows them as read from
 * the chain ("creator 10 · pile 60 · burn 30"); when they, or the launch's kind, cannot be read, its card shows no rule
 * line rather than a wrong one.
 *
 * The reading is a copy, not an import (the web image cannot resolve bounties/app's modules; see launch-reads.ts):
 * - a Flap rules launch (made by one of the deployment file's `flap.rules` launcher factories): `rulesOf(launcher)` at
 *   the pair's rules vault factory, the factory's record of the rules stored before the sale
 *   (bounties/app/src/lib/shop.ts `flapRulesPayees`, FlapSale.tsx `StoredRules`); the factory keeps it after the launch
 *   too (bounties/flap/src/RulesVaultFactory.sol `rulesOf`, PILE 100% when none were set);
 * - a Four.meme token: its kind and rules as bounties/app/src/screens/FourToken.tsx `findPile` proves them (the preset
 *   by Core's record; a tax token's vault, reached from the token's own founder, a clone of the file's `rulesTemplate`
 *   or `taxTemplate`; a rules clone's fixed parts);
 * - the kinds and who a rule pays: bounties/app/src/lib/rules.ts (`RULE_KIND`, `payeesOf`, `ruleName`);
 * - the payee names the chain proves: bounties/app/src/lib/payee-names.ts (`payeeNames`), "Card shop" and "Holders".
 */
import { zeroAddress, type Address, type PublicClient } from 'viem';
import {
  FORWARD_VAULT_ABI, LAUNCHER_VAULT_FACTORY_ABI, RULE_VIEWS_ABI, RULES_FACTORY_ABI, RULES_TAX_VAULT_ABI, SHOP_FACTORY_ABI, STAKE_FACTORY_ABI, TAX_TOKEN_FOUNDER_ABI,
} from './launch-abis';

export interface RuleSubject {
  readonly rail: 'flap' | 'four';
  readonly address: Address;
}

/**
 * SH-304 step 3: inside one part the word and its number are joined by non-breaking spaces ("card shop 40" stays
 * whole on a narrow card); the separator " · " between parts stays breakable. The visible words are the same.
 */
const NBSP = '\u00a0';
const part = (word: string, amount: string): string => `${word} ${amount}`.replace(/ /g, NBSP);

/** The line of a launch whose whole rule share goes to its pile (a Flap launch without rules; see `readFourRulesLine`). */
export const PILE_ONLY = part('pile', '100');

/** A Flap launch without the creator's rules: the launch's pile takes its whole rule share. */
export function launchRuleLine(launch: RuleSubject): string | null {
  return launch.rail === 'flap' || launch.rail === 'four' ? PILE_ONLY : null;
}

// ------------------------------------------------------------------------------------------------ the rules' line

/** bounties/app/src/lib/rules.ts `RULE_KIND` (bounties/core/src/IRuleSplitter.sol: NONE 0, CREATOR 1, PILE 2, BUY_BURN 3). */
export const RULE_KIND = { creator: 1, pile: 2, burn: 3 } as const;

export interface RuleRow {
  readonly kind: number;
  /** Basis points: 10,000 is the whole share. */
  readonly bps: number;
  readonly target: Address;
}

/**
 * The words on the card, short and lower-case as "pile 100". A CREATOR rule reads "creator" only when it pays the
 * launch's creator (rules.ts `ruleName`), "card shop" / "holders" only with their proofs, and "paid out" for any other
 * address (the launch page's "Paid to <address>"): never the creator's name for someone else's money.
 */
export const RULE_WORD = Object.freeze({ creator: 'creator', pile: 'pile', burn: 'burn', shop: 'card shop', holders: 'holders', other: 'paid out' });

/** A part in whole percent ("10"); a part that is not whole keeps its two decimals ("33.33"), never rounded. */
const percent = (bps: number): string => (bps % 100 === 0 ? String(bps / 100) : `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, '0')}`);

const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

/**
 * The line for `rules` in rule order, or null when it could not be true: no rule, a kind the page does not know, or
 * parts that do not add up to the whole. A CREATOR rule's word: "creator" when it pays `creator`, else its proven name
 * (`named`: "card shop", "holders"), else "paid out".
 */
export function rulesLine(rules: readonly RuleRow[], creator: Address, named: (target: Address) => string | undefined = () => undefined): string | null {
  if (rules.length === 0) return null;
  let total = 0;
  const parts: string[] = [];
  for (const r of rules) {
    if (!Number.isInteger(r.bps) || r.bps <= 0 || r.bps > 10_000) return null;
    total += r.bps;
    const word = r.kind === RULE_KIND.creator ? (same(r.target, creator) ? RULE_WORD.creator : (named(r.target) ?? RULE_WORD.other))
      : r.kind === RULE_KIND.pile ? RULE_WORD.pile
      : r.kind === RULE_KIND.burn ? RULE_WORD.burn
      : null;
    if (word === null) return null;
    parts.push(part(word, percent(r.bps)));
  }
  return total === 10_000 ? parts.join(' · ') : null;
}

/** bounties/app/src/lib/rules.ts `payeesOf`: the addresses CREATOR rules pay, in rule order, without repeats. */
export function payeesOf(rules: readonly { kind: number; target: Address }[]): Address[] {
  const out: Address[] = [];
  for (const r of rules) if (r.kind === RULE_KIND.creator && !out.some((a) => a.toLowerCase() === r.target.toLowerCase())) out.push(r.target);
  return out;
}

// ------------------------------------------------------------------------------------------------ the proven names

/** bounties/app/src/lib/payee-names.ts: one read of a view (it fails when it reverts or the address has no such view). */
export type ViewRead = (address: Address, fn: 'isShop' | 'shopToken' | 'stakeOf' | 'isStake' | 'stakeToken' | 'stakeFactory', args?: readonly Address[]) => Promise<unknown>;

/**
 * bounties/app/src/lib/payee-names.ts `payeeNames`, check for check: "card shop" when our shop factory's
 * `isShop(payee)` is true AND the shop's `token()` is this token; "holders" when our stake factory's
 * `stakeOf(creator, token)` is the payee, `isStake(payee)` is true AND the stake's `token()` and `factory()` are this
 * token and our stake factory. Anything else gets no name. One difference: the payees are checked one after the other
 * (the original checks them all at once), to keep this feature's few reads at a time.
 */
export async function payeeNames(
  read: ViewRead,
  f: { readonly shops?: Address | undefined; readonly stakes?: Address | undefined },
  launch: { readonly token: Address; readonly creator: Address },
  payees: readonly Address[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const safe = (p: Promise<unknown>) => p.catch(() => undefined);
  const stakeOf = f.stakes ? await safe(read(f.stakes, 'stakeOf', [launch.creator, launch.token])) : undefined;
  for (const payee of payees) {
    if (f.shops) {
      const [isShop, token] = await Promise.all([safe(read(f.shops, 'isShop', [payee])), safe(read(payee, 'shopToken'))]);
      if (isShop === true && same(token, launch.token)) {
        out[payee.toLowerCase()] = RULE_WORD.shop;
        continue;
      }
    }
    if (f.stakes && same(stakeOf, payee)) {
      const [isStake, token, factory] = await Promise.all([safe(read(f.stakes, 'isStake', [payee])), safe(read(payee, 'stakeToken')), safe(read(payee, 'stakeFactory'))]);
      if (isStake === true && same(token, launch.token) && same(factory, f.stakes)) out[payee.toLowerCase()] = RULE_WORD.holders;
    }
  }
  return out;
}

type ReadClient = Pick<PublicClient, 'readContract'>;

/** payee-names.ts `chainViewRead`: each name maps to its contract's view. */
export function chainViewRead(c: ReadClient): ViewRead {
  return (address, fn, args = []) => {
    switch (fn) {
      case 'isShop':
        return c.readContract({ address, abi: SHOP_FACTORY_ABI, functionName: 'isShop', args: [args[0]] });
      case 'stakeOf':
        return c.readContract({ address, abi: STAKE_FACTORY_ABI, functionName: 'stakeOf', args: [args[0], args[1]] });
      case 'isStake':
        return c.readContract({ address, abi: STAKE_FACTORY_ABI, functionName: 'isStake', args: [args[0]] });
      case 'shopToken':
      case 'stakeToken':
        return c.readContract({ address, abi: RULE_VIEWS_ABI, functionName: 'token' });
      case 'stakeFactory':
        return c.readContract({ address, abi: RULE_VIEWS_ABI, functionName: 'factory' });
    }
  };
}

/** Our shop and stake factories: a payee is named only against them. */
export interface PayeeFactories {
  readonly shops?: Address | undefined;
  readonly stakes?: Address | undefined;
}

/** The line of `rules` paid for `token` by `creator`'s launch: the proven names read only for payees besides the creator. */
async function lineWithNames(c: ReadClient, rules: readonly RuleRow[], creator: Address, token: () => Promise<Address>, f: PayeeFactories): Promise<string | null> {
  const others = payeesOf(rules).filter((p) => !same(p, creator));
  if (others.length === 0 || (!f.shops && !f.stakes)) return rulesLine(rules, creator);
  const names = await payeeNames(chainViewRead(c), { shops: f.shops, stakes: f.stakes }, { token: await token(), creator }, others);
  return rulesLine(rules, creator, (target) => names[target.toLowerCase()]);
}

// ------------------------------------------------------------------------------------------------ Flap

/** Where a Flap rules launch's rules are recorded, and the factories whose payees can get a proven name. */
export interface RulesSource extends PayeeFactories {
  readonly rulesVaultFactory: Address;
}

/**
 * A Flap rules launch's line: first the launcher's own `pileVaultFactory()` (bounties/app/src/lib/stake.ts
 * `flapPayees`), which must be the pair's rules vault factory: that factory answers PILE 100% for a launcher it holds
 * no rules for (RulesVaultFactory.sol `rulesOf`), so a launcher of another factory would read a false "pile 100"; then
 * its rules (`rulesOf(launcher)` there) and its creator (`creator()`); for CREATOR rules that pay someone else, the
 * launch's token (`predictedToken()`: the address the launch creates and checks, the same before and after it) and the
 * proven names. A read that fails fails the line.
 */
export async function readRulesLine(c: ReadClient, launcher: Address, source: RulesSource): Promise<string | null> {
  const [vaults, creator] = await Promise.all([
    c.readContract({ address: launcher, abi: LAUNCHER_VAULT_FACTORY_ABI, functionName: 'pileVaultFactory' }) as Promise<Address>,
    c.readContract({ address: launcher, abi: RULE_VIEWS_ABI, functionName: 'creator' }) as Promise<Address>,
  ]);
  if (!same(vaults, source.rulesVaultFactory)) return null;
  const stored = (await c.readContract({ address: source.rulesVaultFactory, abi: RULES_FACTORY_ABI, functionName: 'rulesOf', args: [launcher] })) as readonly { kind: number | bigint; bps: number | bigint; target: Address }[];
  const rules: RuleRow[] = stored.map((r) => ({ kind: Number(r.kind), bps: Number(r.bps), target: r.target }));
  return lineWithNames(c, rules, creator, async () => (await c.readContract({ address: launcher, abi: RULE_VIEWS_ABI, functionName: 'predictedToken' })) as Address, source);
}

// ------------------------------------------------------------------------------------------------ Four.meme

/** FourToken.tsx `isCloneOf`: EIP-1167 clone code of `impl` (OpenZeppelin's 45-byte runtime). */
export function isCloneOf(code: string | undefined, impl: Address): boolean {
  return (code ?? '').toLowerCase() === `0x363d3d373d3d3d363d73${impl.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
}

/** The deployment file's OpenFour entries that decide a token's kind (config.ts), and the payee factories. */
export interface FourRulesSource extends PayeeFactories {
  readonly presetId?: bigint | undefined;
  readonly taxPresetId?: bigint | undefined;
  readonly taxTemplate?: Address | undefined;
  readonly rulesTemplate?: Address | undefined;
}

/**
 * FourToken.tsx `findPile`'s first decision: Core's preset id says preset or tax; without a match, the file's entry
 * ("tax-rules" and "tax" are tax tokens whose clone is proven next). A "preset" entry counts only when the file carries
 * no preset ids at all, as FourToken.tsx counts such a token ours (lines 70 and 115, `known` and `ours`); with preset ids in the file, a
 * token whose Core preset id matches neither is not ours and its card claims nothing (SH-304 step 3). A token with
 * neither a matching preset id nor an entry is unknown (FourToken.tsx reads it as a preset token): no line either.
 */
export function fourKind(presetId: bigint, entryKind: string | undefined, s: FourRulesSource): 'preset' | 'tax' | null {
  if (s.taxPresetId !== undefined && presetId === s.taxPresetId) return 'tax';
  if (s.presetId !== undefined && presetId === s.presetId) return 'preset';
  if (entryKind === 'tax-rules' || entryKind === 'tax') return 'tax';
  if (entryKind === 'preset' && s.presetId === undefined && s.taxPresetId === undefined) return 'preset';
  return null;
}

type FourClient = Pick<PublicClient, 'readContract' | 'getCode'>;

/**
 * A Four.meme token's line, as FourToken.tsx proves its kind:
 * - a preset token: "pile 100" (the launch page: "Each curve trade pays … into the pile");
 * - a tax token: its vault, from the token's own `founder()` and that ForwardVault's `clonedVault()`; a clone of the
 *   file's `rulesTemplate` shows the parts it fixed (`creator`, `creatorBps`, `pileBps`, `burnBps`, in that order, as
 *   FourToken.tsx lists them); a clone of `taxTemplate` "pile 100" (the launch page: "the tax it collects goes to the
 *   pile through OpenFour's tax vault"; the creation signer fixes the founder's share at 100,
 *   bounties/openfour/sign/sign-create.js); a clone of neither: no line.
 * `record` is Core's (`tokens(token)`): its creator names the "creator" rule, as on the launch page. A read that fails
 * fails the line.
 */
export async function readFourRulesLine(c: FourClient, token: Address, record: { readonly presetId: bigint; readonly creator: Address }, entryKind: string | undefined, s: FourRulesSource): Promise<string | null> {
  const kind = fourKind(record.presetId, entryKind, s);
  if (kind !== 'tax') return kind === 'preset' ? PILE_ONLY : null;
  const founder = (await c.readContract({ address: token, abi: TAX_TOKEN_FOUNDER_ABI, functionName: 'founder' })) as Address;
  const clone = (await c.readContract({ address: founder, abi: FORWARD_VAULT_ABI, functionName: 'clonedVault' })) as Address;
  const code = await c.getCode({ address: clone });
  if (s.rulesTemplate && isCloneOf(code, s.rulesTemplate)) {
    const r = (functionName: string) => c.readContract({ address: clone, abi: RULES_TAX_VAULT_ABI, functionName });
    const [payee, creatorBps] = (await Promise.all([r('creator'), r('creatorBps')])) as [Address, number | bigint];
    const [pileBps, burnBps] = (await Promise.all([r('pileBps'), r('burnBps')])) as [number | bigint, number | bigint];
    const rules: RuleRow[] = [];
    if (Number(creatorBps) > 0) rules.push({ kind: RULE_KIND.creator, bps: Number(creatorBps), target: payee });
    if (Number(pileBps) > 0) rules.push({ kind: RULE_KIND.pile, bps: Number(pileBps), target: zeroAddress });
    if (Number(burnBps) > 0) rules.push({ kind: RULE_KIND.burn, bps: Number(burnBps), target: zeroAddress });
    return lineWithNames(c, rules, record.creator, async () => token, s);
  }
  return s.taxTemplate && isCloneOf(code, s.taxTemplate) ? PILE_ONLY : null;
}
