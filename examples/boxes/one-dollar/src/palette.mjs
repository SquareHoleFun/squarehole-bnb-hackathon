/**
 * One Dollar is all you need palette: a claret gallery at night, lit by one spotlight. The dollar is a green cartoon
 * bill in a brass frame, every USDC coin is silver, the tokens are rose, the pool is teal water and a burn is a flame.
 * The fourteen named colors are the brand palette (brand-book.md). The rest are fixed shades used only inside the art.
 * No other file defines a color.
 */
export const C = Object.freeze({
  claret: '#4E1626', // claret: every background, the gallery wall
  night: '#2A0B14', // night: the floor and the deepest ground
  ink: '#12070B', // ink: every outline, text on light grounds
  ivory: '#F4ECDD', // ivory: text on dark, placards, light grounds
  silver: '#CFD5DD', // silver: every USDC coin, coin labels on dark
  rose: '#F29AB2', // rose: the tokens, ticker labels on dark
  flame: '#FF7466', // flame: fire, burns, burn labels and errors on dark
  ember: '#FF9A4A', // ember: the middle of a flame, warnings on dark
  teal: '#56BDB6', // teal: the pool's water, pool labels on dark
  brass: '#D2A656', // brass: stanchions, plaques and the frame. Never a coin
  green: '#94CF9C', // green: the dollar's labels on dark, the light ink on the bill
  deepRose: '#9E3557', // deep rose: ticker text and links on ivory
  deepRed: '#A3222F', // deep red: errors and burn labels on ivory
  deepGreen: '#2C5B40', // deep green: the bill's ink, dollar text on ivory
});

/** Fixed shades, so every piece of art uses the same ones. */
export const MIX = Object.freeze({
  wallHigh: '#5C1C2F', // the lit middle of the wall
  wallLow: '#3F111E', // the wall near the floor, panel shadows
  wallDeep: '#2F0C17', // the wall's dark edges
  rail: '#6E2539', // the lit edge of the chair rail and the panel mouldings
  floorDeep: '#1B070D', // the front of the floor
  silverDark: '#8F99A6', // the shaded side of a coin and its rim
  silverDeep: '#5D6775', // a coin's edge
  silverLight: '#F4F7FA', // the shine on a coin
  roseDark: '#C8607E', // a token's rim and shaded side
  roseDeep: '#8A2747', // the rosette on a token
  roseLight: '#FFD3DF', // the shine on a token
  billPaper: '#DCE8CF', // the bill's paper
  billLight: '#EEF4E4', // the bill's lit paper and its medallion
  billShade: '#BFD3AE', // the bill's shaded paper and its border band
  billLine: '#6E9E78', // the fine lines of the bill's border and medallion
  ivoryDark: '#DCCFBA', // the shaded side of the mantel, the basin and the envelope
  ivoryDeep: '#B8A98F', // the lines on the mantel, the envelope's back
  glass: '#D6EEEE', // glass, always at low opacity
  tealDark: '#2E8D88', // the pool's water further down
  tealDeep: '#1C5B59', // the deepest water and its shade
  tealLight: '#B3EDE6', // ripples
  brassDark: '#94702F', // the shaded side of brass
  brassLight: '#F1D79A', // the shine on brass
  velvet: '#B42A43', // the velvet rope, the lit velvet inside the frame
  velvetDark: '#7C1A2D', // the rope's shaded underside, the frame's velvet mat
  amber: '#FFC867', // the inside of a flame
  iron: '#2A1D22', // the grate, the stanchions' feet
  soot: '#14080C', // the inside of the fireplace
  ash: '#6F6468', // cold ash
  smoke: '#B9ADB1', // a thread of smoke, always at low opacity
  light: '#FFF2D6', // the spotlight, always at low opacity
  shine: '#FFFFFF', // a faint shine, always at low opacity
});

/** The fire's layers from outside to inside. Every flame is drawn in this order. */
export const FLAME = Object.freeze([C.flame, C.ember, MIX.amber, C.ivory]);
