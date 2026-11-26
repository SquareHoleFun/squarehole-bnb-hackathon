/**
 * Bag Holders palette: a shop wall of plum pegboard, with bags on hooks, drawn like a printed sticker sheet.
 * The ten named colors are the brand palette (brand-book.md). MIX holds the fixed shades used only inside the art.
 * No other file defines a color; check.mjs makes sure of that.
 */
export const C = Object.freeze({
  plum: '#7B3B6A', // pegboard plum: every background, links on light grounds
  ink: '#24171F', // ink: every outline, text on light grounds
  canvas: '#F7EEDC', // canvas: totes, light grounds, text on plum
  gold: '#F5C342', // coin gold: the price coin in the story
  tomato: '#E5533D', // tomato: the TOTE chip, pockets, sales
  aqua: '#63C7C2', // pool aqua: the box's own pool
  leaf: '#3E9B5A', // leaf: the claim button, buys
  steel: '#A7AFB6', // steel: hooks and rails
  kraft: '#C08A52', // kraft: the cardboard box, paper bags
  night: '#3A1D33', // night plum: the quiet scene, the hole shading
});

/** Fixed shades, so every picture uses the same ones. */
export const MIX = Object.freeze({
  hole: '#4F2244', // pegboard holes
  wallShade: '#66305A', // soft shadows that objects cast on the wall
  wallLight: '#8A4A79', // the lit edge of the board frame
  frame: '#5A2A4D', // the board's frame and the shelf front
  shelf: '#A0673A', // the shelf top
  shelfDark: '#7A4B27',
  canvasShade: '#E3D3B4',
  canvasDeep: '#CDB98F',
  goldDark: '#C48F1C',
  goldLight: '#FFE7A3',
  tomatoDark: '#B53A27',
  tomatoLight: '#F58A72',
  aquaDark: '#3E9B97',
  aquaLight: '#B5ECE8',
  leafDark: '#2C7342',
  leafLight: '#7CC88F',
  steelDark: '#737C84',
  steelLight: '#D9DEE2',
  kraftDark: '#94612F',
  kraftLight: '#DDB07E',
  plumLight: '#A65B91',
  plumDeep: '#5E2B50',
  nightDeep: '#24101F',
  white: '#FFFFFF',
});
