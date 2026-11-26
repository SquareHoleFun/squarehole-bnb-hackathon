/**
 * A v2 box as its page reads it (M1-53-b; ADR-0017 § 5, § 6; F99, F100, F103, F104). Pure data, bigint only.
 *
 * `BoxV2Facts` is this slot's stub of what M1-52's indexer will answer for a v2 box (wave 2 meets it): the
 * coordinator's views (`openAt`, `gateOpen`, `effectiveOpenAt`, `deadline`, `failed`, `failCause`, `failedAt`), the
 * hook's `ClosingRangeEntered` (`pInRange`, `tOutstanding`) and `ClosingTipPaid` (`amount`), the listing's `tipMaxQ`,
 * T's implementation decoded from its 182-byte clone, and the release's `implementation(ROLE_TOKEN)` from the manifest.
 * The Demo fills it with invented values (demo-v2.ts).
 */
import { vetExternalHref } from '@squarehole/links';
import { testnetContractHref } from '../../data-source/testnet';
import { MAX_TOKEN_DECIMALS, type Address } from '@squarehole/domain';
import { formatCount, significant } from '../../fit-pair/fit-format';
import { GATE_CAP_SECONDS, type CloseCall, type FailCauseName } from './v2-frozen';

/** The box's pricing token P (field 10): ETH (address null) or a listed ERC-20 with its own decimals. */
export interface PricingTokenV2 {
  readonly symbol: string;
  readonly decimals: number;
  readonly address: Address | null;
}

/** What the closing range holds, as the hook reported it, and the closer's tip, all raw. */
export interface ClosingFacts {
  readonly pInRange: bigint;
  readonly tOutstanding: bigint;
  readonly tip: bigint;
}

export interface BoxV2Facts {
  /** Where the facts were read: links follow the source, never the chain id alone. */
  readonly network: 'demo' | 'local' | 'sepolia';
  readonly coordinator: Address;
  readonly pricing: PricingTokenV2;
  /** Unix seconds. */
  readonly openAt: bigint;
  readonly gateOpen: boolean;
  /** 0 while the gate holds. */
  readonly effectiveOpenAt: bigint;
  /** `effectiveOpenAt` + the spec's days; 0 while the gate holds (no deadline yet). */
  readonly deadline: bigint;
  /** The curve: still open, filled (graduating; seven-day hatch), or graduated. */
  readonly curve: 'open' | 'filled' | 'graduated';
  readonly closedAt?: bigint;
  readonly failure: { readonly cause: FailCauseName; readonly at: bigint; readonly closing: ClosingFacts | null } | null;
  /** The most the closer's tip can be, in P raw (`QParameters.tipMaxQ`). */
  readonly tipMaxQ: bigint;
  /** T's implementation as the indexer decoded it from T's code; null when not read. */
  readonly tImplementation: Address | null;
  /** The release's T implementation (`implementation(ROLE_TOKEN)`), from the manifest; null when unknown. */
  readonly releaseTImplementation: Address | null;
}

export type CloseState =
  | { readonly kind: 'closed'; readonly cause: FailCauseName; readonly at: bigint; readonly closing: ClosingFacts | null }
  | { readonly kind: 'closable'; readonly call: CloseCall; readonly since: bigint }
  | { readonly kind: 'waiting'; readonly from: bigint }
  | { readonly kind: 'cannot' };

/**
 * Whether anyone may close the box now, and with which entry (IBoxCoordinatorV2): `fail()` from `deadline()` while
 * the curve is open, `failClosed()` from `openAt()` + 14 days while the gate holds. A filled curve may fail after seven days; a graduated curve cannot fail. The page's clock stands in for the block's time, so a press a few seconds early is refused by
 * the contract (`DeadlineNotReached`), never sent past it.
 */
export function closeStateOf(facts: BoxV2Facts, nowSec: bigint): CloseState {
  if (facts.failure) return { kind: 'closed', ...facts.failure };
  if (facts.curve === 'graduated') return { kind: 'cannot' };
  if (facts.curve === 'filled') {
    if (!facts.closedAt || facts.closedAt <= 0n) return { kind: 'cannot' };
    const from = facts.closedAt + 604800n;
    return nowSec >= from ? { kind: 'closable', call: 'fail', since: from } : { kind: 'waiting', from };
  }
  const from = facts.gateOpen ? facts.deadline : facts.openAt + GATE_CAP_SECONDS;
  if (facts.gateOpen && from === 0n) return { kind: 'cannot' };
  return nowSec >= from ? { kind: 'closable', call: facts.gateOpen ? 'fail' : 'failClosed', since: from } : { kind: 'waiting', from };
}

/** Decimals an amount can be shown at (the domain's 0-36); anything else is a broken answer, shown as not available. */
export const showableDecimals = (decimals: number): boolean => Number.isInteger(decimals) && decimals >= 0 && decimals <= MAX_TOKEN_DECIMALS;

/** Extra digits kept before the cut to 5 significant digits, so a small price is never truncated to 0. */
const EXTRA = 12;

/** raw ÷ 10^scale as a plain decimal string ("0.0042068292…"). */
function decimal(raw: bigint, scale: number): string {
  const digits = raw.toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * The closing price in P per 1M tokens (the site's price unit): the closing pool over the tokens it pays, 5
 * significant digits, truncated (it never overstates). Null when no token is left to pay, and for a broken answer (a
 * negative pool, decimals outside 0-36), so the page says "Not available" rather than a wrong price.
 */
export function closingPricePerMillion(closing: ClosingFacts, decimals: number): string | null {
  if (closing.tOutstanding <= 0n || closing.pInRange < 0n || !showableDecimals(decimals)) return null;
  // T has 18 decimals: P raw per 1M whole tokens = pInRange × 10^6 × 10^18 ÷ tOutstanding.
  const scaled = (closing.pInRange * 10n ** BigInt(24 + EXTRA)) / closing.tOutstanding;
  const text = significant(decimal(scaled, decimals + EXTRA), 5);
  const [whole = '0', fraction] = text.split('.');
  return `${formatCount(BigInt(whole))}${fraction ? `.${fraction}` : ''}`;
}

/** "Clone, not upgradeable" only when T's implementation is the release's (F103; M1-52 refuses any other). */
export function tokenFormOf(facts: BoxV2Facts): { readonly kind: 'clone'; readonly implementation: Address } | { readonly kind: 'unchecked' } {
  const found = facts.tImplementation;
  const release = facts.releaseTImplementation;
  return found !== null && release !== null && found.toLowerCase() === release.toLowerCase() ? { kind: 'clone', implementation: found } : { kind: 'unchecked' };
}

/** The explorer's code tab of the verified implementation (Sepolia only, through the links allowlist), or null. */
export function implementationHref(facts: BoxV2Facts): string | null {
  const form = tokenFormOf(facts);
  if (form.kind !== 'clone') return null;
  const page = testnetContractHref(facts.network, form.implementation);
  if (page === null) return null;
  const vetted = vetExternalHref(`${page}#code`, 'explorer');
  return vetted.ok ? vetted.href : null;
}
