/**
 * SH-258 round 3: the BNB Chain testnet build's edition content (build/bnb-variants.ts takes this file in place of
 * misfits-content.ts). The tables are used only for box 0's own market (names.kind 'launch'), which that network has none of; the site's tagline stays. Same exports, nothing of box 0.
 */

export interface FamilyRow {
  readonly id: string;
  readonly count: bigint;
  readonly approx: boolean;
  readonly avatar: TeaserSlug | null;
  readonly sealed: boolean;
}
export interface FinishRow {
  readonly id: 'Diamond' | 'Glass' | 'Gold';
  readonly count: bigint;
}
export interface Composition {
  readonly size: bigint;
  readonly families: readonly FamilyRow[];
  readonly finishes: readonly FinishRow[];
  readonly assumed: boolean;
}
export type TeaserSlug = 'B02' | 'B04' | 'B06' | 'B09' | 'B13' | 'B15' | 'B17' | 'B18' | 'B19';
export interface Teaser {
  readonly slug: TeaserSlug;
  readonly title: string;
  readonly family: string;
  readonly role: string;
  readonly finish: 'Standard';
}

export const TEASERS: readonly Teaser[] = Object.freeze([]);
export const RARE_ART: ReadonlySet<string> = new Set();
export const ORDINARY_POOL: ReadonlyMap<string, readonly TeaserSlug[]> = new Map();
export function compositionAddsUp(composition: Composition): boolean {
  return composition.families.reduce((sum, row) => sum + row.count, 0n) === composition.size;
}
export function compositionFor(): Composition | null {
  return null;
}
export function familyCount(composition: Composition | null, familyId: string): FamilyRow | null {
  return composition?.families.find((row) => row.id === familyId) ?? null;
}
export const MISFITS_TAGLINE = 'Different shapes. Same hole.';
export const misfitsLine = (size: string): string => `${size} items.`;
export const MISFIT_ROLES: readonly string[] = Object.freeze([]);
export const MISFIT_ROOMS: readonly string[] = Object.freeze([]);
export const MISFIT_SLOTS: readonly string[] = Object.freeze([]);
