/**
 * Dragon's Hoard palette: a lair of deep lapis lit by a pile of coins. Coins are gold, HOARD scales are jade, fire is
 * vermilion and ember, and every shape has an ink outline. The eleven named colors are the brand palette
 * (brand-book.md). The rest are fixed shades used only inside the art. No other file defines a color.
 */
export const C = Object.freeze({
  night: '#111A44', // lapis night: every background
  lapis: '#26388C', // lapis: panels, plates, the frame's inner rule, links on light grounds
  ink: '#090D24', // ink: every outline, text on light grounds
  gold: '#F5BE3B', // gold: the coins of the pile, gilt letters, highlights on dark
  jade: '#38C79E', // jade: HOARD scales and the tail
  vermilion: '#F25A3C', // vermilion: fire, burns, sales, errors
  ember: '#FF9B42', // ember: the middle of a flame, warnings
  vellum: '#F8EDD5', // vellum: text on dark, light grounds
  stone: '#4A5AA6', // stone: the pool's basin, the chest's bands. Decoration only
  deepJade: '#0E6A50', // deep jade: jade text and links on vellum
  deepRed: '#A62A1B', // deep red: errors and burn labels on vellum
});

/** Fixed shades, so every piece of art uses the same ones. */
export const MIX = Object.freeze({
  goldDark: '#B9821F', // the shaded side of a coin, coin rims
  goldDeep: '#7A4E12', // coin edges in a stack, the gilt letters' bevel
  goldLight: '#FFE6A3', // the shine on a coin, the gilt letters' highlight
  jadeDark: '#1E8467', // the shaded half of a scale, the tail's underside
  jadeLight: '#A8F2D9', // the shine on a scale
  redDark: '#B8341F', // the outer edge of a flame's shadow
  nightDeep: '#0A1030', // the floor and the deepest ground
  nightHigh: '#1A2763', // the top of a scene's sky, lighter than night
  water: '#3A5CC4', // the pool's water at the top
  waterDeep: '#1E2F7A', // the pool's water at the bottom
  stoneDark: '#33418A', // the shaded side of the basin
  stoneLight: '#7686CC', // the lit rim of the basin
  wood: '#9B5B2F', // the chest's planks
  woodDark: '#653A1C', // the chest's shadow and its open inside
  iron: '#2C3160', // the brazier, the chest's lock plate
  shine: '#FFFFFF', // a faint shine, always at low opacity
});

/** The fire's layers from outside to inside. Every flame is drawn in this order. */
export const FLAME = Object.freeze([C.vermilion, C.ember, C.gold, C.vellum]);
