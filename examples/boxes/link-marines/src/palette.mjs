/**
 * Link Marines palette: a field mess hall with a tiled wall, drawn like a screen-printed poster in olive and ration
 * paper. The ten named colors are the brand palette (brand-book.md). MIX holds the fixed shades used only inside the
 * art. No other file defines a color; check.mjs makes sure of that. There is no blue anywhere in the kit.
 */
export const C = Object.freeze({
  olive: '#56622F', // field olive: uniforms, helmets, the main wall, links on paper
  ink: '#1D2013', // boot black: every outline, text on light grounds
  paper: '#F2E8CF', // ration paper: faces, light grounds, text on olive
  gold: '#F2BE3C', // coin gold: the price coin in the story
  orange: '#E2622B', // signal orange: the box token's dog tags, print shadows, sales
  khaki: '#C8B07A', // khaki: caps, fur, sand, the second wall
  steel: '#A3A99C', // mess steel: trays, the mess tin, the locker, the bell. Decoration only
  crate: '#B9874F', // crate wood: the box, the mess table, the benches
  sage: '#8DAA8B', // water sage: the box's own pool
  night: '#2B3219', // night olive: the quiet night, deep grounds
});

/** Fixed shades, so every picture uses the same ones. */
export const MIX = Object.freeze({
  oliveGrout: '#4A5528', // grout between the olive wall tiles
  oliveDeep: '#48532A', // shade on uniforms and helmets
  oliveLight: '#7A8A47', // light on helmets, leaves
  oliveDot: '#3F4823', // halftone dots on olive
  paperShade: '#E2D3B1', // shade on faces and paper, grout between paper tiles
  paperDot: '#CDBB93', // halftone dots on faces and paper
  blush: '#EE9F78', // cheeks and noses
  mouth: '#5A2116', // the inside of a mouth
  tongue: '#C9563D',
  goldDark: '#C48D1E',
  goldLight: '#FFE6A6',
  orangeDark: '#AD4519',
  orangeLight: '#F59E6B',
  orangeGrout: '#C9541F', // grout between the orange wall tiles
  khakiDark: '#9C8452',
  khakiLight: '#E3D4A6',
  khakiGrout: '#B39A65', // grout between the khaki wall tiles
  steelDark: '#737B70',
  steelLight: '#D5D9CD',
  crateDark: '#8A6033',
  crateLight: '#D4A874',
  hair: '#6B4424', // brown hair and braids
  sageDark: '#68856B',
  sageLight: '#BBD0B6',
  nightGrout: '#232914', // grout between the night wall tiles
  nightDeep: '#1F2512',
  white: '#FFFFFF', // the kept part of a stencil mask, and glints
  cut: '#000000', // the bridges cut out of a stencil mask; never painted
});
