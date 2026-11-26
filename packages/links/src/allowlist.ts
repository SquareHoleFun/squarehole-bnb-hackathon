/**
 * Provider origin allowlist (EXT-02, EXT-07). Every external href the app renders must pass `vetExternalHref`:
 * an absolute `https:` URL whose exact origin belongs to a reviewed provider of that destination kind, without
 * credentials, ports, embedded redirect targets or the parameters the route research forbids. A pass means only
 * "this URL points where a reviewed provider lives"; it is never evidence that a route works (EXT-05).
 *
 * Origins: docs/research/sh-018-external-routes.md "Proposed origin allowlist" (Ethereum mainnet) and
 * docs/research/sepolia-infrastructure.md §4.1 (Sepolia). Excluded providers there are not listed here.
 */
import type { ExternalDestination } from '@squarehole/domain';

export type DestinationKind = ExternalDestination['kind'];

export interface ReviewedProvider {
  readonly id: string;
  /** Display name. Never a link target. */
  readonly name: string;
  readonly kind: DestinationKind;
  /** Exact origin (scheme + lowercase host, no port or path). */
  readonly origin: string;
}

export const REVIEWED_PROVIDERS: readonly ReviewedProvider[] = Object.freeze(
  [
    { id: 'uniswap-web', name: 'Uniswap web app', kind: 'execution', origin: 'https://app.uniswap.org' },
    { id: 'dexscreener', name: 'DEX Screener', kind: 'discovery', origin: 'https://dexscreener.com' },
    { id: 'etherscan', name: 'Etherscan', kind: 'explorer', origin: 'https://etherscan.io' },
    { id: 'etherscan-sepolia', name: 'Etherscan (Sepolia)', kind: 'explorer', origin: 'https://sepolia.etherscan.io' },
    { id: 'blockscout-sepolia', name: 'Blockscout (Sepolia)', kind: 'explorer', origin: 'https://eth-sepolia.blockscout.com' },
    // SH-258: BNB Chain testnet's explorer (chain 97), for builds whose test network it is.
    { id: 'bscscan-testnet', name: 'BscScan (Testnet)', kind: 'explorer', origin: 'https://testnet.bscscan.com' },
  ].map((provider) => Object.freeze(provider as ReviewedProvider)),
);

export function reviewedProvider(id: string): ReviewedProvider | null {
  return REVIEWED_PROVIDERS.find((provider) => provider.id === id) ?? null;
}

/**
 * Query parameters a link may never carry (SH-018 "Forbidden parameters"): wallet connection, prefilled amounts,
 * cross-chain output, recipients and slippage. Compared case-insensitively.
 */
export const FORBIDDEN_PARAMS: ReadonlySet<string> = new Set([
  'connect',
  'value',
  'field',
  'outputchain',
  'recipient',
  'sellamount',
  'buyamount',
  'exactamount',
  'exactfield',
  'slippage',
  'slippagetolerance',
  'maxslippage',
]);

export type HrefRejection =
  | 'not_a_string'
  | 'too_long'
  | 'unsafe_characters'
  | 'not_absolute'
  | 'not_https'
  | 'credentials'
  | 'port'
  | 'origin_not_allowed'
  | 'forbidden_parameter'
  | 'embedded_url'
  | 'legacy_hash_route';

export type VettedHref =
  | { readonly ok: true; readonly href: string; readonly host: string; readonly provider: ReviewedProvider }
  | { readonly ok: false; readonly reason: HrefRejection };

const MAX_HREF_LENGTH = 2048;
// Whitespace, C0/C1 controls, zero-width and bidi controls, the BOM and backslashes never belong in a reviewed link.
function hasUnsafeCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (
      code <= 0x20 ||
      (code >= 0x7f && code <= 0xa0) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff ||
      char === '\\' ||
      /\s/u.test(char)
    ) {
      return true;
    }
  }
  return false;
}

// A parameter value that is itself a URL is a redirect vector, whatever the parameter is called (EXT-07).
const EMBEDDED_URL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

const reject = (reason: HrefRejection): VettedHref => ({ ok: false, reason });

/**
 * Checks an href against the allowlist for one destination kind. Total: never throws on hostile input.
 * The returned `href` is the parsed, normalised form; render that, not the input.
 */
export function vetExternalHref(href: unknown, kind: DestinationKind): VettedHref {
  if (typeof href !== 'string') return reject('not_a_string');
  if (href.length > MAX_HREF_LENGTH) return reject('too_long');
  if (hasUnsafeCharacter(href)) return reject('unsafe_characters');
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return reject('not_absolute');
  }
  if (url.protocol !== 'https:') return reject('not_https');
  if (url.username !== '' || url.password !== '') return reject('credentials');
  if (url.port !== '') return reject('port');
  const provider = REVIEWED_PROVIDERS.find((candidate) => candidate.kind === kind && candidate.origin === url.origin);
  if (!provider) return reject('origin_not_allowed');
  for (const [name, value] of url.searchParams) {
    if (FORBIDDEN_PARAMS.has(name.toLowerCase())) return reject('forbidden_parameter');
    if (EMBEDDED_URL.test(value.trim())) return reject('embedded_url');
  }
  if (url.hash.startsWith('#/')) return reject('legacy_hash_route');
  return { ok: true, href: url.href, host: url.host, provider };
}
