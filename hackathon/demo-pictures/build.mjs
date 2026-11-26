#!/usr/bin/env node
/**
 * SH-295: eight demo logos in the technique of GPU Poor's logo (examples/boxes/gpu-poor/src/brand.mjs): hand-written
 * SVG on a 1024 square (Create's logo side, art-files.ts PICTURES.logo), a night ground with three faint contour rings
 * and a glow in the picture's own colour (five flat bands), a flat emblem in nested bands with a dark outline; rendered to PNG by
 * resvg (the same loader and renderer as GPU Poor, examples/boxes/gpu-poor/src/render.mjs). No lettering in a logo.
 *
 *   node hackathon/demo-pictures/build.mjs          writes <id>.svg, <id>.png (1024), <id>-48.png, contact-sheet.png
 *
 * Each logo PNG must stay within Turbo's free upload (TURBO_FREE_BYTES, 107,520 bytes, pictures/arweave-hosts.ts),
 * so the form publishes it as it is: the largest side from 1024 down to 512 that fits; the build fails otherwise.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { loadResvg, toPng } from '../../examples/boxes/gpu-poor/src/render.mjs';

const OUT = new URL('./', import.meta.url);
const S = 1024;
const NIGHT = '#0D0A1A';
const INK = '#140F28';
const FREE_BYTES = 107_520;

/** The ground: night, three contour rings in the ring colour, one glow in the accent (GPU Poor's mark, brand.mjs). */
function ground(accent, ring) {
  const rings = [390.4, 435.2, 480].map((r, i) => `<circle cx="512" cy="512" r="${r}" fill="none" stroke="${ring}" stroke-opacity="${[0.22, 0.17, 0.11][i]}" stroke-width="2.5"/>`).join('');
  // The glow in five flat bands (GPU Poor's glow is a smooth gradient; bands keep the PNG within the free size).
  const bands = [448, 360, 280, 210, 150].map(r => `<circle cx="512" cy="512" r="${r}" fill="${accent}" fill-opacity="0.07"/>`).join('');
  return `<rect width="${S}" height="${S}" fill="${NIGHT}"/>${rings}${bands}`;
}
const coin = (cx, cy, r, face, rim, mark = INK) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${rim}" stroke="${INK}" stroke-width="${r * 0.14}"/><circle cx="${cx}" cy="${cy}" r="${r * 0.72}" fill="${face}"/><rect x="${cx - r * 0.1}" y="${cy - r * 0.42}" width="${r * 0.2}" height="${r * 0.84}" rx="${r * 0.1}" fill="${mark}" opacity="0.55"/>`;

export const PICTURES = [
  {
    id: 'honey-jar', for: 'the Flap launch in BNB with rules (a pile its holders redeem)', accent: '#FFB020', ring: '#FFC94A',
    desc: 'A honey jar with a drip over its rim: the pile fills, holders dip in.',
    emblem: `<rect x="372" y="232" width="280" height="70" rx="22" fill="#8A4B10" stroke="${INK}" stroke-width="16"/>`
      + `<path d="M340 330 Q340 300 380 300 L644 300 Q684 300 684 330 L700 720 Q700 800 620 800 L404 800 Q324 800 324 720 Z" fill="#3A2A10" stroke="${INK}" stroke-width="18"/>`
      + `<path d="M336 470 L688 470 L698 720 Q698 790 620 790 L404 790 Q326 790 326 720 Z" fill="#FF8A2A"/>`
      + `<path d="M334 520 L690 520 L696 720 Q696 780 620 780 L404 780 Q328 780 328 720 Z" fill="#FFB020"/>`
      + `<path d="M332 600 L692 600 L694 720 Q694 770 620 770 L404 770 Q330 770 330 720 Z" fill="#FFC94A"/>`
      + `<path d="M440 300 L440 380 Q440 420 468 420 Q496 420 496 380 L496 300 Z" fill="#FFC94A" stroke="${INK}" stroke-width="12"/>`
      + `<ellipse cx="420" cy="660" rx="26" ry="60" fill="#FFF4DC" opacity="0.55"/>`,
  },
  {
    id: 'rainy-day', for: 'the Flap launch in the test dollar with rules (a pile in dollars)', accent: '#3DA5F5', ring: '#6CD8FF',
    desc: 'An umbrella held upside down, catching falling coins.',
    emblem: `<path d="M232 470 Q512 860 792 470 Q712 520 652 470 Q582 530 512 470 Q442 530 372 470 Q312 520 232 470 Z" fill="#3DA5F5" stroke="${INK}" stroke-width="18" stroke-linejoin="round"/>`
      + `<path d="M300 500 Q512 800 724 500" fill="none" stroke="#1F6FB2" stroke-width="22"/>`
      + `<rect x="498" y="560" width="28" height="230" rx="12" fill="#D3F4FF" stroke="${INK}" stroke-width="10"/>`
      + `<path d="M512 780 Q512 840 562 840 Q604 840 604 800" fill="none" stroke="#D3F4FF" stroke-width="28" stroke-linecap="round"/>`
      + coin(430, 410, 52, '#5BE3A0', '#1E9A63') + coin(570, 300, 46, '#5BE3A0', '#1E9A63') + coin(612, 430, 40, '#5BE3A0', '#1E9A63') + coin(470, 230, 36, '#5BE3A0', '#1E9A63'),
  },
  {
    id: 'snip', for: 'a Four.meme tax launch with rules (a buy-back that burns)', accent: '#FF4D8D', ring: '#FF8AB8',
    desc: 'Scissors cutting a coin in two, sparks at the cut.',
    emblem: coin(600, 430, 150, '#FFC94A', '#C8952F')
      + `<path d="M600 280 L620 430 L600 580" fill="none" stroke="${NIGHT}" stroke-width="26"/>`
      + `<path d="M260 760 L640 400" stroke="#E0E6F2" stroke-width="44" stroke-linecap="round"/><path d="M260 560 L640 470" stroke="#B8C2D6" stroke-width="44" stroke-linecap="round"/>`
      + `<circle cx="300" cy="760" r="78" fill="none" stroke="#FF4D8D" stroke-width="40"/><circle cx="300" cy="560" r="78" fill="none" stroke="#FF4D8D" stroke-width="40"/>`
      + `<circle cx="412" cy="640" r="20" fill="${INK}"/>`
      + `<path d="M690 330 L730 290 M700 520 L748 548 M668 270 L676 220" stroke="#FFF4DC" stroke-width="16" stroke-linecap="round"/>`,
  },
  {
    id: 'pay-packet', for: 'a Four.meme tax launch with rules (holders paid)', accent: '#34C77B', ring: '#7EE8B0',
    desc: 'A pay envelope opening, a coin rising out of it.',
    emblem: `<rect x="262" y="430" width="500" height="330" rx="34" fill="#1E9A63" stroke="${INK}" stroke-width="18"/>`
      + coin(512, 380, 112, '#FFC94A', '#C8952F')
      + `<path d="M262 470 L512 640 L762 470 L762 726 Q762 760 728 760 L296 760 Q262 760 262 726 Z" fill="#34C77B" stroke="${INK}" stroke-width="18" stroke-linejoin="round"/>`
      + `<path d="M262 760 L460 600 M762 760 L564 600" stroke="${INK}" stroke-width="14" opacity="0.6"/>`
      + `<path d="M420 240 L440 200 M604 240 L584 200 M512 220 L512 176" stroke="#FFF4DC" stroke-width="16" stroke-linecap="round"/>`,
  },
  {
    id: 'the-alchemist', for: 'The Alchemist box (fees converted into a tNVDA pile)', accent: '#20C9B4', ring: '#9A6BFF',
    desc: 'A round flask: violet glass, teal liquid, bubbles rising into a coin.',
    emblem: `<rect x="460" y="300" width="104" height="170" rx="16" fill="#2A1F55" stroke="${INK}" stroke-width="16"/>`
      + `<circle cx="512" cy="620" r="220" fill="#2A1F55" stroke="${INK}" stroke-width="20"/>`
      + `<path d="M300 640 A214 214 0 0 0 724 640 Q620 600 512 640 Q404 680 300 640 Z" fill="#20C9B4"/>`
      + `<path d="M318 700 A206 206 0 0 0 706 700 Q610 670 512 700 Q414 730 318 700 Z" fill="#14907F"/>`
      + `<circle cx="452" cy="590" r="20" fill="#9AF5E8"/><circle cx="560" cy="540" r="14" fill="#9AF5E8"/><circle cx="520" cy="470" r="10" fill="#9AF5E8"/>`
      + `<rect x="440" y="282" width="144" height="40" rx="14" fill="#9A6BFF" stroke="${INK}" stroke-width="12"/>`
      + coin(512, 196, 70, '#6CD8FF', '#2A86B8'),
  },
  {
    id: 'pile-furnace', for: 'Pile Furnace box (fees go to the dead address in PILE)', accent: '#FF5A36', ring: '#FF8A2A',
    desc: 'A brick furnace, its mouth glowing, a coin dropping in.',
    emblem: `<path d="M262 800 L262 470 Q262 250 512 250 Q762 250 762 470 L762 800 Z" fill="#5A2A22" stroke="${INK}" stroke-width="20"/>`
      + [330, 410, 490].map(y => `<path d="M${280 + (y - 330) * 0.0} ${y} L${744} ${y}" stroke="${INK}" stroke-width="8" opacity="0.5"/>`).join('')
      + `<path d="M352 800 L352 600 Q352 470 512 470 Q672 470 672 600 L672 800 Z" fill="#FF5A36" stroke="${INK}" stroke-width="16"/>`
      + `<path d="M392 800 L392 630 Q392 530 512 530 Q632 530 632 630 L632 800 Z" fill="#FF8A2A"/>`
      + `<path d="M432 800 L432 670 Q432 600 512 600 Q592 600 592 670 L592 800 Z" fill="#FFC94A"/>`
      + `<path d="M472 800 L472 710 Q472 670 512 670 Q552 670 552 710 L552 800 Z" fill="#FFF4DC"/>`
      + `<rect x="232" y="790" width="560" height="44" rx="16" fill="#3A1A16" stroke="${INK}" stroke-width="14"/>`
      + coin(512, 380, 58, '#FFC94A', '#C8952F'),
  },
  {
    id: 'card-trade', for: 'a Flap launch with a card shop attached (cards given and picked for the token)', accent: '#B48CFF', ring: '#D7C2FF',
    desc: 'A small deck of cards with two arrows turning around it: cards in, cards out.',
    emblem: `<path d="M268 392 A250 250 0 0 1 700 300" fill="none" stroke="#B48CFF" stroke-width="40" stroke-linecap="round"/>`
      + `<path d="M680 250 L760 300 L676 352 Z" fill="#B48CFF" stroke="${INK}" stroke-width="10" stroke-linejoin="round"/>`
      + `<path d="M756 632 A250 250 0 0 1 324 724" fill="none" stroke="#B48CFF" stroke-width="40" stroke-linecap="round"/>`
      + `<path d="M344 774 L264 724 L348 672 Z" fill="#B48CFF" stroke="${INK}" stroke-width="10" stroke-linejoin="round"/>`
      + [[-36, -20, '#5A3FA8'], [-12, -6, '#7A5CD0'], [12, 8, '#F6F1E3']].map(([dx, dy, fill], i) => `<rect x="${412 + dx}" y="${352 + dy}" width="224" height="320" rx="26" fill="${fill}" stroke="${INK}" stroke-width="16"/>`
        + (i === 2 ? `<rect x="${444 + dx}" y="${386 + dy}" width="160" height="252" rx="14" fill="#B48CFF" stroke="${INK}" stroke-width="8"/><path d="M${524 + dx} ${450 + dy} L${572 + dx} ${512 + dy} L${524 + dx} ${574 + dy} L${476 + dx} ${512 + dy} Z" fill="#F6F1E3" stroke="${INK}" stroke-width="8" stroke-linejoin="round"/>` : '')).join(''),
  },
  {
    id: 'quick-deck', for: 'the new card shop box whose gives open after ten minutes (SH-300)', accent: '#A3E635', ring: '#D9F99D',
    desc: 'A card tilted forward with a stopwatch in front of it: a short wait.',
    emblem: `<g transform="rotate(-12 470 470)"><rect x="300" y="236" width="300" height="420" rx="32" fill="#3F6212" stroke="${INK}" stroke-width="18"/>`
      + `<rect x="336" y="274" width="228" height="344" rx="18" fill="#A3E635" stroke="${INK}" stroke-width="10"/>`
      + `<path d="M450 360 L510 446 L450 532 L390 446 Z" fill="#F7FEE7" stroke="${INK}" stroke-width="10" stroke-linejoin="round"/></g>`
      + `<rect x="604" y="452" width="56" height="46" rx="10" fill="#D9F99D" stroke="${INK}" stroke-width="12"/>`
      + `<circle cx="632" cy="650" r="160" fill="#F7FEE7" stroke="${INK}" stroke-width="20"/><circle cx="632" cy="650" r="128" fill="none" stroke="#A3E635" stroke-width="20"/>`
      + `<path d="M632 650 L632 536 A114 114 0 0 1 730 593 Z" fill="#A3E635"/>`
      + `<path d="M632 650 L632 560" stroke="${INK}" stroke-width="18" stroke-linecap="round"/><circle cx="632" cy="650" r="18" fill="${INK}"/>`,
  },
];

const svgOf = p => `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}" role="img"><title>${p.id}</title><desc>${p.desc}</desc>${ground(p.accent, p.ring)}<g transform="translate(512 512) scale(1.14) translate(-512 -512)">${p.emblem}</g></svg>\n`;

/** The contact sheet: each logo at 256 and at 48 on the site's dark ground, with its name. */
function sheetSvg(names) {
  const W = PICTURES.length * 330 + 60; const H = 520;
  const cells = PICTURES.map((p, i) => {
    const x = 40 + i * 330;
    const inner = encodeURIComponent(svgOf(p));
    return `<image x="${x}" y="40" width="256" height="256" href="data:image/svg+xml;charset=utf-8,${inner}"/>`
      + `<image x="${x}" y="320" width="48" height="48" href="data:image/svg+xml;charset=utf-8,${inner}"/>`
      + `<text x="${x + 64}" y="352" font-family="DejaVu Sans" font-size="20" fill="#F5F1FF">48 px</text>`
      + `<text x="${x}" y="410" font-family="DejaVu Sans" font-weight="bold" font-size="24" fill="#F5F1FF">${names[p.id][0]}</text>`
      + `<text x="${x}" y="440" font-family="DejaVu Sans" font-size="18" fill="#B9B0D9">${names[p.id][1]}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${NIGHT}"/>${cells}</svg>`;
}

const NAMES = {
  'honey-jar': ['Sweet Jar (SWEET)', 'Flap, BNB, rules'], 'rainy-day': ['Rainy Day (RAINY)', 'Flap, test dollar, rules'],
  snip: ['Snip (SNIP)', 'Four.meme tax, rules'], 'pay-packet': ['Pay Packet (PACKET)', 'Four.meme tax, rules'],
  'the-alchemist': ['The Alchemist (LEAD)', 'box, converter (spare)'], 'pile-furnace': ['Pile Furnace (FURN)', 'box, eat rule'],
  'card-trade': ['(name: lane e)', 'Flap launch + card shop'], 'quick-deck': ['Quick Deck (QDECK)', 'box, card shop, 10 min'],
};

const Resvg = await loadResvg();
const sizes = {};
for (const p of PICTURES) {
  const svg = svgOf(p);
  writeFileSync(new URL(`${p.id}.svg`, OUT), svg);
  // The largest side from 1024 down (Create takes 256 to 4096; Card Shop's logo is 512) whose PNG fits the free size.
  const side = [1024, 896, 768, 640, 512].find(w => toPng(Resvg, svg, w).byteLength <= FREE_BYTES);
  assert.ok(side, `${p.id}: no side from 1024 to 512 fits the free ${FREE_BYTES} bytes`);
  const png = toPng(Resvg, svg, side);
  writeFileSync(new URL(`${p.id}.png`, OUT), png);
  writeFileSync(new URL(`${p.id}-48.png`, OUT), toPng(Resvg, svg, 48));
  sizes[p.id] = { side, bytes: png.byteLength };
}
const sheet = new Resvg(sheetSvg(NAMES), { font: { loadSystemFonts: true }, fitTo: { mode: 'original' } }).render().asPng();
writeFileSync(new URL('contact-sheet.png', OUT), sheet);
process.stdout.write(`${JSON.stringify(sizes)}\ncontact-sheet.png ${sheet.byteLength} bytes\n`);
