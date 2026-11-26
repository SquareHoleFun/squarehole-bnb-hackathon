/**
 * A price coin's issuer powers, read from the listed token's own contract on the listing's chain (SH-V2-FE8; the
 * LOCAL-COINS-B review: "a reviewed chain/address-bound issuer metadata path … do not certify an issuer from a
 * spoofable ticker or apply Ondo identity to every STOCK row"). The address is the listing registry's (a reviewed,
 * permanent row), the chain is the listing's; the ticker and the name are never read for this.
 *
 * What is read (eth_call, view functions only; nothing is sent and no wallet is asked):
 * - a restriction controller the token names (`controls()`, the local stock coins' shared `LocalStockControls`):
 *   its `paused()` is one switch for every coin that names it, its `frozen(address)` freezes an address in all of
 *   them;
 * - the token's own `paused()`, and its address freeze or blocklist under the names the issuers use
 *   (`isBlacklisted`: Circle's USDC; `isBlackListed`: Tether's older tokens; `isBlocked`: Tether's newer ones;
 *   `isFrozen`: Paxos' PAXG; `frozen`).
 * A getter that answers with a well-formed value is the power. One that reverts is absent. Anything else (the RPC
 * down, a timeout, a rate limit or another RPC error, the listed address holding no code, an RPC on another chain)
 * concludes nothing: the coin says so in one line, and a later read tries again (not before RETRY_MS). A power behind another function name is not found: the lines name the powers this
 * check knows (counsel pack: "Each box's page names the issuer powers we know of").
 *
 * Who the issuer is stays unnamed ("The issuer …"): a name needs a reviewed entry for that exact chain and address,
 * which no deployment has yet. The sample data's book (listings.ts) keeps its own lines.
 */
import { encodeFunctionData, type Address, type Hex } from 'viem';
import { FREEZE_LINE, NATIVE_TOKEN } from './listings';
import { ListingKind } from './spec-types';

/** A coin whose pause is a separate controller's: one switch stops every coin that names it. */
export const PAUSE_ALL_LINE = 'The issuer can pause or block all its tokens at once.';
/** A coin that can pause itself. */
export const PAUSE_LINE = 'The issuer can pause all transfers of this coin.';
/** The one fallback: the chain could not be read, so nothing is said about the powers either way. */
export const UNREAD_LINE = 'Issuer powers could not be read.';

/**
 * One view call to a contract: its return data, `null` when the call reverts or returns no data (the function is
 * absent), and a rejection for anything else (the chain could not be asked): then nothing is concluded.
 */
export type TokenCall = (to: Address, data: Hex) => Promise<Hex | null>;

/** The listing's chain, read: view calls and whether an address holds code (both reject when the chain cannot be asked). */
export interface TokenReader {
  readonly call: TokenCall;
  readonly hasCode: (address: Address) => Promise<boolean>;
}

/** After a read the chain could not answer, the next one waits this long (the listing book refetches every 6 s). */
export const RETRY_MS = 30_000;

export interface IssuerPowers {
  /** `shared`: a controller's switch over all its coins; `token`: the coin's own pause; null: none found. */
  readonly pause: 'shared' | 'token' | null;
  readonly freeze: boolean;
}

const ZERO = '0x0000000000000000000000000000000000000000' as Address;
/** The account the freeze getters are asked about: any non-zero one (a getter may refuse the zero address). */
const PROBE = '0x0000000000000000000000000000000000000001' as Address;
const POWER_ABI = [
  { type: 'function', name: 'controls', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  ...(['frozen', 'isFrozen', 'isBlacklisted', 'isBlackListed', 'isBlocked'] as const).map((name) => ({
    type: 'function' as const,
    name,
    stateMutability: 'view' as const,
    inputs: [{ type: 'address' as const, name: 'account' }],
    outputs: [{ type: 'bool' as const }],
  })),
] as const;
const FREEZE_GETTERS = ['frozen', 'isFrozen', 'isBlacklisted', 'isBlackListed', 'isBlocked'] as const;

const CONTROLS = encodeFunctionData({ abi: POWER_ABI, functionName: 'controls' });
const PAUSED = encodeFunctionData({ abi: POWER_ABI, functionName: 'paused' });
const freezeCall = (name: (typeof FREEZE_GETTERS)[number]): Hex => encodeFunctionData({ abi: POWER_ABI, functionName: name, args: [PROBE] });

/** A Solidity bool, exactly one word of 0 or 1; anything else is not this getter. */
const isBool = (data: Hex | null): boolean => data !== null && /^0x0{63}[01]$/.test(data);
/** A non-zero address, exactly one word with its top 12 bytes clear. */
function addressOf(data: Hex | null): Address | null {
  if (data === null || !/^0x0{24}[0-9a-fA-F]{40}$/.test(data)) return null;
  const address = `0x${data.slice(26)}` as Address;
  return address.toLowerCase() === ZERO ? null : address;
}

/** A contract that answers nothing because it is not there (a lagging node, a reset chain) proves nothing. */
async function contractAt(reader: TokenReader, address: Address): Promise<void> {
  if (!(await reader.hasCode(address))) throw new Error(`No contract at ${address} on this chain`);
}

/** The powers of one token (rejects when the chain could not be read). */
export async function readIssuerPowers(reader: TokenReader, token: Address): Promise<IssuerPowers> {
  const { call } = reader;
  const [, controller, ownPause, ...ownFreeze] = await Promise.all([contractAt(reader, token), call(token, CONTROLS), call(token, PAUSED), ...FREEZE_GETTERS.map((name) => call(token, freezeCall(name)))]);
  const controls = addressOf(controller);
  const [, sharedPause, sharedFreeze] = controls ? await Promise.all([contractAt(reader, controls), call(controls, PAUSED), call(controls, freezeCall('frozen'))]) : [null, null, null];
  return Object.freeze({
    pause: isBool(sharedPause) ? 'shared' : isBool(ownPause) ? 'token' : null,
    freeze: isBool(sharedFreeze) || ownFreeze.some(isBool),
  });
}

/** The card's lines for the powers found (no line for none found). */
export function powerLines(powers: IssuerPowers): readonly string[] {
  return [...(powers.pause === 'shared' ? [PAUSE_ALL_LINE] : powers.pause === 'token' ? [PAUSE_LINE] : []), ...(powers.freeze ? [FREEZE_LINE] : [])];
}

/** Whether a listing has an issuer to read: native ETH and Square Hole's own box tokens have none. */
export const hasIssuer = (listing: { readonly token: Address; readonly kind: number }): boolean => listing.token.toLowerCase() !== NATIVE_TOKEN && listing.kind !== ListingKind.BOX_TOKEN;

// Powers do not change from one read of the listing book to the next (it refetches every few seconds): one read per
// chain and token, kept for the page's life. A read the chain could not answer is not kept; the next one waits RETRY_MS.
const known = new Map<string, Promise<IssuerPowers>>();
const failedAt = new Map<string, number>();

/** The listing's issuer lines: its powers, none for a coin without an issuer, or the one fallback line. */
export async function issuerPowerLines(reader: TokenReader, chainId: number, listing: { readonly token: Address; readonly kind: number }, now: () => number = Date.now): Promise<readonly string[]> {
  if (!hasIssuer(listing)) return [];
  const key = `${chainId}:${listing.token.toLowerCase()}`;
  let read = known.get(key);
  if (!read) {
    const failed = failedAt.get(key);
    if (failed !== undefined && now() - failed < RETRY_MS) return [UNREAD_LINE];
    const started = readIssuerPowers(reader, listing.token);
    read = started;
    known.set(key, started);
    started.then(
      () => failedAt.delete(key),
      () => {
        // Only this read's own entry: a newer one (after a reset) stays.
        if (known.get(key) === started) known.delete(key);
        failedAt.set(key, now());
      },
    );
  }
  try {
    return powerLines(await read);
  } catch {
    return [UNREAD_LINE];
  }
}

/** Test seam: forget every read and every failure. */
export function resetIssuerPowersForTests(): void {
  known.clear();
  failedAt.clear();
}
