/**
 * Every color in the Paper Certificates art. No other file defines one, and check.mjs refuses any color in an SVG
 * that is not listed here. `C` holds the brand colors the brand book lists. `MIX` holds the fixed shades used inside
 * the art: the inks of the twelve certificates with their deep grounds and pale tints, and the light and shade of each
 * brand color.
 */
export const C = Object.freeze({
  /** Engraver's black: every outline and all text on light grounds. */
  ink: '#2A2118',
  /** Certificate paper: the ground of every picture, and text on dark grounds. */
  paper: '#F4ECD9',
  /** Aged paper: panels, shade on paper, the backs of envelopes. */
  vellum: '#E3D5B6',
  /** Gold foil: seals, the gold coin and the gold edition's frames. */
  gold: '#C9A23C',
  /** Gold-brown ink for lettering in gold on paper. */
  goldInk: '#7B5A14',
  /** Seal red: wax seals, serial numbers and the arrows in the story. */
  seal: '#A3262A',
  /** SCRIP violet: the ink of the SCRIP coupon. */
  scrip: '#5B3D8E',
  /** Lilac paper: the SCRIP coupon itself. */
  lilac: '#DED3EE',
  /** Steel: the index coin, the scale and the tin box. */
  steel: '#7E8B97',
  /** Cast iron: the safe and the stove. */
  iron: '#33373C',
  /** Fire in the stove. */
  flame: '#E0662B',
  /** The glow of the fire and warm highlights. */
  ember: '#F2B548',
  /** Bond green: the paper edition's frames. */
  bond: '#2E6A47',
  /** Blue chip ink: the special series. */
  blue: '#1F4C99',
  /** The bright blue of a blue chip. */
  chip: '#5D9BE0',
  /** Manila: the paper tags that carry words in the story. */
  tag: '#E2C990',
  /** Wood: trays, the desk and the cone stand. */
  wood: '#9B6A3C',
});

export const MIX = Object.freeze({
  paperShade: '#EADFC6',
  paperDeep: '#D7C7A3',
  goldDark: '#8E6F22',
  goldLight: '#E8CD7A',
  goldPale: '#F1E2B0',
  sealDark: '#6E1519',
  sealLight: '#D9867D',
  scripDark: '#3E2766',
  lilacDark: '#C3B3DD',
  steelDark: '#56626D',
  steelLight: '#B7C1CA',
  ironLight: '#4D535A',
  ironDark: '#1F2226',
  flameDark: '#B2401C',
  fireCore: '#FFE7A6',
  smoke: '#A39D94',
  smokeLight: '#C9C3BA',
  bondDark: '#1C4730',
  bondLight: '#BFD8C6',
  bondTint: '#DCE8DD',
  chipDark: '#2F6DB5',
  chipLight: '#A9CBF0',
  tagDark: '#B99B5C',
  woodDark: '#6B4524',
  woodLight: '#C08F5B',
  // The inks of the twelve certificates, each with a deep ground for the mat around the sheet and a pale tint.
  sepia: '#6A3D1E',
  sepiaDeep: '#3B2110',
  sepiaTint: '#E6D2BC',
  teal: '#1E5E62',
  tealDeep: '#0F3437',
  tealTint: '#CFE0DC',
  vermilion: '#B0441C',
  vermilionDeep: '#5E220C',
  vermilionTint: '#F0D3C2',
  olive: '#55591A',
  oliveDeep: '#2E300C',
  oliveTint: '#DEDDBE',
  slate: '#3B4553',
  slateDeep: '#1E242C',
  slateTint: '#D6D9DC',
  crimson: '#962032',
  crimsonDeep: '#4F0F1A',
  crimsonTint: '#EDCFCF',
  ochre: '#7E5E0E',
  ochreDeep: '#453306',
  ochreTint: '#EADFB9',
  plum: '#6A2A5A',
  plumDeep: '#38142F',
  plumTint: '#E5D0DD',
  green: '#2B6338',
  greenDeep: '#14341C',
  greenTint: '#D0E0CF',
  blueDeep: '#0F2650',
  blueTint: '#D3DCEE',
});
