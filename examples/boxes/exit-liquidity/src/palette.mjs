/**
 * Exit Liquidity palette: a hallway at night, lit only by its signs.
 * The nine named colors are the brand palette (brand-book.md). The rest are fixed mixes used only inside the art.
 */
export const C = Object.freeze({
  ink: '#0E1316', // hallway ink: every background
  slate: '#1F292E', // sign housings, crates, pipes
  rim: '#3A4A52', // housing rims, rods, chains
  green: '#22D47B', // exit green: lit faces and LED dots
  mint: '#A8F3CB', // glow mint: highlights and small labels
  red: '#FF5A47', // alarm red: errors, sellers, burns
  amber: '#FFB43F', // signal amber: USDC coins
  paper: '#F3F0E7', // paper: light grounds, the pointer
  deep: '#0B6B3C', // deep green: green text on paper
});

/** Fixed mixes, so every piece of art uses the same shades. */
export const MIX = Object.freeze({
  ceiling: '#0A0E10',
  floor: '#141C20',
  floorEdge: '#26323A',
  seam: '#131A1E',
  panel: '#070A0B', // the black behind LED dots
  brick: '#1A2226',
  brickLine: '#0E1316',
  amberDark: '#B97A16',
  amberLight: '#FFD58A',
  water: '#1C7A5A',
  waterDeep: '#0F3A30',
  flame: '#FF8A3D',
});

/** Unlit LED dot colors for each lit color (about 14% of the lit color on the panel). */
export const OFF = Object.freeze({
  green: '#0E2A1D',
  mint: '#1C2C26',
  red: '#2D1512',
  amber: '#2E2312',
});

/** The four colors a sign can glow in. */
export const GLOW = Object.freeze({ green: C.green, mint: C.mint, red: C.red, amber: C.amber });
