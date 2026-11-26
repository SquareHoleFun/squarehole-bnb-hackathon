/**
 * Link Marines, version 2 palette: mess night, a formal dinner in a panelled mess hall, drawn like a screen-printed
 * poster. The twelve named colors are the brand palette (brand-book.md). MIX holds the fixed shades used only inside
 * the art. No other file defines a color; check.mjs makes sure of that.
 *
 * Blue is for cloth only. Dress navy and flannel slate dress the marines and the cook's shirt. They are never a wall,
 * a ground or a letter, and no shade of them is darker than dress navy. check.mjs runs the colour fence on every color
 * here: no vivid blue, and nothing close to the price coin project's blues or to another LINK-paired token's colors.
 */
export const C = Object.freeze({
  navy: '#1F2B47', // dress navy: mess jackets, cap bands, sleeves. Cloth only
  slate: '#5B6478', // flannel slate: light and halftone dots on navy cloth, the plaid's second stripe. Cloth only
  white: '#FBF8F0', // cap white: caps, shirt fronts, plates, the tablecloth, words on walnut
  paper: '#F2E8CF', // ration paper: faces, place cards, the scenes' wall
  ink: '#1D2013', // boot black: every outline, text on light grounds
  gold: '#F2BE3C', // coin gold: the price coin, cap badges, candle flames
  orange: '#E2622B', // signal orange: the box token's dog tags, print shadows, crosses
  khaki: '#C8B07A', // khaki: the mark's patch, a wall, the panels of the place cards
  steel: '#A3A99C', // mess steel: cloches, cutlery, buttons, the tureen. Decoration only
  crate: '#B9874F', // crate wood: the crate, table legs, the floor, a wall
  sage: '#8DAA8B', // water sage: the box's own pool
  walnut: '#6B4A2E', // walnut: the panelled wall of the mess hall behind the brand pieces
});

/** Fixed shades, so every picture uses the same ones. */
export const MIX = Object.freeze({
  whiteShade: '#E7E0CF', // shade on caps, plates and the tablecloth
  whiteDot: '#D3CAB4', // halftone dots on white
  paperShade: '#E2D3B1', // shade on faces and paper, the scenes' panel grooves
  paperDot: '#CDBB93', // halftone dots on faces and paper
  blush: '#EE9F78', // cheeks and noses
  mouth: '#5A2116', // the inside of a mouth
  tongue: '#C9563D',
  goldDark: '#C48D1E',
  goldLight: '#FFE6A6',
  orangeDark: '#AD4519',
  orangeLight: '#F59E6B',
  khakiDark: '#9C8452',
  khakiLight: '#E3D4A6',
  steelDark: '#737B70',
  steelLight: '#D5D9CD',
  crateDark: '#8A6033',
  crateLight: '#D4A874',
  walnutDark: '#523823', // grooves between the walnut panels
  walnutLight: '#8A6440', // the light edge of the walnut mouldings
  sageDark: '#68856B',
  sageLight: '#BBD0B6',
  hair: '#6B4424', // brown hair and braids
  hairDark: '#3B2A1E', // dark hair
  hairGrey: '#CFC8B8', // the grey of the oldest marines' brows and mustaches
  glint: '#FFFFFF', // glints, and the kept part of a stencil mask
  cut: '#000000', // the bridges cut out of a stencil mask; never painted
});

/** The cloth colors: the only blues in the kit. Walls, grounds and letters never use them. */
export const CLOTH = Object.freeze([C.navy, C.slate]);
