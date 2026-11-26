/**
 * The Lake House palette, sampled from the approved reference pictures (ADR-0004, founder answer F03). Every colour
 * is the average of a 5 x 5 patch of one reference PNG, at a point inside one of the approved cast crops of
 * `packages/design/art/manifest.json` and outside every crop that manifest excludes (the brand look-alikes). The
 * reference PNGs are the handoff's, pinned by their SHA-256 in that manifest. `check.mjs` samples them again.
 *
 * The house, the lake and the pines are new shapes drawn in code (src/logo.mjs). From the reference come the colours
 * and the one motif the logo keeps: the glowing square ring around a dark square hole of the platform tile.
 */
export const MANIFEST = 'packages/design/art/manifest.json';
export const REFERENCE_DIR = 'square-hole-handoff/design/reference';
/** Half the side of the averaged patch: 2 gives 5 x 5 pixels. */
export const PATCH_RADIUS = 2;

/** Each colour: its name in the logo, the approved crop it comes from, the patch centre and what it paints. */
export const SAMPLES = Object.freeze([
  { name: 'sky', crop: 'platform-tile', x: 400, y: 150, use: 'the night sky' },
  { name: 'hole', crop: 'platform-tile', x: 320, y: 215, use: 'every outline and the square hole in the window' },
  { name: 'glow', crop: 'platform-tile', x: 310, y: 205, use: 'the window ring and the star glints' },
  { name: 'glowMid', crop: 'platform-tile', x: 312, y: 230, use: 'the soft light around the ring and its reflection' },
  { name: 'glowDeep', crop: 'platform-tile', x: 318, y: 190, use: 'the outer edge of the ring' },
  { name: 'wood', crop: 'square-hole-box', x: 1300, y: 285, use: 'the walls and the moon' },
  { name: 'woodMid', crop: 'square-hole-box', x: 1250, y: 285, use: 'the planks and the door' },
  { name: 'woodDark', crop: 'square-hole-box', x: 1180, y: 300, use: 'the roof, the deck and the posts' },
  { name: 'pine', crop: 'shape-gem', x: 1580, y: 375, use: 'the near pines' },
  { name: 'pineDark', crop: 'shape-gem', x: 1585, y: 385, use: 'the far pines' },
  { name: 'lake', crop: 'shape-pyramid', x: 1520, y: 380, use: 'the lake, mixed into the sky' },
  { name: 'lakeDeep', crop: 'shape-pyramid', x: 1510, y: 390, use: 'the ripples, mixed into the lake' },
]);

/** The colours as sampled when the logo was drawn. `check.mjs` fails if a fresh sample differs from any of them. */
export const C = Object.freeze({
  sky: '#13182B', hole: '#090D32', glow: '#93CFFA', glowMid: '#6F85DB', glowDeep: '#3744A5',
  wood: '#E3C1A4', woodMid: '#D1A78F', woodDark: '#624846', pine: '#2A6C43', pineDark: '#265D39',
  lake: '#1E4ACD', lakeDeep: '#193997',
});

const rgb = hex => [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16));
const hex = parts => `#${parts.map(v => v.toString(16).toUpperCase().padStart(2, '0')).join('')}`;
/** `a` moved `percent` of the way to `b`, per channel, in integers (rounded half up), so every build is the same. */
export const mix = (a, b, percent) => hex(rgb(a).map((v, i) => Math.floor((v * (100 - percent) + rgb(b)[i] * percent + 50) / 100)));

/** The colours mixed from the samples: the lake water, its ripples and the far pines in the dark. */
export const MIX = Object.freeze({ water: mix(C.sky, C.lake, 38), ripple: mix(mix(C.sky, C.lake, 38), C.lakeDeep, 55), farPine: mix(C.pineDark, C.sky, 40) });
