/**
 * Demo-only avatar assignment for the handoff fixture pairs (fixtures/feed.json).
 *
 * Artwork is presentation for mock data, not identity: several pairs deliberately share a toy shape, and pair identity
 * stays the exact chain + address (AGENTS.md: "Tickers, images and names are not authority"). Real launches will carry
 * their own uploaded artwork. NO PRICE YET is intentionally unmapped so the unavailable-artwork state is exercised.
 */
import type { PairId } from '@squarehole/domain';
import { ART, type ArtAsset } from './registry';

const pair = (hexSuffix: string): PairId => `31337:0x${hexSuffix.padStart(40, '0')}`;

export const DEMO_AVATARS: ReadonlyMap<PairId, string> = new Map<PairId, string>([
  [pair('65'), 'platform-tile'], // Square Hole (platform pin): the glowing square-hole tile
  [pair('66'), 'orchard-tree'], // ORCHARD: ordinary orchard tree
  [pair('67'), 'shape-sphere'], // ROUND TRIP: the round toy
  // MISFIT STUDIO: a tree in sunglasses, a misfit but not the cast. The Sorter hosts the platform and its root
  // collection (The Misfits, F09), so an ordinary demo pair must not look like it is that collection.
  [pair('68'), 'orchard-tree-sunglasses'],
  [pair('69'), 'shape-sphere'], // APPLEHOLE: red round toy, deliberately not an apple (no Apple-logo look-alike)
  [pair('6a'), 'collector-frame'], // TINY FRAMES: The Collector's golden frame
  [pair('6b'), 'shape-cube'], // SOFT CORNERS: the rounded cube
  [pair('6c'), 'shape-pyramid'], // WRONG ANGLE: the pyramid
  [pair('6d'), 'shape-gem'], // COIN CONFETTI: faceted gem (The Coin has no clean source art yet)
  [pair('6e'), 'orchard-tree-blossom'], // LITTLE ORCHARD: blossom tree
  [pair('6f'), 'shape-cube'], // NEW SHAPE: the cube that fits the hole
  // pair('70') NO PRICE YET: no artwork → unavailable-artwork state
]);

/** Art for a demo pair id (address compared case-insensitively), or null when none is assigned. */
export function demoAvatarFor(pairId: string): ArtAsset | null {
  const artId = DEMO_AVATARS.get(pairId.toLowerCase() as PairId);
  return (artId && ART.get(artId)) || null;
}
