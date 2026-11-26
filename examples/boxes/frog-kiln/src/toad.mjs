/**
 * One clay toad figurine, built from a spec, in a box 1000 units wide and 1000 tall with the toad centred on x 500
 * and its foot on y 900. `toad()` places that box anywhere at any size and keeps the outline the same width in the
 * picture.
 *
 * Construction: a squat body with two eye bumps on top and a haunch on each side; two front legs with three toes
 * each; a glaze that stops above the foot in drips, so a band of raw clay shows at the bottom; dark bead eyes; a wide
 * smile. The toad is an animal figurine: no lips, no eyebrows, no hands, no clothes, nothing a known character wears.
 */
import { C, MIX } from './palette.mjs';
import { circle, ellipsePath, group, path, place, r2, smooth, smoothOpen } from './doc.mjs';
import { clipped, flat, glazed, line, outline, shape, speckles } from './pen.mjs';

/** The body's outline: eye bumps on top, haunches low on the sides, a flat foot. */
const BODY = [
  [500, 905], [300, 905], [205, 892], [150, 830], [140, 745], [182, 668], [222, 585], [246, 495], [268, 410],
  [290, 330], [330, 262], [398, 252], [446, 300], [500, 314], [554, 300], [602, 252], [670, 262], [710, 330],
  [732, 410], [754, 495], [778, 585], [818, 668], [860, 745], [850, 830], [795, 892], [700, 905],
];
const bodyD = smooth(BODY, 0.92);

/** The two eye bumps' centres and the eyes' radius. */
const EYES = [[364, 318], [636, 318]];
const EYE_R = 38;

/** Where the glaze stops: a wavy line above the foot. The raw clay band below it, closed under the foot. */
const RAW_FOOT = `${smoothOpen([[90, 850], [200, 842], [320, 852], [440, 843], [560, 851], [680, 842], [800, 851], [910, 845]], 0.8)}L910 960L90 960Z`;

/** Drips of glaze hanging into the raw band, at the given x positions, each `len` units long. */
function drips(list) {
  return list.map(([x, len]) => smooth([[x - 13, 838], [x + 13, 838], [x + 11, 846 + len * 0.6], [x, 846 + len], [x - 11, 846 + len * 0.6]], 0.9));
}

/** A front leg with three toes, mirrored for the right side: short, thick at the shoulder, elbow out. */
function frontLeg(side) {
  const s = side === 'left' ? 1 : -1;
  const x0 = side === 'left' ? 0 : 1000;
  const p = (x, y) => [x0 + s * x, y];
  const leg = smooth([p(322, 724), p(378, 690), p(430, 732), p(434, 812), p(450, 866), p(400, 896), p(344, 890), p(312, 812)], 0.9);
  const toes = [[352, 892, 24, 17], [394, 900, 25, 18], [436, 890, 24, 17]].map(([x, y, rx, ry]) => {
    const [cx] = p(x, y);
    return ellipsePath(cx, y, rx, ry);
  });
  const crease = smoothOpen([p(350, 748), p(374, 800), p(376, 846)]);
  return { leg, toes, crease };
}

/** A haunch crease: where the thigh folds against the body. */
function haunch(side) {
  const s = side === 'left' ? 1 : -1;
  const x0 = side === 'left' ? 0 : 1000;
  return smoothOpen([[x0 + s * 214, 640], [x0 + s * 262, 718], [x0 + s * 276, 812], [x0 + s * 262, 870]]);
}

/** The eyes in one of their moods: a dark bead in a golden ring, as a toad's eye. Units, unscaled. */
function eyes(spec, ow) {
  const out = [];
  const ink = spec.glaze.ink ?? C.soot;
  const iris = spec.glaze.iris ?? MIX.honeyLight;
  EYES.forEach(([cx, cy], i) => {
    const mood = spec.eyes === 'wink' && i === 1 ? 'closed' : spec.eyes;
    if (mood === 'closed') {
      out.push(line(`M${cx - 32} ${cy + 8}Q${cx} ${cy - 26} ${cx + 32} ${cy + 8}`, ink, ow * 1.15));
      return;
    }
    const r = mood === 'wide' ? EYE_R * 1.12 : EYE_R;
    const dy = mood === 'up' ? -7 : 0;
    out.push(shape(ellipsePath(cx, cy, r + 13), iris, ow * 0.8));
    out.push(circle(cx, cy + dy, r, `fill="${C.soot}"`));
    out.push(circle(cx - r * 0.34, cy + dy - r * 0.36, r * 0.27, `fill="${MIX.glint}"`));
    if (mood === 'wide') out.push(circle(cx + r * 0.32, cy + dy + r * 0.3, r * 0.12, `fill="${MIX.glint}"`));
    if (mood === 'sleepy') {
      // A heavy lid of the body's glaze over the top half of the eye.
      const R = r + 14;
      const lid = `M${cx - R} ${cy + 4}A${R} ${R} 0 0 1 ${cx + R} ${cy + 4}Q${cx} ${cy + 16} ${cx - R} ${cy + 4}Z`;
      out.push(shape(lid, spec.glaze.base, ow * 0.8));
    }
  });
  return out;
}

/** The mouth and nostrils, in the glaze's ink: soot on light glazes, bare clay cut through dark ones. */
function mouth(spec, ow) {
  const ink = spec.glaze.ink ?? C.soot;
  const nostrils = [circle(474, 432, 7, `fill="${ink}"`), circle(526, 432, 7, `fill="${ink}"`)];
  const kind = spec.mouth ?? 'smile';
  if (kind === 'grin') {
    return [...nostrils, line('M292 488Q500 604 708 488', ink, ow * 1.15), line('M282 474L298 498M718 474L702 498', ink, ow)];
  }
  if (kind === 'o') {
    return [...nostrils, line('M318 500Q420 540 470 530', ink, ow), shape(ellipsePath(500, 532, 26, 22), MIX.doorDark, ow * 0.8),
      line('M530 530Q580 540 682 500', ink, ow)];
  }
  return [...nostrils, line('M300 500Q500 572 700 500', ink, ow * 1.15)];
}

/** Patterns in the glaze, clipped to the body. */
function pattern(spec, seed) {
  const g = spec.glaze;
  switch (spec.pattern) {
    case 'speckle':
      return speckles(`${seed}-speckle`, { x: 130, y: 240, w: 740, h: 620 }, 260, 2.5, 6, g.dots);
    case 'dots':
      // Slip trailed in rows of dots across the back.
      return [[400, 3], [468, 5], [540, 6], [612, 6], [684, 5], [752, 4]].map(([y, n], row) => {
        const out = [];
        for (let i = 0; i < n; i += 1) out.push(circle(500 + (i - (n - 1) / 2) * 92 + (row % 2) * 10, y, 13, `fill="${g.dots}"`));
        return out.join('');
      }).join('');
    case 'brush':
      // Cobalt brushwork: fat spots and two strokes over the back, like a painted figurine.
      return [circle(296, 590, 38, `fill="${g.dots}"`), circle(716, 640, 44, `fill="${g.dots}"`), circle(250, 770, 30, `fill="${g.dots}"`),
        circle(770, 790, 30, `fill="${g.dots}"`), circle(452, 392, 16, `fill="${g.dots}"`), circle(574, 398, 20, `fill="${g.dots}"`),
        line('M206 704Q230 650 262 626', g.dots, 22)].join('');
    case 'flash':
      // Shino: the glaze blushes orange where the flame touched it.
      return [flat(smooth([[600, 430], [790, 520], [860, 760], [700, 870], [640, 700], [560, 560]]), g.dots),
        flat(smooth([[170, 700], [250, 660], [300, 760], [220, 860], [150, 820]]), g.dots)].join('');
    case 'runs':
      // Ash glaze runs in long streaks.
      return [180, 270, 360, 640, 730, 820].map((x, i) => line(`M${x} ${300 + (i % 3) * 40}Q${x + 14} ${560} ${x - 6} ${820 + (i % 2) * 30}`, g.dots, 16 + (i % 3) * 6)).join('');
    case 'rings':
      // Carved rings around the back, cut through the glaze to the clay.
      return [560, 640, 720].map((y) => line(`M150 ${y}Q500 ${y + 70} 850 ${y}`, g.dots, 10)).join('');
    default:
      return '';
  }
}

/** Warts: raised dots of a second glaze, mostly on the head and haunches. */
function warts(spec) {
  const pts = [[330, 400, 14], [400, 380, 11], [640, 392, 13], [700, 430, 10], [250, 600, 15], [760, 610, 14], [215, 740, 12],
    [790, 742, 13], [300, 680, 10], [700, 690, 11], [560, 360, 9], [440, 356, 9]];
  return pts.map(([x, y, r], i) => circle(x + ((i * 7) % 5) - 2, y, r, `fill="${spec.glaze.warts}"`)).join('');
}

/** A tiny pinch pot worn as a hat between the eyes: the potter's joke. */
function potHat(ow) {
  const cup = smooth([[436, 306], [452, 236], [500, 220], [548, 236], [564, 306], [500, 318]], 0.9);
  return [shape(cup, C.clay, ow), flat(smooth([[456, 274], [464, 244], [494, 234], [474, 264]]), MIX.clayLight),
    shape(ellipsePath(500, 310, 78, 16), MIX.clayDark, ow)];
}

/** Cracks, for the three cracked toads: mended with gold, held with staples, or still glowing from the kiln. */
function crack(kind, ow) {
  const main = smoothOpen([[520, 300], [500, 380], [548, 452], [508, 540], [560, 620], [528, 700], [566, 780], [548, 846]], 0.6);
  const branch = smoothOpen([[548, 452], [620, 486], [668, 470]], 0.6);
  const branch2 = smoothOpen([[528, 700], [460, 730], [420, 716]], 0.6);
  if (kind === 'gold') {
    return [main, branch, branch2].map((d, i) => line(d, C.soot, (i ? 16 : 22) + ow) + line(d, C.gold, i ? 16 : 22)
      + line(d, MIX.goldLight, i ? 5 : 7)).join('');
  }
  if (kind === 'staples') {
    const cracks = [main, branch].map((d) => line(d, C.soot, ow * 1.2)).join('');
    const staple = (x, y, a) => group(place(x, y, { rotate: a }),
      shape('M-38 -10H38V10H28V0H-28V10H-38Z', C.ash, ow * 0.6), circle(-33, 8, 6, `fill="${MIX.ashDark}"`), circle(33, 8, 6, `fill="${MIX.ashDark}"`));
    return cracks + staple(522, 420, -12) + staple(534, 580, 8) + staple(548, 742, -6);
  }
  // Ember: the crack still glows from the fire inside.
  return [main, branch, branch2].map((d, i) => line(d, C.soot, (i ? 14 : 20) + ow) + line(d, C.flame, i ? 14 : 20)
    + line(d, MIX.fireCore, i ? 4 : 7)).join('')
    + [[600, 440, 6], [470, 690, 5], [580, 610, 4]].map(([x, y, r]) => circle(x, y, r, `fill="${MIX.fireCore}"`)).join('');
}

/**
 * The toad at (x, y), the top left of its 1000-unit box, drawn `size` px wide. `ow` is the outline width in px.
 * `seed` keeps each toad's speckles its own.
 */
export function toad(doc, spec, { x = 0, y = 0, size = 1000, ow = 10, seed = spec.name ?? 'toad' } = {}) {
  const k = size / 1000;
  const o = ow / k;
  const g = spec.glaze;
  const legL = frontLeg('left');
  const legR = frontLeg('right');
  const belly = ellipsePath(500, 748, 190, 150);
  const shine = smoothOpen([[300, 470], [312, 400], [350, 352]]);
  const parts = [
    // Shadow under the foot.
    flat(ellipsePath(500, 912, 380, 34), spec.shadow ?? MIX.wallDeep),
    // The body in its glaze, the belly, the pattern and the raw clay foot band.
    glazed(doc, bodyD, {
      base: g.base, shade: g.shade, ow: 0, sx: 34, sy: 30,
      inner: [
        flat(belly, g.belly),
        pattern(spec, seed),
        spec.warts === false ? '' : warts(spec),
        flat(RAW_FOOT, spec.raw ? g.shade : C.clay),
        ...(spec.raw ? [] : drips(spec.drips ?? [[214, 30], [470, 18], [612, 36], [790, 22]]).map((dd) => flat(dd, g.base))),
        spec.raw ? '' : speckles(`${seed}-foot`, { x: 120, y: 850, w: 760, h: 60 }, 40, 1.5, 3.5, MIX.clayDark),
        line(shine, g.light, 26),
        circle(330, 290, 16, `fill="${g.light}"`),
        circle(602, 286, 14, `fill="${g.light}"`),
      ],
    }),
    outline(bodyD, o),
    line(haunch('left'), C.soot, o * 0.8),
    line(haunch('right'), C.soot, o * 0.8),
    // Front legs over the belly.
    ...[legL, legR].map(({ leg, toes, crease }) => [
      ...toes.map((t) => glazed(doc, t, { base: spec.raw ? g.base : C.clay, shade: spec.raw ? g.shade : MIX.clayDark, ow: o, sx: 4, sy: 5 })),
      glazed(doc, leg, { base: g.base, shade: g.shade, ow: o, sx: 12, sy: 8, inner: [flat(RAW_FOOT, spec.raw ? g.shade : C.clay)] }),
      line(crease, C.soot, o * 0.7),
    ]),
    eyes(spec, o),
    mouth(spec, o),
    spec.hat === 'pot' ? potHat(o) : '',
    spec.crack ? clipped(doc, bodyD, crack(spec.crack, o)) : '',
  ];
  return group(place(x, y, { scale: k }), parts);
}

/** The shape of a toad wrapped in paper, hidden until it is drawn: the same body under a paper skin, with a twist. */
export function wrapped(doc, { x = 0, y = 0, size = 1000, ow = 10, seed = 'wrapped' } = {}) {
  const k = size / 1000;
  const o = ow / k;
  const wrap = smooth([[500, 905], [270, 908], [160, 860], [150, 720], [215, 560], [262, 420], [318, 300], [420, 250], [500, 236],
    [580, 250], [682, 300], [738, 420], [785, 560], [850, 720], [840, 860], [730, 908]], 0.9);
  const folds = [
    smoothOpen([[300, 360], [380, 520], [360, 720]]), smoothOpen([[690, 380], [620, 560], [650, 760]]),
    smoothOpen([[420, 300], [500, 420], [470, 600]]), smoothOpen([[230, 640], [330, 700], [300, 860]]),
    smoothOpen([[760, 620], [700, 720], [742, 860]]),
  ];
  const twist = smooth([[470, 248], [452, 200], [478, 150], [500, 172], [522, 150], [548, 200], [530, 248]], 0.9);
  return group(place(x, y, { scale: k }), [
    flat(ellipsePath(500, 912, 360, 30), MIX.wallDeep),
    glazed(doc, wrap, { base: C.bisque, shade: MIX.bisqueDark, ow: 0, sx: 30, sy: 26,
      inner: [speckles(`${seed}-paper`, { x: 150, y: 230, w: 700, h: 680 }, 70, 2, 4, MIX.wallDeep)] }),
    outline(wrap, o),
    ...folds.map((d) => line(d, MIX.bisqueDark, o * 1.4) + line(d, C.soot, o * 0.55)),
    shape(twist, C.bisque, o),
    line('M486 200L500 236L514 200', C.soot, o * 0.6),
    shape(ellipsePath(500, 520, 64, 64), C.clay, o),
    path('M478 498Q500 478 522 498Q522 520 500 530V548M500 566V568', `fill="none" stroke="${C.bisque}" stroke-width="${r2(o * 1.3)}" stroke-linecap="round" stroke-linejoin="round"`),
  ]);
}
