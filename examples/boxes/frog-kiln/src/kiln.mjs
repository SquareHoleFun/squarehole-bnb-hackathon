/**
 * The kiln: a brick dome with a chimney and an arched firebox door, in a box 600 units wide and 700 tall (chimney
 * cap at the top, footing at the bottom). It is cold, glowing or firing. When it fires, its door is full of flame and
 * smoke rises from the chimney. The counter plaque says FIRED over a row of number wheels that show no number.
 */
import { C, MIX } from './palette.mjs';
import { archPath, circle, ellipsePath, group, place, r2, roundRect, smooth } from './doc.mjs';
import { clipped, flat, line, outline, shape } from './pen.mjs';
import { bricks } from './studio.mjs';
import { carved } from './type.mjs';

const DOME = 'M30 700V420A270 300 0 0 1 570 420V700Z';
const DOOR = archPath(300, 664, 236, 270);
const RING = archPath(300, 664, 310, 312);

/** Smoke puffs rising from (x, y), drifting right. */
export function smoke(x, y, scale, ow) {
  const puffs = [[0, 0, 30], [30, -40, 36], [76, -74, 40], [130, -96, 34], [180, -108, 26]];
  return puffs.map(([dx, dy, r], i) => shape(ellipsePath(x + dx * scale, y + dy * scale, r * scale, r * 0.86 * scale), i % 2 ? C.ash : MIX.ashLight, ow)).join('');
}

/** Flames in a door-shaped opening: three tongues of flame and a bright core. Local units of the kiln box. */
function flames(ow) {
  const tongue = (cx, h, w, lean) => smooth([[cx - w, 664], [cx - w * 0.7, 664 - h * 0.45], [cx - w * 0.2 + lean, 664 - h * 0.8], [cx + lean, 664 - h],
    [cx + w * 0.35 + lean * 0.4, 664 - h * 0.6], [cx + w * 0.8, 664 - h * 0.3], [cx + w, 664]], 0.85);
  return [
    flat(DOOR, C.flame),
    flat(archPath(300, 664, 190, 228), C.ember),
    shape(tongue(232, 196, 56, -12), C.ember, ow * 0.7),
    shape(tongue(372, 210, 58, 14), C.ember, ow * 0.7),
    shape(tongue(300, 250, 70, 4), MIX.fireCore, ow * 0.7),
    flat(tongue(300, 150, 36, 2), MIX.glint),
  ];
}

/** The counter plaque: FIRED cut into a clay slab, over five number wheels that show no number. Px, unscaled. */
export function counter({ x, y, w, ow }) {
  const h = w * 0.62;
  const wheels = [];
  const ww = (w * 0.78) / 5;
  const wx = x + w * 0.11;
  const wy = y + h * 0.5;
  for (let i = 0; i < 5; i += 1) {
    const cx = wx + i * ww;
    wheels.push(shape(roundRect(cx + ww * 0.08, wy, ww * 0.84, h * 0.36, ww * 0.12), C.bisque, ow * 0.6),
      line(`M${r2(cx + ww * 0.24)} ${r2(wy + h * 0.12)}H${r2(cx + ww * 0.76)}M${r2(cx + ww * 0.24)} ${r2(wy + h * 0.24)}H${r2(cx + ww * 0.76)}`, MIX.bisqueDark, ow * 0.6));
  }
  return [
    shape(roundRect(x, y, w, h, w * 0.08), C.slab, ow),
    carved('FIRED', { x: x + w / 2, y: y + h * 0.1, cap: h * 0.26, seed: 'counter' }),
    ...wheels,
  ];
}

/**
 * The kiln at (x, y), the top left of its 600 x 700 box, drawn `size` px wide. `state` is 'cold', 'glow' or 'fire'.
 * `ow` is the outline width in px.
 */
export function kiln(doc, { x = 0, y = 0, size = 600, state = 'cold', ow = 8, seed = 'kiln' } = {}) {
  const k = size / 600;
  const o = ow / k;
  const chimney = 'M246 20H354V200H246Z';
  const parts = [
    // The chimney behind the dome, with a lip.
    bricks(doc, chimney, { x: 240, y: 10, w: 120, h: 200, course: 30, seed: `${seed}-c` }),
    outline(chimney, o),
    shape(roundRect(232, 6, 136, 30, 8), MIX.brickDark, o),
    // The dome and its footing.
    bricks(doc, DOME, { x: 30, y: 110, w: 540, h: 600, course: 40, seed }),
    outline(DOME, o),
    shape(roundRect(0, 664, 600, 48, 10), MIX.brickDark, o),
    // The arch of wedge bricks around the door.
    shape(RING, MIX.brickLight, o),
    ...[-62, -38, -14, 14, 38, 62].map((a) => {
      const t = (a * Math.PI) / 180;
      return line(`M${r2(300 + Math.sin(t) * 120)} ${r2(530 - Math.cos(t) * 135)}L${r2(300 + Math.sin(t) * 155)} ${r2(530 - Math.cos(t) * 168)}`, MIX.mortar, o * 0.8);
    }),
    // The door: dark when cold, a bed of embers when it glows, full of flame when it fires.
    shape(DOOR, MIX.doorDark, o),
    state === 'glow' ? clipped(doc, DOOR, flat(ellipsePath(300, 676, 120, 56), C.flame), flat(ellipsePath(300, 680, 80, 34), C.ember)) : '',
    state === 'fire' ? clipped(doc, DOOR, flames(o)) : '',
    state === 'cold' ? clipped(doc, DOOR, flat(ellipsePath(300, 676, 110, 30), C.ash)) : '',
    outline(DOOR, o),
    // A steel strap round the dome with its rivets, as kilns are braced.
    line('M84 226Q300 196 516 226', C.soot, 22 + 2 * o),
    line('M84 226Q300 196 516 226', C.ash, 22),
    line('M90 220Q300 191 510 220', MIX.ashLight, 5),
    ...[130, 215, 300, 385, 470].map((x) => flat(ellipsePath(x, 226 - 26 * (1 - ((x - 300) / 216) ** 2) + 2, 5.5, 5.5), MIX.ashDark)),
    // A spy hole high on the dome.
    shape(ellipsePath(300, 300, 26, 26), MIX.brickDark, o * 0.8),
    flat(ellipsePath(300, 300, 14, 14), state === 'cold' ? MIX.doorDark : state === 'glow' ? C.flame : MIX.fireCore),
    state === 'fire' ? smoke(310, -30, 1, o * 0.7) : '',
    state === 'fire' ? [circle(180, 380, 6, `fill="${MIX.fireCore}"`), circle(430, 340, 5, `fill="${C.ember}"`), circle(470, 420, 4, `fill="${MIX.fireCore}"`)] : '',
  ];
  return group(place(x, y, { scale: k }), parts);
}


