/**
 * Every color in the Frog Kiln art. No other file defines a color, and check.mjs refuses any color in an SVG that is
 * not listed here. `C` holds the brand colors the brand book lists. `MIX` holds the fixed shades used inside the art:
 * light and shade of each ink, the glazes of the twelve toads, and the tints behind them.
 */
export const C = Object.freeze({
  /** Outlines and text on light grounds. */
  soot: '#2B1D17',
  /** The studio's limewashed wall, carved letters and text on dark grounds. */
  bisque: '#F4E9D8',
  /** The dark glazed slab of the name plaque. */
  slab: '#3D2B24',
  /** Terracotta: raw clay, the KILN tiles, the feet of the toads. */
  clay: '#C66A3D',
  /** The kiln's bricks. */
  brick: '#8C3B27',
  /** Fire glow and warm highlights. */
  ember: '#F2A43C',
  /** Flames. */
  flame: '#DE5A2B',
  /** The frog coin: a plain green coin with no symbol. */
  frog: '#6AA247',
  /** A pale jade glaze and soft accents. */
  celadon: '#A7C7A1',
  /** The box's own pool. */
  pond: '#4C8C90',
  /** Ware boards, shelves and the wooden crate. */
  wood: '#A7733F',
  /** Smoke, ash and metal. Decoration only. */
  ash: '#9C948B',
  /** The mended crack of a cracked toad. */
  gold: '#D6AC47',
});

export const MIX = Object.freeze({
  wallShade: '#EBDDC8',
  wallDeep: '#DECBB0',
  bisqueDark: '#D8C5A9',
  mortar: '#B8896E',
  brickDark: '#6D2C1D',
  brickLight: '#A54B32',
  doorDark: '#23140F',
  fireCore: '#FFE08A',
  fireDeep: '#B5321D',
  frogDark: '#46772F',
  frogLight: '#A2CF7C',
  clayDark: '#9B4E2B',
  clayLight: '#E3925F',
  woodDark: '#7A5027',
  woodLight: '#C8975D',
  pondDark: '#346A6E',
  pondLight: '#90C1C2',
  celadonDark: '#7EA279',
  celadonLight: '#D2E4CC',
  ashDark: '#6E6760',
  ashLight: '#CBC4BB',
  goldDark: '#9F7A26',
  goldLight: '#F1D383',
  slabLight: '#5A4337',
  groove: '#1A100C',
  glint: '#FFF9EE',
  tenmoku: '#2E201B',
  tenmokuLight: '#4A3329',
  rust: '#A9502A',
  shino: '#F0DFC2',
  shinoShade: '#DDC6A2',
  blush: '#E39056',
  oxblood: '#8E2024',
  oxbloodDark: '#5D1518',
  oxbloodLight: '#B8473F',
  ashGlaze: '#B3A44B',
  ashGlazeDark: '#7E7333',
  ashGlazeLight: '#D7CC7C',
  porcelain: '#EEF0EA',
  porcelainShade: '#D3D8D0',
  cobalt: '#2E5DA4',
  honey: '#CB8C2F',
  honeyDark: '#8F5F1C',
  honeyLight: '#EAB862',
  oatmeal: '#E7D7B8',
  oatmealShade: '#D2BE98',
  speckle: '#5C3F2E',
  raku: '#2F2C2A',
  rakuLight: '#4C4845',
  tintCeladon: '#DCE7D5',
  tintClay: '#F0D3BE',
  tintAsh: '#E2DCD3',
  tintCeladonDeep: '#C9D9C0',
  tintClayDeep: '#E6BFA4',
  tintAshDeep: '#D2CAC0',
  wallArch: '#E6D6BE',
});
