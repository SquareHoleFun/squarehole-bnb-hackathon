/**
 * SH-251: "What happens" in motion: a coin along a lane into the hole, the 1% out of the box into its tray, then one
 * coin each along the routes to the side's station, the pool and Square Hole's mark. Drawing only: it reads the
 * picture's own paths (BoxPictureSvg ids) and moves circles in its effects layer. It sends nothing and asks nothing.
 * Without the browser's path geometry (a test DOM) or with reduced motion it plays nothing and resolves at once.
 */
import type { Side } from '../../box-picture/picture';

const SVG = 'http://www.w3.org/2000/svg';

/** The system's reduced-motion setting, or the app's own "Reduce motion" (settings/preferences.ts sets data-motion). */
export const prefersReducedMotion = (): boolean => {
  if (typeof document !== 'undefined' && document.documentElement.dataset.motion === 'reduce') return true;
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
};

function along(svg: SVGSVGElement, layer: Element, pathId: string, { r, token = false, ms }: { r: number; token?: boolean; ms: number }): Promise<void> {
  return new Promise((done) => {
    const path = svg.ownerDocument.getElementById(pathId) as SVGPathElement | null;
    // A test DOM has no path geometry: nothing to draw there.
    if (!path || typeof path.getTotalLength !== 'function' || typeof path.getPointAtLength !== 'function' || typeof window.requestAnimationFrame !== 'function') { done(); return; }
    const length = path.getTotalLength();
    const coin = svg.ownerDocument.createElementNS(SVG, 'circle');
    coin.setAttribute('r', String(r));
    coin.setAttribute('class', token ? 'sh-pic-flying sh-pic-flying--token' : 'sh-pic-flying');
    layer.appendChild(coin);
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      const point = path.getPointAtLength(eased * length);
      coin.setAttribute('cx', String(point.x));
      coin.setAttribute('cy', String(point.y));
      if (t < 1) window.requestAnimationFrame(step);
      else { coin.remove(); done(); }
    };
    window.requestAnimationFrame(step);
  });
}

/** Plays one trade on `side` (faster when `quick`); `warn` leaves out the coin to a station the box cannot take. */
export async function playTrade(svg: SVGSVGElement | null, idPrefix: string, side: Side, { quick = false, warn = false } = {}): Promise<void> {
  if (!svg || prefersReducedMotion()) return;
  const layer = svg.ownerDocument.getElementById(`${idPrefix}-fx`);
  if (!layer) return;
  const k = quick ? 0.45 : 1;
  await along(svg, layer, `${idPrefix}-lane-${side}`, { r: 8, token: side === 'sellers', ms: 650 * k });
  await along(svg, layer, `${idPrefix}-drop-${side}`, { r: 6, ms: 300 * k });
  await Promise.all([
    warn ? Promise.resolve() : along(svg, layer, `${idPrefix}-pick-${side}`, { r: 6.5, ms: 520 * k }),
    along(svg, layer, `${idPrefix}-pool-${side}`, { r: 4.5, ms: 600 * k }),
    along(svg, layer, `${idPrefix}-mark-${side}`, { r: 4.5, ms: 260 * k }),
  ]);
}
