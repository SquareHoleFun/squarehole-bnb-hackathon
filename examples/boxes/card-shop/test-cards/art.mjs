// Original public trading-card drawings: plain objects, our own frames and our own stroke lettering. No fonts,
// external assets, brands, characters or hidden editions. Every card is a test stand-in.
export const TIERS = [
  { key: 'common-cards', rarity: 'Common', name: 'Test Trading Cards Common', symbol: 'tCARDC',
    frame: '#7d848e', light: '#e3e6ea', window: ['#e4eaee', '#cbd5dc'] },
  { key: 'uncommon-cards', rarity: 'Uncommon', name: 'Test Trading Cards Uncommon', symbol: 'tCARDU',
    frame: '#2f8a5b', light: '#d9efe1', window: ['#e3f4e6', '#b8dfc3'] },
  { key: 'rare-cards', rarity: 'Rare', name: 'Test Trading Cards Rare', symbol: 'tCARDR',
    frame: '#2c5fa8', light: '#dbe7f7', window: ['#e1ebf9', '#a9c3ea'] },
  { key: 'legendary-cards', rarity: 'Legendary', name: 'Test Trading Cards Legendary', symbol: 'tCARDL',
    frame: '#b5842a', light: '#fbefc8', window: ['#fff6d6', '#f0c75e'] },
];
export const CARD_NAMES = [
  ['Pebble', 'Acorn', 'Teacup', 'Paper Boat'],
  ['Lantern', 'Compass', 'Kite', 'Hourglass'],
  ['Comet', 'Crystal', 'Lighthouse', 'Anchor'],
  ['Sun Crown', 'Moon Key', 'Star Map', 'Storm Bell'],
];
export const PICTURES = 4;
export const WIDTH = 500;
export const HEIGHT = 700;
const ink = '#26303a';
const r2 = v => Math.round(v * 100) / 100;

// A stroke alphabet on a 4 x 6 grid (y down): capitals, digits and '/'. Each glyph is a list of polylines.
const O = [[1, 0], [3, 0], [4, 1], [4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0]];
const P = [[0, 6], [0, 0], [3, 0], [4, 1], [4, 2], [3, 3], [0, 3]];
const GLYPHS = {
  A: [[[0, 6], [0, 2], [2, 0], [4, 2], [4, 6]], [[0, 3.6], [4, 3.6]]],
  B: [[[0, 3], [0, 0], [3, 0], [4, 1], [4, 2], [3, 3], [0, 3], [0, 6], [3, 6], [4, 5], [4, 4], [3, 3]]],
  C: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5]]],
  D: [[[0, 0], [0, 6], [2.5, 6], [4, 4.5], [4, 1.5], [2.5, 0], [0, 0]]],
  E: [[[4, 0], [0, 0], [0, 6], [4, 6]], [[0, 3], [3, 3]]],
  F: [[[4, 0], [0, 0], [0, 6]], [[0, 3], [3, 3]]],
  G: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5], [4, 3.5], [2.4, 3.5]]],
  H: [[[0, 0], [0, 6]], [[4, 0], [4, 6]], [[0, 3], [4, 3]]],
  I: [[[1, 0], [3, 0]], [[2, 0], [2, 6]], [[1, 6], [3, 6]]],
  J: [[[4, 0], [4, 5], [3, 6], [1, 6], [0, 5]]],
  K: [[[0, 0], [0, 6]], [[4, 0], [0, 4]], [[1.3, 2.7], [4, 6]]],
  L: [[[0, 0], [0, 6], [4, 6]]],
  M: [[[0, 6], [0, 0], [2, 3], [4, 0], [4, 6]]],
  N: [[[0, 6], [0, 0], [4, 6], [4, 0]]],
  O: [O],
  P: [P],
  Q: [O, [[2.5, 4.5], [4, 6]]],
  R: [P, [[2, 3], [4, 6]]],
  S: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 2], [1, 3], [3, 3], [4, 4], [4, 5], [3, 6], [1, 6], [0, 5]]],
  T: [[[0, 0], [4, 0]], [[2, 0], [2, 6]]],
  U: [[[0, 0], [0, 5], [1, 6], [3, 6], [4, 5], [4, 0]]],
  V: [[[0, 0], [2, 6], [4, 0]]],
  W: [[[0, 0], [1, 6], [2, 3], [3, 6], [4, 0]]],
  X: [[[0, 0], [4, 6]], [[4, 0], [0, 6]]],
  Y: [[[0, 0], [2, 3], [4, 0]], [[2, 3], [2, 6]]],
  Z: [[[0, 0], [4, 0], [0, 6], [4, 6]]],
  0: [O, [[3.6, 0.8], [0.4, 5.2]]],
  1: [[[1, 1], [2, 0], [2, 6]], [[1, 6], [3, 6]]],
  2: [[[0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [0, 6], [4, 6]]],
  3: [[[0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [3, 3], [1.5, 3]], [[3, 3], [4, 4], [4, 5], [3, 6], [1, 6], [0, 5]]],
  4: [[[3, 6], [3, 0], [0, 4], [4, 4]]],
  5: [[[4, 0], [0, 0], [0, 3], [3, 3], [4, 4], [4, 5], [3, 6], [1, 6], [0, 5]]],
  6: [[[3.5, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [3, 3], [0, 3]]],
  7: [[[0, 0], [4, 0], [1.5, 6]]],
  8: [[[1, 3], [0, 2], [0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [3, 3], [1, 3], [0, 4], [0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [3, 3]]],
  9: [[[4, 3], [1, 3], [0, 2], [0, 1], [1, 0], [3, 0], [4, 1], [4, 5], [3, 6], [0.5, 6]]],
  '/': [[[0, 6], [4, 0]]],
  ' ': [],
};
const advance = ch => (ch === ' ' ? 2.4 : 4);
const GAP = 1.6;

/** One line of capitals as a single stroked path, centred on (x, y) unless anchored at the start. */
export function lettering(text, { x, y, height, color = ink, weight = height / 7, anchor = 'middle' }) {
  const s = height / 6;
  const chars = [...text.toUpperCase()];
  for (const ch of chars) if (!Object.hasOwn(GLYPHS, ch)) throw new Error(`no glyph for ${ch}`);
  const total = chars.reduce((sum, ch) => sum + advance(ch) + GAP, -GAP) * s;
  let left = anchor === 'middle' ? x - total / 2 : anchor === 'end' ? x - total : x;
  const top = y - height / 2;
  let d = '';
  for (const ch of chars) {
    for (const line of GLYPHS[ch]) d += line.map(([gx, gy], i) => `${i ? 'L' : 'M'}${r2(left + gx * s)} ${r2(top + gy * s)}`).join('');
    left += (advance(ch) + GAP) * s;
  }
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${r2(weight)}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

// `extra` may carry its own stroke colour, which then replaces the ink.
const path = (d, fill = 'none', width = 6, extra = '') => {
  const stroke = extra.match(/ stroke="([^"]+)"/)?.[1] ?? ink;
  return `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"${extra.replace(/ stroke="[^"]+"/, '')}/>`;
};
const circle = (x, y, r, fill, width = 6, extra = '') => `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${ink}" stroke-width="${width}"${extra}/>`;
const ellipse = (x, y, rx, ry, fill, width = 6, extra = '') => `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="${fill}" stroke="${ink}" stroke-width="${width}"${extra}/>`;
const rect = (x, y, w, h, rx, fill, width = 6, extra = '') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${ink}" stroke-width="${width}"${extra}/>`;
const star = (x, y, r, fill) => path(`M${x} ${y - r} L${x + r * 0.28} ${y - r * 0.28} ${x + r} ${y} ${x + r * 0.28} ${y + r * 0.28} ${x} ${y + r} ${x - r * 0.28} ${y + r * 0.28} ${x - r} ${y} ${x - r * 0.28} ${y - r * 0.28}Z`, fill, 3);
const rays = (count, inner, outer, fill, spread = 0.12) => Array.from({ length: count }, (_, i) => {
  const a = (i / count) * 2 * Math.PI;
  const p = (r, d) => `${r2(Math.cos(a + d) * r)} ${r2(Math.sin(a + d) * r)}`;
  return path(`M${p(inner, -spread)} L${p(outer, 0)} ${p(inner, spread)}Z`, fill, 3);
}).join('');

/** The sixteen drawings, in a 360 x 300 window centred on (0, 0). */
function drawing(tier, picture) {
  switch (tier * 4 + picture) {
    case 1: return ellipse(0, 118, 150, 18, '#b9c2c9', 0)
      + ellipse(0, 78, 125, 44, '#8f9aa3') + ellipse(-12, 8, 92, 38, '#b3bcc3') + ellipse(6, -52, 60, 28, '#ccd2d7')
      + path('M-70 62 Q-40 50 -10 58 M30 -4 Q50 -12 66 -2 M-10 -60 Q4 -66 20 -60', 'none', 4)
      + star(96, -92, 16, '#ffffff');
    case 2: return ellipse(0, 128, 90, 14, '#b9c2c9', 0)
      + path('M-62 -18 Q-70 70 0 122 Q70 70 62 -18Z', '#c98a45')
      + path('M-30 20 Q-34 60 -8 92', 'none', 5, ' stroke-opacity="0.45"')
      + path('M-80 -12 Q-86 -96 0 -100 Q86 -96 80 -12Z', '#7d5228')
      + path('M-60 -60 L-40 -30 M-30 -80 L-10 -40 M0 -88 L20 -44 M30 -80 L50 -40 M58 -62 L70 -36', 'none', 4)
      + path('M0 -100 Q4 -128 26 -138', 'none', 9);
    case 3: return ellipse(0, 100, 150, 30, '#eef2f5')
      + path('M80 -20 C150 -26 150 54 70 50', 'none', 22) + path('M80 -20 C150 -26 150 54 70 50', 'none', 10, ' stroke="#e9f0f5"')
      + path('M-98 -40 L98 -40 Q92 70 0 90 Q-92 70 -98 -40Z', '#e9f0f5')
      + ellipse(0, -40, 98, 20, '#b07b4f')
      + path('M-60 10 Q0 24 60 10', 'none', 4, ' stroke="#6fa3c4"') + circle(0, 46, 10, '#6fa3c4', 3)
      + path('M-30 -76 Q-44 -96 -30 -116 Q-16 -136 -30 -150 M10 -72 Q-4 -94 10 -116 Q24 -136 10 -150 M50 -76 Q36 -96 50 -116', 'none', 5, ' stroke-opacity="0.6"');
    case 4: return path('M-170 110 Q-140 92 -110 110 Q-80 128 -50 110 Q-20 92 10 110 Q40 128 70 110 Q100 92 130 110 Q150 122 170 110 L170 150 L-170 150Z', '#8fbfdc')
      + path('M-130 30 L130 30 L88 92 L-88 92Z', '#f7f6ef')
      + path('M-6 30 L-6 -130 L96 30Z', '#ffffff') + path('M-22 30 L-22 -96 L-104 30Z', '#eef1f6')
      + path('M-6 -130 L44 -50 M-22 -96 L-60 -30 M-88 92 L-40 30 M88 92 L40 30', 'none', 4);
    case 5: return circle(0, 0, 120, '#ffe9a8', 0, ' opacity="0.7"')
      + circle(0, -132, 14, 'none', 6) + path('M-56 -108 L56 -108 L78 -76 L-78 -76Z', '#3c5a46')
      + rect(-64, -76, 128, 150, 12, '#ffd96b')
      + path('M-30 -76 L-30 74 M30 -76 L30 74', 'none', 5)
      + path('M0 -36 Q30 4 14 30 Q0 44 -14 30 Q-30 4 0 -36Z', '#ff8a3d', 4)
      + path('M-78 74 L78 74 L56 104 L-56 104Z', '#3c5a46');
    case 6: return circle(0, -136, 15, 'none', 7) + circle(0, 0, 122, '#d7b46a') + circle(0, 0, 100, '#fbf6e6')
      + Array.from({ length: 8 }, (_, i) => `<g transform="rotate(${i * 45})">${path('M0 -98 L0 -80', 'none', i % 2 ? 3 : 6)}</g>`).join('')
      + path('M0 -84 L20 0 L-20 0Z', '#d9483b', 4) + path('M0 84 L20 0 L-20 0Z', '#5b6573', 4) + circle(0, 0, 9, '#fbf6e6', 4);
    case 7: return path('M0 116 Q30 132 10 150 Q-10 166 22 180', 'none', 5)
      + path('M18 140 L36 130 L32 150Z M8 164 L-12 158 L-4 176Z', '#ffd166', 3)
      + path('M0 -140 L92 -30 L0 116 L-92 -30Z', '#e85d75')
      + path('M0 -140 L92 -30 L0 -30Z', '#ffd166', 0) + path('M0 -30 L-92 -30 L0 116Z', '#58c4e8', 0)
      + path('M0 -140 L92 -30 L0 116 L-92 -30Z', 'none') + path('M0 -140 L0 116 M-92 -30 L92 -30', 'none', 4);
    case 8: return rect(-92, -142, 184, 24, 7, '#8b5e34') + rect(-92, 118, 184, 24, 7, '#8b5e34')
      + path('M-80 -118 L-80 118 M80 -118 L80 118', 'none', 8)
      + path('M-62 -118 Q-62 -30 -8 0 Q-62 30 -62 118 L62 118 Q62 30 8 0 Q62 -30 62 -118Z', '#e8f4f8')
      + path('M-48 -62 Q0 -44 48 -62 Q38 -26 0 -6 Q-38 -26 -48 -62Z', '#e9c46a', 4)
      + path('M-56 116 Q0 52 56 116Z', '#e9c46a', 4) + path('M0 -6 L0 70', 'none', 3, ' stroke="#c99a2e"');
    case 9: return star(-120, -100, 14, '#ffffff') + star(130, 90, 10, '#ffffff') + star(-60, 110, 8, '#ffffff')
      + path('M40 -86 Q-70 -50 -170 120 Q-60 10 92 -18Z', '#9ad1ff', 5, ' opacity="0.9"')
      + path('M48 -70 Q-30 -30 -110 70 Q-30 0 78 -32Z', '#d6eeff', 0)
      + circle(66, -54, 42, '#fff2b3') + circle(56, -64, 14, '#ffffff', 0);
    case 10: return ellipse(0, 112, 150, 26, '#8a8f98')
      + path('M-96 110 L-128 0 L-112 -54 L-78 -20 L-62 100Z', '#c3b1f5')
      + path('M96 110 L132 10 L118 -44 L82 -12 L66 100Z', '#c3b1f5')
      + path('M0 -146 L46 -96 L46 92 L0 124 L-46 92 L-46 -96Z', '#9b7bea')
      + path('M0 -146 L0 124 M-46 -96 L0 -60 L46 -96 M-24 -10 L-24 70', 'none', 4)
      + star(70, -110, 14, '#ffffff');
    case 11: return path('M-14 -82 L-180 -40 L-180 -10Z M14 -82 L180 -40 L180 -10Z', '#fff6b0', 0, ' opacity="0.85"')
      + path('M-170 130 Q-120 110 -70 126 L-70 150 L-170 150Z M170 130 Q120 110 70 126 L70 150 L170 150Z', '#6b7a86')
      + path('M-44 -60 L44 -60 L64 132 L-64 132Z', '#ffffff')
      + path('M-40 -20 L40 -20 L44 16 L-44 16Z M-48 52 L48 52 L52 88 L-52 88Z', '#d64545', 4)
      + path('M-44 -60 L44 -60 L64 132 L-64 132Z', 'none') + rect(-34, -104, 68, 44, 6, '#ffe066')
      + path('M-50 -104 L0 -146 L50 -104Z', '#c0392b') + path('M-12 -104 L-12 -60 M12 -104 L12 -60', 'none', 4);
    case 12: return circle(0, -122, 20, 'none', 12)
      + path('M-124 22 Q-114 122 0 128 Q114 122 124 22', 'none', 28) + path('M-124 22 Q-114 122 0 128 Q114 122 124 22', 'none', 16, ' stroke="#6c7e8f"')
      + path('M-146 40 L-124 2 L-100 40Z M146 40 L124 2 L100 40Z', '#6c7e8f', 5)
      + rect(-13, -102, 26, 226, 8, '#6c7e8f') + rect(-72, -84, 144, 22, 8, '#6c7e8f');
    case 13: return circle(0, -36, 100, '#fff0b8', 0) + `<g transform="translate(0 -36)">${rays(16, 96, 150, '#ffd35c')}</g>`
      + path('M-122 62 L-122 -40 L-62 14 L0 -86 L62 14 L122 -40 L122 62Z', '#ffcf4d')
      + circle(-122, -46, 12, '#fff4cc', 4) + circle(0, -92, 13, '#fff4cc', 4) + circle(122, -46, 12, '#fff4cc', 4)
      + rect(-126, 62, 252, 42, 8, '#dc9f22')
      + circle(-70, 83, 11, '#d9483b', 4) + circle(0, 83, 13, '#3a7bd5', 4) + circle(70, 83, 11, '#2f9e5b', 4);
    case 14: return star(-120, -110, 12, '#ffffff') + star(110, -60, 9, '#ffffff') + star(-100, 70, 8, '#ffffff')
      + path('M30 -132 A60 60 0 1 0 30 -28 A52 52 0 0 1 30 -132Z', '#f5e6a8')
      + rect(-9, -24, 18, 168, 6, '#d4a72c')
      + path('M9 92 L48 92 L48 112 L30 112 L30 128 L9 128', '#d4a72c', 5);
    case 15: return path('M-150 -104 L150 -104 L150 112 L-150 112Z', '#1d3557')
      + ellipse(-150, 4, 14, 112, '#e9d8a6') + ellipse(150, 4, 14, 112, '#e9d8a6')
      + path('M-100 60 L-50 -10 L10 20 L60 -60 L110 -20 M10 20 L40 80', 'none', 3, ' stroke="#a8c5ff"')
      + [[-100, 60], [-50, -10], [10, 20], [60, -60], [110, -20], [40, 80]].map(([x, y]) => star(x, y, 11, '#fff7c2')).join('')
      + star(-96, -64, 7, '#ffffff') + star(90, 64, 6, '#ffffff');
    case 16: return path('M-136 -150 L-86 -150 L-118 -70 L-76 -70 L-146 40 L-128 -36 L-164 -36Z', '#7fd1ff', 4)
      + path('M90 -120 L120 -120 L104 -84 L128 -84 L88 -30 L98 -70 L76 -70Z', '#7fd1ff', 4)
      + circle(0, -112, 14, 'none', 7)
      + path('M-92 72 Q-92 -96 0 -100 Q92 -96 92 72 L114 98 L-114 98Z', '#e0b040')
      + path('M-60 10 Q0 -6 60 10', 'none', 4) + circle(0, 114, 17, '#a87a1d')
      + path('M-50 -56 Q-56 -20 -58 30', 'none', 5, ' stroke="#fff1bf"');
    default: throw new Error('card');
  }
}

/** The frame of a tier: plain stone, double green line, blue with corner gems, gold with stars and rays. */
function frame(tier) {
  const t = TIERS[tier];
  const defs = `<defs><linearGradient id="window-${tier}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.window[0]}"/><stop offset="1" stop-color="${t.window[1]}"/></linearGradient>`
    + (tier === 3 ? '<linearGradient id="gold-3" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f1cf6b"/><stop offset="0.5" stop-color="#c8952f"/><stop offset="1" stop-color="#9d6c1a"/></linearGradient>' : '')
    + '</defs>';
  const body = `<rect x="2" y="2" width="${WIDTH - 4}" height="${HEIGHT - 4}" rx="28" fill="${tier === 3 ? 'url(#gold-3)' : t.frame}" stroke="${ink}" stroke-width="4"/>`;
  const corners = (draw) => [[30, 30], [WIDTH - 30, 30], [30, HEIGHT - 30], [WIDTH - 30, HEIGHT - 30]].map(([x, y]) => draw(x, y)).join('');
  const ornament = tier === 0 ? ''
    : tier === 1 ? `<rect x="11" y="11" width="${WIDTH - 22}" height="${HEIGHT - 22}" rx="22" fill="none" stroke="#d9efe1" stroke-width="3"/>` + corners((x, y) => circle(x, y, 6, '#d9efe1', 3))
      : tier === 2 ? `<rect x="11" y="11" width="${WIDTH - 22}" height="${HEIGHT - 22}" rx="22" fill="none" stroke="#dbe7f7" stroke-width="2"/>`
        + corners((x, y) => path(`M${x} ${y - 12} L${x + 12} ${y} L${x} ${y + 12} L${x - 12} ${y}Z`, '#8fd3ff', 3))
        : `<rect x="11" y="11" width="${WIDTH - 22}" height="${HEIGHT - 22}" rx="22" fill="none" stroke="#fff4cc" stroke-width="3"/>` + corners((x, y) => star(x, y, 16, '#fff4cc'));
  return defs + body + ornament;
}

export function cardSvg(tier, picture) {
  const t = TIERS[tier];
  const number = tier * PICTURES + picture;
  const name = CARD_NAMES[tier][picture - 1];
  const pips = Array.from({ length: tier + 1 }, (_, i) => {
    const x = WIDTH / 2 + (i - tier / 2) * 30;
    return path(`M${x} 494 L${x + 10} 506 L${x} 518 L${x - 10} 506Z`, t.frame, 3);
  }).join('');
  const back = tier === 3 ? `<g transform="translate(250 300)" opacity="0.35">${rays(24, 40, 260, '#fff4cc', 0.05)}</g>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img">`
    + `<title>${t.name}: ${name} ${String(number).padStart(2, '0')}/16</title><desc>Public test stand-in: an invented ${t.rarity.toLowerCase()} trading card with our own art. No issuer, brand or card game.</desc>`
    + frame(tier)
    + `<rect x="24" y="24" width="${WIDTH - 48}" height="${HEIGHT - 48}" rx="18" fill="#f6f1e3" stroke="${ink}" stroke-width="3"/>`
    + rect(42, 42, WIDTH - 84, 62, 10, t.light, 3) + lettering(name, { x: WIDTH / 2, y: 73, height: 30, weight: 4.6 })
    + `<rect x="42" y="118" width="${WIDTH - 84}" height="362" rx="10" fill="url(#window-${tier})" stroke="${ink}" stroke-width="4"/>`
    + `<svg x="44" y="120" width="${WIDTH - 88}" height="358" viewBox="44 120 ${WIDTH - 88} 358" overflow="hidden">${back}<g transform="translate(250 302)">${drawing(tier, picture)}</g></svg>`
    + pips
    + rect(42, 532, WIDTH - 84, 58, 10, tier === 3 ? 'url(#gold-3)' : t.frame, 3)
    + lettering(t.rarity, { x: WIDTH / 2, y: 561, height: 26, color: '#fbf8ef', weight: 4.4 })
    + lettering('Test card', { x: 50, y: 630, height: 16, weight: 2.8, anchor: 'start', color: '#5a6470' })
    + lettering(`${String(number).padStart(2, '0')}/16`, { x: WIDTH - 50, y: 630, height: 20, weight: 3.2, anchor: 'end' })
    + '</svg>\n';
}

export function pieces() {
  return TIERS.flatMap((t, tier) => Array.from({ length: PICTURES }, (_, i) => ({
    tier, picture: i + 1, base: `art/${t.key}/${i + 1}`, name: CARD_NAMES[tier][i], number: tier * PICTURES + i + 1, svg: cardSvg(tier, i + 1),
  })));
}

/** One picture of all sixteen cards, a row per tier, for review before anything is minted on a public network. */
export function contactSheetSvg() {
  const scale = 0.5; const gap = 24; const w = WIDTH * scale; const h = HEIGHT * scale;
  const width = 4 * w + 5 * gap; const height = 4 * h + 5 * gap;
  const cards = pieces().map(p => {
    const inner = p.svg.replace(/^<svg [^>]*>/, '').replace(/<\/svg>\n$/, '')
      .replaceAll(`id="window-${p.tier}"`, `id="window-${p.tier}-${p.picture}"`).replaceAll(`url(#window-${p.tier})`, `url(#window-${p.tier}-${p.picture})`)
      .replaceAll('id="gold-3"', `id="gold-3-${p.picture}"`).replaceAll('url(#gold-3)', `url(#gold-3-${p.picture})`);
    const x = gap + (p.picture - 1) * (w + gap); const y = gap + p.tier * (h + gap);
    return `<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="0 0 ${WIDTH} ${HEIGHT}">${inner}</svg>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">`
    + '<title>Test trading cards: all sixteen</title>'
    + `<rect width="${width}" height="${height}" fill="#2b2f36"/>${cards}</svg>\n`;
}

/** The card shop's logo: three of the tier frames fanned out, no lettering. */
export function logoSvg() {
  const card = (tier, angle, dx) => `<g transform="translate(${256 + dx} 300) rotate(${angle})">`
    + `<rect x="-100" y="-140" width="200" height="280" rx="16" fill="${tier === 3 ? '#c8952f' : TIERS[tier].frame}" stroke="${ink}" stroke-width="6"/>`
    + `<rect x="-86" y="-126" width="172" height="252" rx="10" fill="#f6f1e3" stroke="${ink}" stroke-width="3"/>`
    + `<rect x="-72" y="-108" width="144" height="150" rx="8" fill="${TIERS[tier].window[1]}" stroke="${ink}" stroke-width="4"/>`
    + `<rect x="-72" y="62" width="144" height="34" rx="6" fill="${tier === 3 ? '#c8952f' : TIERS[tier].frame}" stroke="${ink}" stroke-width="3"/>`
    + Array.from({ length: tier + 1 }, (_, i) => { const x = (i - tier / 2) * 22; return path(`M${x} 44 L${x + 8} 53 L${x} 62 L${x - 8} 53Z`, '#fbf8ef', 2); }).join('')
    + '</g>';
  return '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" role="img">'
    + '<title>Card shop</title><desc>Three invented trading cards fanned out; no issuer, brand or card game.</desc>'
    + '<rect width="512" height="512" rx="64" fill="#283044"/>'
    + card(1, -16, -90) + card(2, 14, 90)
    + `<g>${card(3, 0, 0).replace('<g transform="translate(256 300) rotate(0)">', '<g transform="translate(256 286) rotate(0)">')}</g>`
    + `<g transform="translate(256 205)">${star(0, 0, 30, '#fff4cc')}</g>`
    + '</svg>\n';
}
