/**
 * Links out of a core v1 box, built from its registry row (S10a § 6; BC-099, BC-092): the box's own Q and token, its
 * pool id and its contracts, never a name, a build-time record or per-box code.
 *
 * - **Uniswap** (execution): `inputCurrency` = `ETH` for native Q, else the Q address; `outputCurrency` = T; the chain
 *   from the source. A link only while the box trades on any route: **bonding and graduated**. Shut in upcoming (no
 *   route can buy), the launch window (buys only through the launch router, taxed), graduating (the contract's Closed:
 *   every swap reverts until graduate()) and failed. And only with a passing route-evidence record for the box's
 *   TEMPLATE and Q CLASS (`squarehole.route-evidence/v2`, BC-070's rule), not per pool: a new box of a tested template
 *   needs no record of its own. Until a record exists it says "not checked".
 * - **DEX Screener** (discovery, by pool id): mainnet only; Sepolia stays unavailable.
 * - **Explorer**: the token page and every contract by role, on Sepolia; a local chain (even a twin with Sepolia's
 *   chain id) and the Demo build none: links follow the SOURCE, never the chain id alone.
 * - **OpenSea**: not offered yet: its URL shapes and testnet support are unchecked (plan § 6, U), and a provider joins
 *   the allowlist only after that read-only check.
 *
 * Every href passes `vetExternalHref` (allowlisted origin, no forbidden parameter). The contract address is always
 * shown by the page, link or not.
 */
import { isAddress, type Address } from '@squarehole/domain';
import { reviewedProvider, vetExternalHref, type DestinationKind } from './allowlist';
import { SEPOLIA_DISCOVERY_REASON, UNISWAP_TESTNET_MODE_WARNING } from './chain-links';
import { NOT_TESTED_REASON } from './registry';
import { passingEvidenceV2, type RouteEvidenceV2 } from './route-evidence-v2';

export type BoxNetwork = 'demo' | 'local' | 'sepolia';
export type BoxLinkPhase = 'upcoming' | 'window' | 'bonding' | 'graduating' | 'graduated' | 'failed';
export type QClassName = 'NATIVE_ETH' | 'ERC20' | 'FIT' | 'BOX_T';

export interface BoxLinkInput {
  readonly network: BoxNetwork;
  readonly chainId: number;
  /** T, the address people copy. */
  readonly token: string;
  /** Q (the zero address for native ETH). */
  readonly q: string;
  readonly qClass: QClassName;
  readonly templateId: string;
  readonly poolId: string;
  /** null: not known (no data yet): Uniswap stays shut. */
  readonly phase: BoxLinkPhase | null;
}

export type BoxLinkState = 'available' | 'closed' | 'unknown' | 'unchecked' | 'unavailable';

export interface BoxDestination {
  readonly kind: DestinationKind;
  readonly provider: string;
  readonly state: BoxLinkState;
  readonly href: string | null;
  readonly host: string | null;
  /** Why it is not a link, in one line (or what the link is). */
  readonly reason: string;
  /** A caveat shown with the destination (Uniswap's Testnet mode on Sepolia). */
  readonly warning: string | null;
  readonly routeId: string | null;
  readonly validatedAt?: string;
}

export const BOX_DEMO_LINK_REASON = 'Demo: nothing is deployed, so no link is built.';
export const BOX_LOCAL_LINK_REASON = 'A local chain has no public explorer or market: no link is built.';
const ZERO = '0x0000000000000000000000000000000000000000';
const POOL_ID = /^0x[0-9a-fA-F]{64}$/;
const HASH32 = /^0x[0-9a-fA-F]{64}$/;

/** Why Uniswap is shut in a phase (null: it may open). */
export function executionGate(phase: BoxLinkPhase | null): { readonly state: 'closed' | 'unknown'; readonly reason: string } | null {
  switch (phase) {
    case null:
      return { state: 'unknown', reason: 'Closed until the page knows the box’s state.' };
    case 'upcoming':
      return { state: 'closed', reason: 'Closed: no route can buy before the open.' };
    case 'window':
      return { state: 'closed', reason: 'Closed during the launch window: buys go only through the launch router, at the launch tax.' };
    case 'graduating':
      return { state: 'closed', reason: 'Closed: the curve is filled and every swap waits for graduation.' };
    case 'failed':
      return { state: 'closed', reason: 'Closed: the box failed and does not trade.' };
    case 'bonding':
    case 'graduated':
      return null;
  }
}

function href(providerId: string, kind: DestinationKind, path: string): { href: string; host: string } | null {
  const provider = reviewedProvider(providerId);
  if (!provider || provider.kind !== kind) return null;
  const vetted = vetExternalHref(`${provider.origin}${path}`, kind);
  return vetted.ok && vetted.provider.id === providerId ? { href: vetted.href, host: vetted.host } : null;
}

const off = (kind: DestinationKind, provider: string, state: BoxLinkState, reason: string, routeId: string | null = null, warning: string | null = null): BoxDestination =>
  Object.freeze({ kind, provider, state, href: null, host: null, reason, warning, routeId });

/** The box's three destinations, in order: execution (Uniswap), discovery (DEX Screener), explorer. Total. */
export function boxDestinations(input: BoxLinkInput, evidence: readonly RouteEvidenceV2[] = []): readonly BoxDestination[] {
  if (input.network === 'demo') return Object.freeze([off('execution', 'Uniswap', 'unchecked', BOX_DEMO_LINK_REASON), off('discovery', 'DEX Screener', 'unchecked', BOX_DEMO_LINK_REASON), off('explorer', 'Etherscan', 'unavailable', BOX_DEMO_LINK_REASON)]);
  const malformed = !isAddress(input.token) || !isAddress(input.q) || !POOL_ID.test(input.poolId) || !HASH32.test(input.templateId);
  if (malformed) return Object.freeze((['execution', 'discovery', 'explorer'] as const).map((kind) => off(kind, kind === 'execution' ? 'Uniswap' : kind === 'discovery' ? 'DEX Screener' : 'Etherscan', 'unavailable', 'The box’s identity is malformed, so no link is built.')));
  if (input.network === 'local') return Object.freeze([off('execution', 'Uniswap', 'unchecked', BOX_LOCAL_LINK_REASON), off('discovery', 'DEX Screener', 'unchecked', BOX_LOCAL_LINK_REASON), off('explorer', 'Etherscan', 'unavailable', BOX_LOCAL_LINK_REASON)]);
  // Sepolia (the only public chain in this build, G08).
  const inputCurrency = input.q.toLowerCase() === ZERO ? 'ETH' : input.q;
  const routeId = 'BOX-SEP-UNI';
  const gate = executionGate(input.phase);
  let execution: BoxDestination;
  if (gate) execution = off('execution', 'Uniswap', gate.state, gate.reason, routeId, UNISWAP_TESTNET_MODE_WARNING);
  else {
    const record = passingEvidenceV2(evidence, { routeId, chainId: input.chainId, providerId: 'uniswap-web', kind: 'execution' }, { templateId: input.templateId, qClass: input.qClass });
    const built = record ? href('uniswap-web', 'execution', `/swap?chain=sepolia&inputCurrency=${inputCurrency}&outputCurrency=${input.token}`) : null;
    execution =
      record && built
        ? Object.freeze({ kind: 'execution' as const, provider: 'Uniswap', state: 'available' as const, href: built.href, host: built.host, reason: `Route checked for this template and Q class (${record.evidenceRecord}).`, warning: UNISWAP_TESTNET_MODE_WARNING, routeId, validatedAt: record.testedAt })
        : off('execution', 'Uniswap', 'unchecked', NOT_TESTED_REASON, routeId, UNISWAP_TESTNET_MODE_WARNING);
  }
  const discovery = off('discovery', 'DEX Screener', 'unavailable', SEPOLIA_DISCOVERY_REASON, 'BOX-SEP-DS');
  const explorerHref = href('etherscan-sepolia', 'explorer', `/token/${input.token}`);
  const explorer = explorerHref
    ? Object.freeze({ kind: 'explorer' as const, provider: 'Etherscan (Sepolia)', state: 'available' as const, href: explorerHref.href, host: explorerHref.host, reason: 'Explorer page of the exact token address.', warning: null, routeId: 'BOX-SEP-ES-TOKEN' })
    : off('explorer', 'Etherscan (Sepolia)', 'unavailable', 'The explorer link failed the provider allowlist.', 'BOX-SEP-ES-TOKEN');
  return Object.freeze([execution, discovery, explorer]);
}

/**
 * An explorer page of one contract of a box (the contracts list), on the test network only (the source named
 * `sepolia`; its explorer is Etherscan's Sepolia site, or BscScan's testnet where the build's test network is BNB Chain
 * testnet, SH-258); null for any other source.
 */
export function boxContractHref(network: BoxNetwork, address: string, explorer: 'etherscan-sepolia' | 'bscscan-testnet' = 'etherscan-sepolia'): string | null {
  if (network !== 'sepolia' || !isAddress(address)) return null;
  return href(explorer, 'explorer', `/address/${address as Address}`)?.href ?? null;
}
