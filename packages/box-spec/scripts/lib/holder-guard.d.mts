/** Types for holder-guard.mjs (F74 U1's structural guard: holder payouts are never offered on mainnet). */
export interface GuardMember {
  readonly name: string;
  readonly kind?: string;
  readonly offeredOn?: readonly string[];
}
export interface GuardEnum {
  readonly name: string;
  readonly members: readonly GuardMember[];
}
export interface GuardSpec {
  readonly enums: readonly GuardEnum[];
  readonly fields: readonly { readonly name: string; readonly enum?: string; readonly check?: { readonly offered?: readonly string[] } }[];
}
export interface GuardCatalog {
  readonly enums?: readonly GuardEnum[];
  readonly addOns: readonly { readonly key: string; readonly params: readonly { readonly name: string; readonly enum?: string; readonly offered?: readonly string[] }[] }[];
}
/** A holder payout: fee kind HOLDERS, or HOLDERS in its name (the creator-fee cap's CapExcess.HOLDERS has no fee kind). */
export function isHolderMember(member: GuardMember): boolean;
/** Every way the source would offer a holder payout on `strictest` (mainnet): one line each, none when it never does. */
export function holderOfferProblems(spec: GuardSpec, catalog: GuardCatalog, strictest?: string): string[];
/** Format 2: an M1 release that offers the Holders destination before M2 builds it, one line each. */
export function holderOfferProblemsV2(release: { name: string; offered: { dests: readonly string[] } }): string[];
/** "Holder payouts come with M2." while the release does not offer them, else null. */
export function holderNoteV2(release: { offered: { dests: readonly string[] } }): string | null;
