import { C, MIX } from './palette.mjs';

/**
 * The Lake House mark, 1024 x 1024: a small wooden house on posts at the edge of a lake at night, under a moon, with
 * pines behind it. Its one window is the square hole of the reference platform tile: a glowing square ring around a
 * dark square, mirrored in the water. Flat shapes with dark outlines, as the other example kits draw. No words, no
 * people, no coin and nothing that reads as a real place, brand or document. Every colour comes from src/palette.mjs.
 */
export const SIZE = 1024;
export const TITLE = 'Lake House';
export const DESC = 'A small wooden house on posts at the edge of a lake at night, under a moon, with pines behind it. Its square window glows like a square hole and shines on the water.';

const O = C.hole;
const n = v => String(v);
/** A four-pointed glint, its points `r` from the centre, its sides curved in. */
const glint = (x, y, r) => `<path d="M${x} ${y - r}Q${x} ${y} ${x + r} ${y}Q${x} ${y} ${x} ${y + r}Q${x} ${y} ${x - r} ${y}Q${x} ${y} ${x} ${y - r}Z" fill="${C.glow}" fill-opacity="0.55"/>`;
/** A pine: two stacked triangles on the shore line, `h` tall and `w` wide at the foot. */
const pine = (x, base, h, w, fill) => {
  const top = base - h;
  const mid = base - Math.round(h * 0.42);
  const upper = `${x},${top} ${x + Math.round(w * 0.38)},${mid} ${x - Math.round(w * 0.38)},${mid}`;
  const lower = `${x},${base - Math.round(h * 0.7)} ${x + Math.round(w / 2)},${base} ${x - Math.round(w / 2)},${base}`;
  return `<polygon points="${lower}" fill="${fill}" stroke="${O}" stroke-width="10" stroke-linejoin="round"/>`
    + `<polygon points="${upper}" fill="${fill}" stroke="${O}" stroke-width="10" stroke-linejoin="round"/>`;
};
/** A rounded bar on the water, centred on `x`. */
const bar = (x, y, w, h, fill, opacity) => `<rect x="${x - w / 2}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}" fill-opacity="${opacity}"/>`;

export const SHORE = 650;
export const WINDOW = Object.freeze({ x: 350, y: 435, size: 140 });

export function logoSvg() {
  const parts = [];
  parts.push(`<rect width="${SIZE}" height="${SIZE}" fill="${C.sky}"/>`);
  for (const [x, y, r] of [[150, 150, 16], [250, 95, 10], [395, 190, 12], [560, 120, 9], [640, 215, 14], [930, 120, 10], [905, 345, 8], [118, 330, 9]]) parts.push(glint(x, y, r));
  parts.push(`<circle cx="790" cy="235" r="78" fill="${C.wood}" stroke="${O}" stroke-width="14"/>`,
    `<circle cx="765" cy="215" r="14" fill="${C.woodMid}"/>`, `<circle cx="815" cy="262" r="9" fill="${C.woodMid}"/>`);
  for (const [x, h, w] of [[70, 250, 130], [165, 190, 110], [745, 215, 120], [845, 290, 150], [945, 230, 125]]) parts.push(pine(x, SHORE, h, w, MIX.farPine));
  for (const [x, h, w] of [[112, 165, 100], [900, 175, 105]]) parts.push(pine(x, SHORE, h, w, C.pine));
  parts.push(`<rect x="0" y="${SHORE}" width="${SIZE}" height="${SIZE - SHORE}" fill="${MIX.water}"/>`,
    `<line x1="0" y1="${SHORE}" x2="${SIZE}" y2="${SHORE}" stroke="${O}" stroke-width="12"/>`);
  for (const [x, y, w] of [[95, 770, 120], [210, 850, 90], [700, 800, 140], [850, 880, 110], [140, 945, 150], [760, 960, 120]]) parts.push(bar(x, y, w, 10, MIX.ripple, 1));
  for (const [y, w] of [[690, 110], [722, 80], [754, 50]]) parts.push(bar(790, y, w, 10, C.wood, 0.35));
  for (const [y, w] of [[742, 120], [772, 90], [802, 110], [832, 60]]) parts.push(bar(420, y, w, 12, C.glowMid, 0.5));
  for (const x of [292, 477, 662]) parts.push(`<rect x="${x}" y="634" width="26" height="90" fill="${C.woodDark}" stroke="${O}" stroke-width="10"/>`);
  parts.push(`<rect x="260" y="606" width="460" height="28" rx="6" fill="${C.woodDark}" stroke="${O}" stroke-width="12"/>`,
    `<rect x="600" y="270" width="40" height="80" fill="${C.woodDark}" stroke="${O}" stroke-width="12"/>`,
    `<rect x="300" y="405" width="380" height="205" rx="4" fill="${C.wood}" stroke="${O}" stroke-width="14"/>`);
  for (const y of [455, 505, 555]) parts.push(`<line x1="307" y1="${y}" x2="673" y2="${y}" stroke="${C.woodMid}" stroke-width="7"/>`);
  parts.push(`<polygon points="270,412 490,250 710,412" fill="${C.woodDark}" stroke="${O}" stroke-width="14" stroke-linejoin="round"/>`);
  const { x, y, size } = WINDOW;
  parts.push(`<rect x="${x - 16}" y="${y - 16}" width="${size + 32}" height="${size + 32}" rx="30" fill="none" stroke="${C.glowMid}" stroke-width="12" stroke-opacity="0.3"/>`,
    `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="22" fill="${C.hole}" stroke="${C.glow}" stroke-width="16"/>`,
    `<rect x="${x - 9}" y="${y - 9}" width="${size + 18}" height="${size + 18}" rx="28" fill="none" stroke="${C.glowDeep}" stroke-width="4"/>`,
    `<rect x="${x + 16}" y="${y + 16}" width="${size - 32}" height="${size - 32}" rx="12" fill="none" stroke="${C.glowMid}" stroke-width="4"/>`);
  parts.push(`<rect x="545" y="470" width="90" height="140" rx="8" fill="${C.woodMid}" stroke="${O}" stroke-width="12"/>`,
    `<circle cx="615" cy="545" r="8" fill="${O}"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(SIZE)}" height="${n(SIZE)}" viewBox="0 0 ${SIZE} ${SIZE}">`
    + `<title>${TITLE}</title><desc>${DESC}</desc>${parts.join('')}</svg>\n`;
}
