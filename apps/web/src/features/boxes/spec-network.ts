/**
 * Which network's rules a page applies to a BoxSpec (F74 U1; packages/box-spec `Network`, `OFFERED_ON`, `PENDING`,
 * `NOT_BUILT`). The Demo offers holder payouts early, marked "pending legal review"; the local chain runs the same
 * contracts as Sepolia, so both take Sepolia's rules, which leave out what core v1 does not build (a conversion or a
 * sell needs the swap module); any other chain takes mainnet's (what validate() and Solidity accept). Holder payouts
 * are never offered for mainnet (the generator refuses it).
 */
import { CapExcess, ENUM_MEMBERS, NETWORKS, NOT_BUILT, OFFERED_ON, PENDING, STRICTEST_NETWORK, type Network } from '@squarehole/box-spec';
import { LOCAL_CHAIN_ID, SEPOLIA_CHAIN_ID } from '../data-source/data-source';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

/** The chains that run Sepolia's rules: Sepolia itself and the local anvil chain. */
const SEPOLIA_RULES: ReadonlySet<number> = new Set([SEPOLIA_CHAIN_ID, LOCAL_CHAIN_ID]);

/** CapExcess has no fee-kind metadata (it is not a fee side): its member names by value. */
const CAP_EXCESS_NAMES: Readonly<Record<number, string>> = Object.freeze(Object.fromEntries(Object.entries(CapExcess).map(([name, value]) => [value, name])));

/** Why a value some network offers is off on this one: a holder payout (offered by the sample data only) or a value core v1 does not build here. */
export const DEMO_ONLY_HINT = 'Not offered here yet';
export const NOT_ON_TESTNET = 'Not on testnet yet';

/** A value's name in its enum (CapExcess has no fee-kind metadata, so its names come from the enum itself). */
const memberName = (enumName: string, value: number): string | undefined => ENUM_MEMBERS[enumName]?.find((entry) => entry.value === value)?.name ?? (enumName === 'CapExcess' ? CAP_EXCESS_NAMES[value] : undefined);

/** "pending legal review" → "Pending legal review". */
const sentence = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** The network a data source checks a spec against: the Demo, Sepolia's rules (Sepolia, local), else the strictest. */
export function specNetwork(source: { readonly isDemo: boolean; readonly chainId: number }): Network {
  if (DEMO_BUILD && source.isDemo) return 'demo';
  return SEPOLIA_RULES.has(source.chainId) ? 'sepolia' : STRICTEST_NETWORK;
}

/** Whether a menu key (`qStream`, `addOns.creator-fee-cap.excess`, …) offers this value on `network`. */
export const offeredOn = (key: string, value: number, network: Network): boolean => (OFFERED_ON[network][key] ?? []).includes(value);

/** Whether some network offers it: a stored draft keeps such a value, and the page's gate then names it where it is not offered. */
export const offeredSomewhere = (key: string, value: number): boolean => NETWORKS.some((network) => offeredOn(key, value, network));

/** The note shown beside a value offered early ("Pending legal review"), by enum name and value; null when none. */
export function pendingNote(enumName: string, value: number): string | null {
  const name = memberName(enumName, value);
  const note = name === undefined ? undefined : PENDING[enumName]?.[name];
  return note === undefined ? null : sentence(note);
}

/**
 * A value's words on `network`: offered there, its pending note ("Pending legal review" in the Demo) or none; offered
 * only elsewhere, why it is off here: "Not on testnet yet" (core v1 does not build it on Sepolia) or "Demo only" (a
 * holder payout). Null for a value no network offers.
 */
export function noteOn(key: string, enumName: string, value: number, network: Network): string | null {
  if (offeredOn(key, value, network)) return pendingNote(enumName, value);
  if (!offeredSomewhere(key, value)) return null;
  const name = memberName(enumName, value);
  return name !== undefined && NOT_BUILT[enumName]?.[name] !== undefined ? NOT_ON_TESTNET : DEMO_ONLY_HINT;
}

/** The note every holder payout carries while it is offered early ("Pending legal review"); null once it is not. */
export const HOLDERS_PENDING: string | null = pendingNote('CapExcess', CapExcess.HOLDERS);
