/** CQ11 seeded creation inputs. Declared verdicts never call either validator. Real-part life runs remain phase 2. */
import type { Hex, Address } from 'viem';
import { encodeBoxSpecV2, encodeReleaseContextV2, type BoxSpecV2, type ListingV2, type ReleaseContextV2 } from '../generated/box-spec.v2';
import { ZERO, choices, side, type Choice } from './menu';
export const SEED = 0x4d313631;
const blank: Hex = `0x${'00'.repeat(32)}`;
const recipient: Address = '0x0000000000000000000000000000000000000123';
const coin = (id: number, decimals: number, cls: number, kind: number, raise: bigint): ListingV2 => ({
  id, decimals, class: cls, kind, raise, token: id === 0 ? ZERO : `0x${id.toString(16).padStart(40, '0')}`,
});
const listings = [coin(0, 18, 1, 1, 4_206_980_085_000_000_000n), coin(1, 6, 3, 1, 10_000_000_000n),
  coin(2, 18, 5, 1, 500_000_000_000_000_000_000n), coin(3, 8, 5, 1, 15_100_000n),
  coin(4, 18, 4, 1, 50_000_000_000_000_000_000n), coin(5, 18, 2, 2, 1_000_000_000_000_000_000_000_000n)];
function spec(l: ListingV2, buyers: Choice, sellers: Choice, creatorBuy = 0n): BoxSpecV2 {
  return {
    format: 2, version: 2, boxType: 3, tokenName: 'Test Token', tokenSymbol: 'TEST', collectionName: '', collectionSymbol: '',
    description: '', n: 0, firstId: 0n, pricing: { listingId: l.id, token: l.token }, raise: l.raise,
    layout: 1, gradLayout: 3, launchFormat: 1, openAt: 0, deadlineDays: 30, buyers: side(buyers), sellers: side(sellers),
    artMode: 0, revealRoot: blank, metadataTable: '0x', generatorHash: blank, coverSha256: `0x${'11'.repeat(32)}`,
    revealListId: blank, marketplaceOwner: ZERO, creatorFeeRecipient: buyers === 'keep' || sellers === 'keep' ? recipient : ZERO,
    creatorBuy, collectionCoverSha256: blank, addOns: [], contentsParams: '0x', pickFeeBps: 0,
  };
}
interface Vector { name: string; spec: BoxSpecV2; ctx: ReleaseContextV2; reason: number; field: number }
export function buildVectors(seed = SEED) {
  const valid: Vector[] = [], invalid: Vector[] = [];
  for (const l of listings) for (const b of choices) for (const s of choices) {
    valid.push({ name: `menu-${l.id}-${b}-${s}`, spec: spec(l, b, s), ctx: { listing: l }, reason: 0, field: 0 });
  }
  let state = seed >>> 0;
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  for (let i = 0; i < 256; ++i) {
    const l = listings[next() % listings.length];
    const b = choices[next() % choices.length], s = choices[next() % choices.length];
    if (!l || !b || !s) throw new Error('empty menu');
    // PRNG words choose an exact bigint fraction; no money passes through Number.
    const buy = l.raise * BigInt(next()) / (10n * (1n << 32n));
    valid.push({ name: `random-${i}`, spec: spec(l, b, s, buy), ctx: { listing: l }, reason: 0, field: 0 });
  }
  const l = listings[0];
  if (!l) throw new Error('missing native listing');
  const add = (name: string, changes: Partial<BoxSpecV2>, reason: number, field: number) =>
    invalid.push({ name, spec: { ...spec(l, 'burn', 'burn'), ...changes }, ctx: { listing: l }, reason, field });
  add('stale-raise', { raise: l.raise + 1n }, 10, 11);
  add('retired-layout', { gradLayout: 2 }, 3, 13);
  for (const key of ['buyers', 'sellers'] as const) {
    const base = key === 'buyers' ? 17000 : 18000;
    for (const leg of [3, 4, 5]) add(`${key}-retired-leg-${leg}`, { [key]: { ...side('burn'), a: { ...side('burn').a, leg } } }, 3, base + 1);
    for (const dest of [3, 5]) add(`${key}-unoffered-dest-${dest}`, { [key]: { ...side('burn'), a: { ...side('burn').a, dest } } }, 3, base + 2);
    add(`${key}-shop-missing-preset`, { [key]: { ...side('burn'), a: { ...side('burn').a, dest: 7 } } }, 23, base + 4);
    // Holders (M2) and Items (M3) are offered destinations. Empty canonical params fail before pair/type rules.
    for (const dest of [6, 8]) add(`${key}-missing-dest-params-${dest}`, { [key]: { ...side('burn'), a: { ...side('burn').a, dest } } }, 23, base + 4);
    add(`${key}-nonempty-b`, { [key]: { ...side('burn'), b: side('grow').a } }, 8, base + 11);
    add(`${key}-wrong-pair`, { [key]: { ...side('burn'), a: { ...side('burn').a, dest: 4 } } }, 11, base + 1);
  }
  return { seed, listings, valid, invalid };
}
export function vectorsJson(v: ReturnType<typeof buildVectors>): string {
  const wire = (x: Vector) => ({ name: x.name, spec: encodeBoxSpecV2(x.spec), ctx: encodeReleaseContextV2(x.ctx), reason: x.reason, field: x.field });
  return `${JSON.stringify({ name: 'whole-menu-v2-cq11', seed: v.seed,
    about: 'Creation validation vectors. Phase 2 adds real-part lifecycle amounts; no retired route, sampler or cap fixture.',
    listings: v.listings, validCount: v.valid.length, valid: v.valid.map(wire), invalidCount: v.invalid.length, invalid: v.invalid.map(wire),
  }, (_, x: unknown) => typeof x === 'bigint' ? x.toString() : x, 2)}\n`;
}
