/**
 * F123: one permanent listing per coin; its current raise applies only to new boxes. The site offers every listed coin:
 * no flag hides one (F151 R68-HIDE removed F122's unused one; F149: no hide list).
 */
import { BOOTSTRAP_ETH } from '@squarehole/box-spec';
import { formatUnits, type Address } from '@squarehole/domain';
import { formatBoxId, parseBoxId } from '../../boxes/box-id';
import { raiseOf as ethRaise } from '../create-model';
import { ListingClass, ListingKind, type ListingV2 } from './spec-types';
export const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000' as Address;
export const RAISE_ETH = ethRaise(0);
export interface SiteListing extends ListingV2 {
  readonly symbol: string; readonly name: string; readonly powers: readonly string[];
  readonly listedAt?: bigint; readonly bootstrap?: bigint;
  readonly parent?: { readonly name: string; readonly chainId: number };
  /** v2.1: the listing records a checked burn (IListingBurnV21), so eating this coin burns it; otherwise it is locked. */
  readonly checkedBurn?: boolean;
  /** Whether the factory lets a box priced in this coin eat it (eat-check.ts, V21-MONEY-01); unknown until asked. */
  readonly eat?: EatAnswer;
  readonly demo?: true;
}
/** The factory's answer to eating a coin: a box coin without a checked burn is refused, every other coin allowed. */
export type EatAnswer = 'allowed' | 'refused';
export const ONDO_LINE = 'Ondo can pause or block all its tokens at once.';
export const STOCK_LINE = 'Stock-linked: may not be offered to US persons.';
export const FREEZE_LINE = 'The issuer can freeze addresses, including the pool.';
export const isBoxToken = (listing: Pick<SiteListing, 'kind'>): boolean => listing.kind === ListingKind.BOX_TOKEN;
export function offeredListings(listings: readonly SiteListing[]): SiteListing[] {
  // Duplicate identities are an invalid answer, never a new listing to choose automatically.
  const tokens = new Set<string>(); const ids = new Set<number>();
  for (const l of listings) { const key = l.token.toLowerCase(); if (tokens.has(key) || ids.has(l.id)) return []; tokens.add(key); ids.add(l.id); }
  return listings.filter((l) => l.raise >= 1_000_000n && l.raise < 2n ** 128n).sort((a, b) => a.id - b.id);
}
export const amountText = (raw: bigint, listing: Pick<SiteListing, 'decimals' | 'symbol'>): string => `${formatUnits(raw, listing.decimals)} ${listing.symbol}`;
export const issuerLines = (listing: SiteListing): readonly string[] => [...listing.powers, ...(listing.class === ListingClass.STOCK ? [STOCK_LINE] : [])];
export const raiseOf = (listing: SiteListing): bigint => listing.raise;
const bootstrapOfRaise = (raise: bigint): bigint => (raise * BOOTSTRAP_ETH + RAISE_ETH - 1n) / RAISE_ETH;
export const bootstrapFor = (listing: SiteListing, raise: bigint): bigint | null => raise === listing.raise ? listing.bootstrap ?? bootstrapOfRaise(raise) : null;
export const raiseText = (listing: SiteListing, raise: bigint): string => amountText(raise, listing);
export function parentPath(listing: SiteListing): string | null {
  if (!listing.parent || !Number.isSafeInteger(listing.parent.chainId)) return null;
  const id = parseBoxId(formatBoxId(listing.parent.chainId, listing.token));
  return id ? `/box/${id.chainId}/${id.token}` : null;
}
const demoToken = (n: number): Address => `0xde00c${'0'.repeat(31)}${n.toString(16).padStart(4, '0')}` as Address;
interface DemoRow { readonly symbol: string; readonly name: string; readonly address: Address; readonly decimals: number; readonly class: number; readonly raise: bigint; readonly powers?: readonly string[] }
// The sample book has no box coin without a checked burn, so every Demo listing may be eaten (eat-check.ts asks a chain's factory).
const listed = (row: DemoRow, id: number): SiteListing => ({ id, token: row.address, decimals: row.decimals, class: row.class, kind: ListingKind.LISTED, raise: row.raise, bootstrap: bootstrapOfRaise(row.raise), symbol: row.symbol, name: row.name, powers: row.powers ?? [], eat: 'allowed', demo: true });
/** The Demo's listing book, built in one pure expression, so a production bundle that reads none of it drops it whole. */
export const DEMO_LISTINGS: readonly SiteListing[] = /* @__PURE__ */ (() => {
  const LISTED: readonly DemoRow[] = [
    { symbol: 'ETH', name: 'Ether', address: NATIVE_TOKEN, decimals: 18, class: ListingClass.NATIVE, raise: RAISE_ETH },
    { symbol: 'LINK', name: 'Chainlink', address: demoToken(1), decimals: 18, class: ListingClass.OTHER, raise: 1_064_371_200_000_000_000_000n },
    { symbol: 'USDC', name: 'USD Coin', address: demoToken(2), decimals: 6, class: ListingClass.STABLE, raise: 15_986_524_323n, powers: [FREEZE_LINE] },
    { symbol: 'WBTC', name: 'Wrapped Bitcoin', address: demoToken(3), decimals: 8, class: ListingClass.OTHER, raise: 14_102_311n },
    { symbol: 'NVDAon', name: 'NVIDIA (Ondo)', address: demoToken(4), decimals: 18, class: ListingClass.STOCK, raise: 88_104_511_000_000_000_000n, powers: [ONDO_LINE] },
    { symbol: 'PAXG', name: 'Paxos Gold', address: demoToken(6), decimals: 18, class: ListingClass.OTHER, raise: 4_152_900_000_000_000_000n, powers: [FREEZE_LINE] },
  ];
  return Object.freeze([
    ...LISTED.map(listed),
    // Box tokens burn (BoxTokenV2.burn), so their listings record a checked burn; the listed coins above do not.
    { id: 7, token: '0x000000000000000000000000000000000000f17e' as Address, decimals: 18, class: ListingClass.STANDARD, kind: ListingKind.BOX_TOKEN, raise: 21_034_900_425_000_000_000_000_000n, symbol: 'FIT', name: 'FIT', powers: [], parent: { name: 'The Misfits', chainId: 31337 }, checkedBurn: true, eat: 'allowed', demo: true },
    { id: 8, token: '0xde00700000000000000000000000000000000003' as Address, decimals: 18, class: ListingClass.STANDARD, kind: ListingKind.BOX_TOKEN, raise: 9_783_674_616_279_069_767_441_859n, symbol: 'CHOO', name: 'Toy Trains', powers: [], parent: { name: 'Toy Trains', chainId: 31337 }, checkedBurn: true, eat: 'allowed', demo: true },
  ]);
})();
export const isDemoListing = (listing: SiteListing): boolean => listing.demo === true;
export function listingFor(token: string, listings: readonly SiteListing[]): SiteListing {
  const offered = offeredListings(listings);
  const chosen = offered.find((l) => l.token.toLowerCase() === token.toLowerCase()) ?? offered[0];
  if (!chosen) throw new Error('No price coins available.');
  return chosen;
}
