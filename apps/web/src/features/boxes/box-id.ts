/**
 * Box ids: `<chainId>-<token address, lowercase>`, for example `11155111-0x07cb5710d589c9763192e76694fcd3e8f5a0b353`,
 * and box paths as BOX-INTERFACE § 9 has them, `/box/<chainId>/<token address, lowercase>`. The token address is the
 * one identity every market record carries (the pool id derives from it). The route params are untrusted (a shared
 * link): they are checked against fixed patterns and a Map of known chains, never repaired or guessed, and `__proto__`
 * and friends never reach an object. A link in another spelling (upper-case hex, the earlier `/box/<chainId>-<token>`)
 * is redirected to the canonical path.
 */
import { TESTNET } from '@squarehole/chain/write/wallet';
import type { Address } from '@squarehole/domain';

export interface BoxId {
  readonly chainId: number;
  /** Lowercase. */
  readonly token: Address;
}

/** The chains a box can live on in this build: the local / demo chain and Sepolia (no mainnet target, G08). */
const KNOWN_CHAINS: ReadonlyMap<string, number> = new Map([
  ['31337', 31_337],
  // SH-258: the build's test network (11155111, or 97 under SH_TESTNET=bnb).
  [String(TESTNET.chainId), TESTNET.chainId],
]);

const BOX_ID = /^([0-9]{1,9})-(0x[0-9a-fA-F]{40})$/;

/** The canonical id: chain id, a dash and the lowercase token address. */
export function formatBoxId(chainId: number, token: string): string {
  return `${chainId}-${token.toLowerCase()}`;
}

/** The route param as a box id, or null when it is malformed or names a chain this build does not know. */
export function parseBoxId(raw: string | undefined): BoxId | null {
  if (raw === undefined || raw.length > 64) return null;
  const match = BOX_ID.exec(raw);
  if (!match) return null;
  const chainId = KNOWN_CHAINS.get(match[1] ?? '');
  const token = match[2];
  if (chainId === undefined || token === undefined) return null;
  return Object.freeze({ chainId, token: token.toLowerCase() as Address });
}

/** The route params of a box page (`/box/:chain/:address`) as a box id, or null. */
export function parseBoxRoute(chain: string | undefined, address: string | undefined): BoxId | null {
  if (chain === undefined || address === undefined) return null;
  return parseBoxId(`${chain}-${address}`);
}

/** The canonical path of a box page: `/box/<chainId>/<token, lowercase>`. */
export function boxPath(id: string): string {
  const parsed = parseBoxId(id);
  if (parsed === null) throw new Error(`Not a box id: ${id}`);
  return `/box/${parsed.chainId}/${parsed.token}`;
}

/** The path of a wallet box (view only). */
export const walletPath = (address: string): string => `/wallet/${address.toLowerCase()}`;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** A full 0x address from untrusted text, lowercase, or null. */
export function parseAddress(raw: string | undefined): Address | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return ADDRESS.test(trimmed) ? (trimmed.toLowerCase() as Address) : null;
}
