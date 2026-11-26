/**
 * One bag on one hook: the shadow on the wall, the hook, the bag, and the hook's curl over the strap.
 */
import { MIX } from './palette.mjs';
import { group, r2 } from './doc.mjs';
import { hook } from './wall.mjs';
import { silhouette } from './pen.mjs';
import { KINDS } from './bags.mjs';

/** The radius of a hook's curl at a given size: a bag hangs `hookOffset(size)` to the right of its hook's hole. */
export const hookOffset = (size = 1) => 20 * size;

/**
 * Draws bag `kind` hanging at x = cx from a hook whose hole is at (cx - hookOffset(size), hookY). With
 * `grid` = [pitch, ox, oy] the hole must be one of the wall's holes, or this throws and names the nearest one.
 * `size` scales the hook and the shadow. Other options go to the bag (top, w, h, ow and colors).
 */
export function hangBag(doc, kind, { cx, hookY, top, w, h, ow, size = 1, shadow = [22, 26], id = kind, grid = null, ...rest }) {
  const draw = KINDS[kind];
  if (!draw) throw new Error(`no bag kind ${kind}`);
  const r = hookOffset(size);
  if (grid) {
    const [pitch, ox, oy] = grid;
    const near = (v, o) => o + Math.round((v - o) / pitch) * pitch;
    const hx = near(cx - r, ox);
    const hy = near(hookY, oy);
    if (Math.abs(hx - (cx - r)) > 0.01 || Math.abs(hy - hookY) > 0.01) {
      throw new Error(`${id}: a hook must sit in a hole; the nearest hole is at ${hx}, ${hy}, so use cx ${r2(hx + r)} and hookY ${hy}`);
    }
  }
  const hk = hook({ x: cx - r, y: hookY, len: 76 * size, r, w: 14 * size, ow: ow * 0.9 });
  const bag = draw({ cx, top, w, h, hang: hk.hang, ow, id: `${id}-${Math.round(cx)}-${Math.round(top)}`, ...rest });
  if (bag.clip) doc.def(bag.clip[0], `<clipPath id="${bag.clip[0]}"><path d="${bag.clip[1]}"/></clipPath>`);
  const shade = group(`transform="translate(${r2(shadow[0] * size)} ${r2(shadow[1] * size)})"`, silhouette(bag.sil, MIX.wallShade));
  return shade + hk.back + bag.art + hk.front;
}
