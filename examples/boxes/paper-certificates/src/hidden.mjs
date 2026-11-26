/**
 * The hidden picture: what every certificate shows until it is drawn, and what every ticket shows. A box with hidden
 * art stores this picture on chain, where it must be one line of printable ASCII of at most 4,096 bytes. So it is
 * drawn by hand here, in whole numbers on a grid of 240: a sealed envelope with a red wax seal and a question mark,
 * on certificate paper inside a thin engraved frame. The kit's PNG of it is rendered from exactly this text.
 */
import { C, MIX } from './palette.mjs';

/** The most bytes the on-chain field takes. */
export const HIDDEN_MAX_BYTES = 4096;

/** The hidden picture as one line of SVG text. */
export function hiddenSvg() {
  const I = C.ink;
  const parts = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" width="1024" height="1024" role="img">',
    '<title>Paper Certificates: a certificate still sealed</title>',
    '<desc>A cream envelope closed with a red wax seal that shows a question mark, on old certificate paper in a thin engraved frame. It shows which certificate it holds once it is drawn.</desc>',
    `<rect width="240" height="240" fill="${C.paper}"/>`,
    `<rect x="10" y="10" width="220" height="220" rx="8" fill="none" stroke="${I}" stroke-width="2"/>`,
    `<rect x="16" y="16" width="208" height="208" rx="5" fill="none" stroke="${C.gold}" stroke-width="3" stroke-dasharray="1 5" stroke-linecap="round"/>`,
    `<rect x="22" y="22" width="196" height="196" rx="3" fill="none" stroke="${I}" stroke-width="1"/>`,
    // The envelope's shadow, then the envelope and its flaps.
    `<rect x="40" y="76" width="168" height="106" rx="4" fill="${MIX.paperDeep}"/>`,
    `<rect x="34" y="70" width="168" height="106" rx="4" fill="${C.paper}" stroke="${I}" stroke-width="3"/>`,
    `<path d="M36 72L118 126L200 72M36 174L92 120M200 174L144 120" fill="none" stroke="${I}" stroke-width="2" stroke-linejoin="round"/>`,
    `<path d="M48 84H64M48 90H58M176 84H188" fill="none" stroke="${MIX.paperDeep}" stroke-width="2" stroke-linecap="round"/>`,
    // The wax seal: a blob of red, a ring pressed into it, and the question mark.
    `<path d="M118 102L127 104L134 109L139 117L141 126L138 135L132 142L123 147L113 147L104 143L98 136L95 127L97 117L102 109L109 104Z" fill="${C.seal}" stroke="${MIX.sealDark}" stroke-width="2" stroke-linejoin="round"/>`,
    `<circle cx="118" cy="125" r="15" fill="none" stroke="${MIX.sealLight}" stroke-width="1.5"/>`,
    `<path d="M112 120C112 115 115 113 118 113C122 113 124 115 124 119C124 124 118 124 118 130M118 136V137" fill="none" stroke="${C.paper}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>`,
    '</svg>',
  ];
  return parts.join('');
}
