/**
 * GPU Poor palette: the world seen through a heat camera. Cold things are ice blue, warm things climb the heat
 * ramp from violet to white-hot. The eleven named colors are the brand palette (brand-book.md). The rest are
 * fixed mixes used only inside the art. There is no green anywhere, on purpose.
 */
export const C = Object.freeze({
  night: '#0D0A1A', // night: every background
  panel: '#1C1636', // panel: shrouds, chips, jars, plates
  rim: '#3B3170', // rim: outlines, frames, grilles. Decoration only
  ice: '#6CD8FF', // ice: the stock coin and every cold thing
  violet: '#9A6BFF', // violet: the cool end of the heat ramp, links on dark
  magenta: '#FF4D8D', // magenta: burns, sales, errors
  orange: '#FF8A2A', // orange: heat
  amber: '#FFC94A', // amber: hot spots, warnings
  white: '#FFF4DC', // white-hot: the hottest point, text on dark
  paper: '#F5F1FF', // paper: light grounds
  deep: '#4A22B5', // deep violet: violet text and links on paper
});

/** The heat ramp from cool to hot. Every warm object takes its bands from here, in this order. */
export const HEAT = Object.freeze([C.violet, C.magenta, C.orange, C.amber, C.white]);

/** Fixed mixes, so every piece of art uses the same shades. */
export const MIX = Object.freeze({
  deepNight: '#08060F', // the darkest floor and shadows
  chip: '#140F28', // a VRAM chip's body
  iceDark: '#2A86B8', // the stock coin's rim
  iceDeep: '#174E70', // the stock coin's emblem
  iceLight: '#D3F4FF', // the stock coin's frost highlight
  liquid: '#3A2A8C', // the pool's liquid, top
  liquidDeep: '#1A1248', // the pool's liquid, bottom
  glass: '#B8A6FF', // the glass of the pool and the jar
  steel: '#5A5290', // grates, brackets, pins in shadow
  tape: '#D9D2EE', // a strip of tape
  tapeLine: '#A69CC9', // the lines on the tape
  ember: '#5B1F4A', // a cold ember
  wallTop: '#120D25', // the top of a scene's wall, darkening toward the floor
  bladeLight: '#CFC6EC', // fan blades on a white shroud
  shine: '#FFFFFF', // the faint shine on glass, always at low opacity
});
