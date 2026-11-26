/**
 * The twelve vignettes, one per company, engraved in the certificate's ink. Each is drawn around (0, 0) in a box 400
 * by 260, and the certificate clips it to its oval (196 by 124). Objects are paper inside an ink outline, with hatching
 * for shade and ruled lines for skies and floors. Only the blue chips add a color: their chips are blue.
 */
import { C, MIX } from './palette.mjs';
import { box, ellipse, group, place, poly, pt, r2, roundRect, seeded, smooth } from './doc.mjs';
import { crosshatch, hatch, line, ruled, shape, waves } from './engrave.mjs';
import { letter } from './type.mjs';

const ALL = { x: -210, y: -140, w: 420, h: 280 };
const OW = 2.6;

/** An engraved solid: paper inside the ink outline, hatched where `shade` covers it. */
function solid(doc, d, v, { shade = null, angle = 45, gap = 4.6, width = 1.05, cross = false, fillColor = C.paper, ow = OW } = {}) {
  const out = [shape(d, fillColor, 0, fillColor)];
  if (shade) {
    const opts = { angle, gap, width, color: v.ink, within: shade === true ? null : shade };
    out.push(cross ? crosshatch(doc, d, ALL, opts) : hatch(doc, d, ALL, opts));
  }
  out.push(line(d, v.ink, ow));
  return out;
}

/** The sky: ruled lines from the top of the oval down to `to`, closest at the top. */
const sky = (doc, v, to) => ruled(doc, `M-210 -140H210V${r2(to)}H-210Z`, { x: -210, y: -128, w: 420, h: to + 128 }, { gapStart: 3.6, gapEnd: 8.5, width: 0.85, color: v.ink });

/** A floor or table top from `y` down: dense ruled boards with a lit edge. */
function floor(doc, v, y, { joints = [] } = {}) {
  const d = `M-210 ${r2(y)}H210V140H-210Z`;
  return [
    shape(d, C.paper, 0, C.paper),
    ruled(doc, d, { x: -210, y: y + 5, w: 420, h: 140 - y }, { gapStart: 3.2, gapEnd: 5.5, width: 1, color: v.ink }),
    line(`M-210 ${r2(y)}H210`, v.ink, 2.2),
    joints.length ? line(joints.map(([x, y0, y1]) => `M${pt(x, y0)}V${r2(y1)}`).join(''), v.ink, 1.4) : null,
  ];
}

/**
 * A crescent: a centre line from a to b bowed by `bow`, `thick` wide in the middle. `full` below 1 keeps it wide for
 * longer before it tapers, as a banana does.
 */
function crescent(a, b, bow, thick, full = 1) {
  const n = 14;
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const len = Math.hypot(dx, dy);
  const [nx, ny] = [-dy / len, dx / len];
  const left = [];
  const right = [];
  for (let i = 0; i <= n; i += 1) {
    const t = i / n;
    const c = [a[0] + dx * t + nx * bow * 4 * t * (1 - t), a[1] + dy * t + ny * bow * 4 * t * (1 - t)];
    const half = (thick / 2) * Math.sin(Math.PI * Math.min(0.94, Math.max(0.1, t))) ** full;
    left.push([c[0] + nx * half, c[1] + ny * half]);
    right.push([c[0] - nx * half, c[1] - ny * half]);
  }
  return smooth([...left, ...right.reverse()], { tension: 0.9 });
}

/** A short burst of rays around a point: light from a flame or the ring of a bell. */
function rays(cx, cy, r0, r1, angles, v, width = 1.4) {
  return line(angles.map((a) => {
    const t = (a * Math.PI) / 180;
    return `M${pt(cx + r0 * Math.cos(t), cy + r0 * Math.sin(t))}L${pt(cx + r1 * Math.cos(t), cy + r1 * Math.sin(t))}`;
  }).join(''), v.ink, width);
}

/** A candle flame: a teardrop with a core line. */
function flame(cx, base, w, h, v) {
  const d = `M${pt(cx, base)}C${pt(cx - w, base - h * 0.15)} ${pt(cx - w * 0.6, base - h * 0.7)} ${pt(cx, base - h)}C${pt(cx + w * 0.6, base - h * 0.7)} ${pt(cx + w, base - h * 0.15)} ${pt(cx, base)}Z`;
  return [shape(d, C.paper, 2, v.ink), line(`M${pt(cx, base - h * 0.12)}C${pt(cx - w * 0.35, base - h * 0.4)} ${pt(cx + w * 0.2, base - h * 0.6)} ${pt(cx, base - h * 0.8)}`, v.ink, 1.2)];
}

function bags(doc, v) {
  const sack = smooth([[-158, 74], [-170, 32], [-162, -6], [-140, -36], [-120, -52], [-114, -64], [-101, -70], [-90, -64], [-86, -52], [-68, -36], [-48, -4], [-42, 36], [-50, 74]]);
  const suitcase = roundRect(-46, 4, 152, 70, 9);
  const carpet = `M-30 4L-20 -46Q27 -54 74 -46L86 4Z`;
  const doctor = `M110 74L116 30Q142 12 168 30L174 74Z`;
  return [
    sky(doc, v, 74),
    floor(doc, v, 74, { joints: [[-130, 74, 140], [-20, 74, 140], [96, 74, 140]] }),
    solid(doc, sack, v, { shade: `M-100 -80H40V90H-100Z`, angle: 62 }),
    line('M-120 -56Q-102 -48 -84 -56M-118 -50Q-102 -42 -86 -50', v.ink, 2),
    line('M-96 -52C-90 -40 -78 -36 -70 -44M-98 -50C-104 -38 -112 -32 -120 -36', v.ink, 1.6),
    shape(roundRect(-148, 4, 44, 34, 3), C.paper, 1.8, v.ink),
    line('M-143 9H-109V33H-143Z', v.ink, 1, 'stroke-dasharray="3 3"'),
    solid(doc, suitcase, v, { shade: 'M-60 48H120V90H-60Z', angle: 0, gap: 4 }),
    line('M-46 22H106', v.ink, 1.6),
    line('M12 4C12 -14 44 -14 44 4', v.ink, 5),
    line('M12 4C12 -14 44 -14 44 4', C.paper, 1.6),
    shape(box(-4, 4, 12, 70), C.paper, 1.8, v.ink),
    shape(box(62, 4, 12, 70), C.paper, 1.8, v.ink),
    shape(box(-6, 30, 16, 12), C.paper, 1.6, v.ink),
    shape(box(60, 30, 16, 12), C.paper, 1.6, v.ink),
    line('M-46 62Q-46 74 -34 74M106 62Q106 74 94 74M-46 16Q-46 4 -34 4M106 16Q106 4 94 4', v.ink, 3),
    solid(doc, carpet, v, { shade: true, angle: 45, gap: 9, width: 0.9, cross: true }),
    line('M-21 -46H75', v.ink, 4),
    line('M-6 -48C-6 -78 22 -78 22 -48M32 -48C32 -78 60 -78 60 -48', v.ink, 3),
    shape(ellipse(28, -34, 5), C.paper, 1.6, v.ink),
    solid(doc, doctor, v, { shade: 'M146 0H190V90H146Z', angle: 70 }),
    line('M128 22C128 4 156 4 156 22', v.ink, 3),
    line('M116 44H170', v.ink, 1.4),
  ];
}

function exitDoor(doc, v) {
  const wall = 'M-210 -140H210V34H-210Z';
  const arch = 'M-58 34V-30A58 58 0 0 1 58 -30V34Z';
  const leaf = 'M58 34V-34L118 -22V50Z';
  const water = 'M-58 34H58C82 60 140 86 210 96V140H-210V96C-140 86 -82 60 -58 34Z';
  const rows = [];
  for (let y = -132, r = 0; y < 34; y += 24, r += 1) {
    rows.push(`M-210 ${y}H210`);
    for (let x = -210 + (r % 2) * 30; x < 210; x += 60) rows.push(`M${x} ${y}V${Math.min(34, y + 24)}`);
  }
  const shine = [];
  for (let i = 0; i < 7; i += 1) shine.push(`M${pt(-50 + i * 16, 40 + i * 2)}C${pt(-60 + i * 22, 70)} ${pt(-90 + i * 34, 96)} ${pt(-120 + i * 46, 128)}`);
  return [
    shape(wall, C.paper, 0, C.paper),
    hatch(doc, wall, ALL, { angle: 0, gap: 6, width: 0.8, color: v.ink }),
    line(rows.join(''), v.ink, 1.6),
    solid(doc, 'M-74 34V-32A74 74 0 0 1 74 -32V34H58V-30A58 58 0 0 0 -58 -30V34Z', v, { shade: true, angle: 0, gap: 3.4 }),
    solid(doc, arch, v, { shade: true, angle: 45, gap: 3.6, cross: true }),
    solid(doc, 'M-58 34H58V10C30 4 -30 4 -58 10Z', v, { shade: true, angle: 0, gap: 5 }),
    solid(doc, leaf, v, { shade: 'M58 -40L118 -28V60H58Z', angle: 80, gap: 5 }),
    line('M78 -30V42M98 -26V46', v.ink, 1.4),
    shape(box(60, -24, 10, 6), C.paper, 1.4, v.ink),
    shape(box(60, 22, 10, 6), C.paper, 1.4, v.ink),
    solid(doc, water, v, { shade: false }),
    waves(doc, water, { x: -210, y: 40, w: 420, h: 100 }, { gap: 9, length: 38, amp: 2.4, width: 1.2, color: v.ink, seed: 'exit' }),
    line(shine.join(''), v.ink, 1.6),
    line('M-58 34C-46 22 -30 30 -24 22C-14 32 0 22 8 30C18 22 30 32 40 24C48 32 54 28 58 34', v.ink, 2),
    shape(roundRect(-46, -116, 92, 30, 4), C.paper, 2.2, v.ink),
    letter('EXIT', { x: 0, y: -108, cap: 15, color: v.ink, weight: 'text', track: 2.4 }),
  ];
}

function candles(doc, v) {
  const body = (x0, x1, top) => `M${x0} 80V${top + 6}Q${(x0 + x1) / 2} ${top - 4} ${x1} ${top + 6}V80Z`;
  const dish = (cx, w) => [solid(doc, ellipse(cx, 84, w, 9), v, { shade: true, angle: 0, gap: 3.5 })];
  return [
    sky(doc, v, 84),
    floor(doc, v, 88),
    dish(-110, 36), dish(0, 40), dish(108, 34),
    solid(doc, body(-128, -92, -6), v, { shade: 'M-104 -40H-80V100H-104Z', angle: 90, gap: 4 }),
    line('M-128 8Q-124 22 -120 10M-98 4Q-96 20 -94 8', v.ink, 1.8),
    line('M-110 -6C-112 -40 -150 -52 -146 -82C-142 -104 -120 -100 -122 -84', v.ink, 1.6),
    flame(-122, -84, 6, 18, v),
    solid(doc, body(-20, 20, -66), v, { shade: 'M6 -80H30V100H6Z', angle: 90, gap: 4 }),
    line('M-20 -50Q-16 -34 -12 -48M14 -54Q16 -40 18 -52', v.ink, 1.8),
    line('M0 -66C2 -82 -14 -92 -10 -104C-6 -114 6 -112 8 -102C10 -92 -4 -88 0 -118', v.ink, 1.6),
    flame(0, -118, 5, 14, v),
    solid(doc, body(92, 124, 34), v, { shade: 'M114 0H140V100H114Z', angle: 90, gap: 4 }),
    line('M108 34V24', v.ink, 1.6),
    flame(108, 24, 13, 40, v),
    rays(108, -2, 30, 44, [-150, -120, -90, -60, -30, 0], v),
    rays(-122, -94, 16, 26, [-160, -120, -60, -20], v, 1.2),
  ];
}

function windmill(doc, v) {
  const hill = 'M-210 140V70C-120 44 -60 36 0 36C60 36 120 42 210 66V140Z';
  const tower = 'M-44 44L-30 -40H30L44 44Z';
  const blade = (deg) => {
    const g = [
      shape('M10 -11H116V11H10Z', C.paper, 2, v.ink),
      line('M10 0H116M28 -11V11M46 -11V11M64 -11V11M82 -11V11M100 -11V11', v.ink, 1.2),
    ];
    return group(place(0, -54, { rotate: deg }), g);
  };
  return [
    sky(doc, v, 60),
    line('M-130 -84L-122 -78L-114 -84M-104 -96L-96 -90L-88 -96M118 -72L126 -66L134 -72', v.ink, 1.6),
    solid(doc, hill, v, { shade: true, angle: 8, gap: 5, width: 0.9 }),
    solid(doc, tower, v, { shade: 'M8 -60H60V60H8Z', angle: 90, gap: 4 }),
    solid(doc, 'M-36 -40Q0 -80 36 -40Z', v, { shade: 'M6 -90H50V-30H6Z', angle: 90, gap: 3.6 }),
    solid(doc, 'M-12 44V24A12 12 0 0 1 12 24V44Z', v, { shade: true, angle: 45, gap: 3, cross: true }),
    shape(box(-7, -18, 14, 14), C.paper, 1.6, v.ink),
    line('M0 -18V-4M-7 -11H7', v.ink, 1),
    blade(-68), blade(22), blade(112), blade(202),
    shape(ellipse(0, -54, 8), C.paper, 2, v.ink),
    solid(doc, smooth([[52, 46], [50, 26], [58, 16], [66, 14], [74, 18], [80, 28], [78, 46]]), v, { shade: 'M66 0H100V60H66Z', angle: 60 }),
    solid(doc, smooth([[80, 46], [82, 32], [90, 24], [98, 26], [104, 34], [102, 46]]), v, { shade: 'M94 0H120V60H94Z', angle: 60 }),
  ];
}

function press(doc, v) {
  return [
    sky(doc, v, 82),
    floor(doc, v, 82),
    solid(doc, roundRect(-104, -94, 20, 176, 2), v, { shade: 'M-92 -100H-80V90H-92Z', angle: 90, gap: 3.6 }),
    solid(doc, roundRect(52, -94, 20, 176, 2), v, { shade: 'M64 -100H76V90H64Z', angle: 90, gap: 3.6 }),
    solid(doc, roundRect(-116, -110, 200, 22, 3), v, { shade: 'M-120 -96H90V-80H-120Z', angle: 0, gap: 3.6 }),
    solid(doc, box(-30, -88, 24, 50), v, { shade: false }),
    line('M-30 -82L-6 -76M-30 -72L-6 -66M-30 -62L-6 -56M-30 -52L-6 -46', v.ink, 1.4),
    line('M-18 -66L112 -84', v.ink, 6),
    line('M-18 -66L112 -84', C.paper, 2),
    shape(ellipse(116, -85, 10), C.paper, 2.2, v.ink),
    solid(doc, roundRect(-74, -38, 112, 18, 2), v, { shade: 'M-80 -28H50V-14H-80Z', angle: 0, gap: 3 }),
    solid(doc, roundRect(-130, 20, 228, 16, 2), v, { shade: 'M-140 28H110V40H-140Z', angle: 0, gap: 3 }),
    shape('M-66 20L-60 8H24L30 20Z', C.paper, 1.8, v.ink),
    line('M-56 13H-30M-24 13H16', v.ink, 1.2),
    solid(doc, 'M100 82V50L190 50V82Z', v, { shade: 'M100 66H200V90H100Z', angle: 0, gap: 3 }),
    line('M100 58H190M100 66H190M100 74H190', v.ink, 1),
    shape('M108 50L120 26H194L182 50Z', C.paper, 2, v.ink),
    line('M126 32H148M152 32H176M122 38H144M150 38H174M118 44H140M146 44H170', v.ink, 1.2),
  ];
}

function crab(doc, v) {
  const sea = 'M-210 0H210V74H-210Z';
  const sand = 'M-210 74H210V140H-210Z';
  const body = 'M-6 62C-10 40 14 26 44 26C74 26 98 40 94 62C90 76 66 84 44 84C22 84 -2 76 -6 62Z';
  const claw = (x, y, flip) => {
    const s = flip ? -1 : 1;
    return [
      solid(doc, `M${pt(x, y)}C${pt(x - 22 * s, y - 6)} ${pt(x - 34 * s, y - 26)} ${pt(x - 26 * s, y - 40)}C${pt(x - 12 * s, y - 34)} ${pt(x - 8 * s, y - 18)} ${pt(x, y)}Z`, v, { shade: true, angle: 30, gap: 4 }),
      solid(doc, `M${pt(x - 26 * s, y - 40)}C${pt(x - 40 * s, y - 52)} ${pt(x - 20 * s, y - 70)} ${pt(x - 4 * s, y - 60)}C${pt(x - 14 * s, y - 56)} ${pt(x - 20 * s, y - 50)} ${pt(x - 14 * s, y - 44)}Z`, v, { shade: true, angle: -30, gap: 4 }),
      solid(doc, `M${pt(x - 18 * s, y - 42)}C${pt(x - 4 * s, y - 48)} ${pt(x + 4 * s, y - 38)} ${pt(x - 2 * s, y - 30)}C${pt(x - 8 * s, y - 36)} ${pt(x - 14 * s, y - 36)} ${pt(x - 18 * s, y - 42)}Z`, v, { shade: false }),
    ];
  };
  const legs = [];
  for (let i = 0; i < 4; i += 1) {
    legs.push(`M${pt(4 + i * 4, 60 + i * 5)}L${pt(-26 - i * 6, 66 + i * 8)}L${pt(-36 - i * 8, 86 + i * 6)}`);
    legs.push(`M${pt(84 - i * 4, 60 + i * 5)}L${pt(114 + i * 6, 66 + i * 8)}L${pt(124 + i * 8, 86 + i * 6)}`);
  }
  return [
    sky(doc, v, 0),
    shape(sea, C.paper, 0, C.paper),
    waves(doc, sea, { x: -210, y: 2, w: 420, h: 72 }, { gap: 8, length: 30, amp: 1.8, width: 1, color: v.ink, seed: 'crab-sea' }),
    line('M-210 0H210', v.ink, 1.8),
    solid(doc, 'M-176 -6H-84L-94 8H-166Z', v, { shade: true, angle: 0, gap: 3 }),
    line('M-146 -6V-74M-116 -6V-62', v.ink, 2),
    shape('M-146 -70Q-128 -46 -146 -16H-176Q-160 -44 -146 -70Z', C.paper, 1.8, v.ink),
    shape('M-142 -66Q-118 -42 -142 -14H-122Q-110 -40 -142 -66Z', C.paper, 1.8, v.ink),
    shape('M-116 -58Q-100 -36 -116 -14H-96Q-88 -36 -116 -58Z', C.paper, 1.8, v.ink),
    shape('M-146 -74L-130 -70L-146 -66Z', C.paper, 1.4, v.ink),
    shape(sand, C.paper, 0, C.paper),
    hatch(doc, sand, ALL, { angle: 0, gap: 7, width: 0.8, color: v.ink }),
    line('M-210 74H210', v.ink, 2),
    group(place(-12, -24, { scale: 1.26 }), [
      line(legs.join(''), v.ink, 3.4),
      line(legs.join(''), C.paper, 1),
      claw(-2, 52, false),
      claw(90, 52, true),
      solid(doc, body, v, { shade: 'M-20 58H110V90H-20Z', angle: 0, gap: 3.4 }),
      line('M18 44Q44 36 70 44M10 56Q44 46 78 56', v.ink, 1.4),
      line('M30 30L24 6M58 30L64 6', v.ink, 3),
      shape(ellipse(24, 4, 6), C.paper, 2, v.ink),
      shape(ellipse(64, 4, 6), C.paper, 2, v.ink),
      shape(ellipse(25, 4, 2.2), v.ink, 1, v.ink),
      shape(ellipse(65, 4, 2.2), v.ink, 1, v.ink),
    ]),
    line('M-128 92H-98M-136 102H-102M-124 112H-98', v.ink, 2),
  ];
}

function bananas(doc, v) {
  const crate = 'M-184 76V12H-36V76Z';
  const fruit = [
    crescent([-156, -10], [-36, -44], 16, 28, 0.5),
    crescent([-158, -6], [-30, -22], 14, 28, 0.5),
    crescent([-160, -2], [-44, 4], 12, 28, 0.5),
  ];
  const strips = [
    crescent([66, 66], [6, 74], 9, 24, 0.55),
    crescent([92, 66], [154, 72], -9, 24, 0.55),
    crescent([82, 58], [114, 16], 12, 20, 0.55),
  ];
  return [
    sky(doc, v, 76),
    floor(doc, v, 76),
    solid(doc, crate, v, { shade: 'M-60 -10H-30V90H-60Z', angle: 90, gap: 4 }),
    line('M-184 34H-36M-184 56H-36M-176 12V76M-46 12V76', v.ink, 1.6),
    ...fruit.map((d) => solid(doc, d, v, { shade: 'M-200 -14H0V20H-200Z', angle: 15, gap: 3.6 })),
    line('M-128 -18C-100 -26 -70 -34 -48 -40M-128 -10C-100 -12 -70 -16 -42 -20', v.ink, 1.2),
    line('M-38 -44L-33 -46M-32 -22L-27 -23M-46 4L-41 5', v.ink, 4),
    solid(doc, smooth([[-170, 6], [-176, -6], [-170, -18], [-160, -20], [-152, -10], [-156, 4]]), v, { shade: true, angle: 0, gap: 3 }),
    line('M-170 -16L-180 -30', v.ink, 5),
    ...strips.map((d, i) => solid(doc, d, v, { shade: i === 2 ? true : 'M0 66H170V90H0Z', angle: 30, gap: 4 })),
    solid(doc, 'M64 70C64 56 72 50 80 50C90 50 96 56 96 70Z', v, { shade: 'M82 40H100V74H82Z', angle: 80, gap: 3 }),
    line('M76 52L66 34', v.ink, 4.4),
    line('M150 94C166 90 180 82 198 66M156 106C172 102 186 94 204 80', v.ink, 2),
  ];
}

function fondue(doc, v) {
  const pot = 'M-84 -14C-84 32 -52 42 0 42C52 42 84 32 84 -14Z';
  const cube = (x, y) => [
    shape(`M${pt(x - 10, y - 4)}L${pt(x + 2, y - 12)}L${pt(x + 14, y - 4)}L${pt(x + 2, y + 4)}Z`, C.paper, 1.6, v.ink),
    solid(doc, `M${pt(x - 10, y - 4)}L${pt(x + 2, y + 4)}V${r2(y + 18)}L${pt(x - 10, y + 10)}Z`, v, { shade: true, angle: 90, gap: 3, ow: 1.6 }),
    solid(doc, `M${pt(x + 2, y + 4)}L${pt(x + 14, y - 4)}V${r2(y + 10)}L${pt(x + 2, y + 18)}Z`, v, { shade: true, angle: 0, gap: 2.6, ow: 1.6 }),
  ];
  return [
    sky(doc, v, 86),
    floor(doc, v, 86),
    line('M-56 86L-30 40M56 86L30 40M0 94V44', v.ink, 3),
    solid(doc, ellipse(0, 40, 36, 6), v, { shade: false }),
    solid(doc, 'M-24 58H24L18 72H-18Z', v, { shade: true, angle: 0, gap: 3 }),
    shape('M0 58C-8 52 -6 44 0 36C6 44 8 52 0 58Z', C.paper, 1.6, v.ink),
    solid(doc, 'M-82 -8L-176 -30L-178 -20L-84 4Z', v, { shade: 'M-180 -10H-80V10H-180Z', angle: 0, gap: 3 }),
    shape(ellipse(-182, -25, 8, 7), C.paper, 2, v.ink),
    solid(doc, pot, v, { shade: 'M20 -20H100V50H20Z', angle: 70, gap: 4 }),
    solid(doc, ellipse(0, -14, 86, 14), v, { shade: false }),
    solid(doc, ellipse(0, -12, 74, 9), v, { shade: true, angle: 0, gap: 3.4 }),
    line('M-64 -14Q-40 -20 -16 -12Q8 -6 32 -14Q50 -20 66 -12', v.ink, 1.4),
    line('M-170 -116L-36 -22M170 -116L36 -22', v.ink, 4.4),
    line('M-170 -116L-36 -22M170 -116L36 -22', C.paper, 1.4),
    line('M-44 -30L-30 -14M-36 -34L-22 -18M44 -30L30 -14M36 -34L22 -18', v.ink, 1.8),
    cube(-36, -42), cube(26, -42),
    line('M-12 -66C-20 -78 -4 -86 -12 -100M10 -66C2 -80 18 -88 10 -104', v.ink, 1.4),
  ];
}

function telephone(doc, v) {
  return [
    sky(doc, v, 80),
    floor(doc, v, 80),
    solid(doc, 'M-54 80C-54 62 -32 54 -14 52H14C32 54 54 62 54 80Z', v, { shade: 'M12 40H70V90H12Z', angle: 70, gap: 4 }),
    solid(doc, 'M-7 52L-5 -62H5L7 52Z', v, { shade: 'M1 -70H20V60H1Z', angle: 90, gap: 3 }),
    solid(doc, box(-7, -76, 14, 16), v, { shade: false }),
    solid(doc, ellipse(0, -96, 26), v, { shade: 'M0 -130H40V-60H0Z', angle: 60, gap: 3.4 }),
    line(`${ellipse(0, -96, 17)}${ellipse(0, -96, 9)}`, v.ink, 1.6),
    shape(ellipse(0, -96, 4), v.ink, 1, v.ink),
    line('M-6 -42L-34 -48M-34 -48L-40 -58M-34 -48L-28 -58', v.ink, 3.4),
    solid(doc, roundRect(-46, -54, 14, 62, 5), v, { shade: 'M-39 -60H-30V20H-39Z', angle: 90, gap: 3 }),
    solid(doc, 'M-46 6H-32L-26 22H-52Z', v, { shade: true, angle: 0, gap: 3 }),
    line('M-39 22C-40 46 -80 40 -80 60C-80 76 -60 82 -46 74', v.ink, 2.2),
    line('M38 -118Q52 -96 38 -74M52 -126Q72 -96 52 -66M-38 -118Q-52 -96 -38 -74M-52 -126Q-72 -96 -52 -66', v.ink, 2),
  ];
}

/** The blue chips' chips: blue with an ink outline, a light edge and a dark side. */
function chip(d, light) {
  return [shape(d, C.chip, 1.8, C.ink), light ? `<path d="${light}" fill="none" stroke="${MIX.chipLight}" stroke-width="2.4" stroke-linecap="round"/>` : null];
}

function chipShop(doc, v) {
  const cone = 'M-80 -22Q0 -6 80 -22L10 70H-10Z';
  const fries = [];
  const rand = seeded('fries');
  for (let i = 0; i < 11; i += 1) {
    const x = -62 + i * 12.5;
    const tilt = -26 + i * 5 + (rand() - 0.5) * 6;
    const h = 62 + rand() * 30;
    fries.push(group(place(x, -6, { rotate: tilt }), chip(`M-6 0V${r2(-h)}H6V0Z`, `M-2.5 -4V${r2(-h + 5)}`)));
  }
  const print = [];
  for (let y = -10; y < 66; y += 7) print.push(`M-70 ${y}H70`);
  return [
    sky(doc, v, 80),
    floor(doc, v, 80),
    ...fries,
    solid(doc, cone, v, { shade: false }),
    group(doc.clip(cone), line(print.join(''), v.ink, 1, 'stroke-dasharray="7 3 12 4"')),
    line('M-60 -16L4 64', v.ink, 1.6),
    line(cone, v.ink, OW),
    solid(doc, 'M-20 70H20L26 82H-26Z', v, { shade: true, angle: 0, gap: 3 }),
    solid(doc, 'M118 80V28C118 18 150 18 150 28V80Z', v, { shade: 'M136 10H160V90H136Z', angle: 90, gap: 3.6 }),
    solid(doc, 'M120 28C120 8 148 8 148 28Z', v, { shade: false }),
    line('M128 18H129M134 14H135M140 18H141', v.ink, 2.4),
    line('M30 -60L54 -100', C.ink, 4.6),
    line('M30 -60L54 -100', C.wood, 2.4),
    line('M50 -104L56 -116M56 -100L64 -110', C.ink, 2),
  ];
}

function woodChips(doc, v) {
  const stump = 'M-92 76L-84 10C-62 24 42 24 64 10L72 76Z';
  const top = ellipse(-10, 10, 74, 16);
  const rand = seeded('wood-chips');
  const chips = [];
  for (const [x, y, s, a] of [[-150, 66, 1, 10], [-128, 74, 0.9, -20], [-170, 50, 0.8, 40], [96, 70, 1, -10], [120, 62, 0.9, 30], [148, 74, 0.8, -30],
    [-120, -40, 0.8, 60], [-150, -72, 0.7, -30], [-96, -84, 0.6, 20], [118, -30, 0.8, -50], [140, -64, 0.7, 25], [-60, -56, 0.6, -15], [168, 24, 0.7, 70]]) {
    const pts = [[-14, -6], [10 + rand() * 4, -9], [15, 5], [-8, 8 + rand() * 3]];
    chips.push(group(place(x, y, { rotate: a, scale: s }), chip(poly(pts), 'M-9 -3L8 -6')));
  }
  return [
    sky(doc, v, 76),
    floor(doc, v, 76),
    line('M-140 -56Q-126 -66 -110 -58M120 -48Q134 -58 146 -46M-100 -72Q-86 -84 -70 -76', v.ink, 1.4),
    solid(doc, stump, v, { shade: 'M30 0H90V90H30Z', angle: 90, gap: 3.4 }),
    line('M-70 30C-72 46 -66 60 -70 74M-44 26C-46 44 -40 58 -44 74M-14 28C-16 46 -10 60 -14 74M18 26C16 44 22 58 18 74M48 22C46 40 52 56 48 74', v.ink, 1.3),
    solid(doc, top, v, { shade: false }),
    line(`${ellipse(-10, 10, 52, 11)}${ellipse(-10, 10, 32, 7)}${ellipse(-10, 10, 14, 3)}`, v.ink, 1.2),
    line('M2 4L104 -100', C.ink, 9),
    line('M2 4L104 -100', C.wood, 5),
    solid(doc, 'M-26 -10L10 -34L28 -12L12 14L-12 18Z', v, { shade: 'M0 -40H40V20H0Z', angle: 45, gap: 3 }),
    line('M-26 -10L-12 18', v.ink, 3.4),
    ...chips,
  ];
}

function paintChips(doc, v) {
  const card = (deg) => group(place(0, 76, { rotate: deg }), [
    shape(roundRect(-28, -156, 56, 160, 6), C.paper, 2.2, C.ink),
    shape(box(-20, -146, 40, 36), MIX.chipLight, 1.4, C.ink),
    shape(box(-20, -104, 40, 36), C.chip, 1.4, C.ink),
    shape(box(-20, -62, 40, 36), MIX.chipDark, 1.4, C.ink),
    line('M-20 -18H8M-20 -10H0', v.ink, 1.2),
  ]);
  return [
    sky(doc, v, 84),
    floor(doc, v, 84),
    solid(doc, 'M-178 84V30H-112V84Z', v, { shade: 'M-136 20H-100V90H-136Z', angle: 90, gap: 3.6 }),
    solid(doc, ellipse(-145, 30, 33, 8), v, { shade: false }),
    shape('M-170 30Q-172 52 -164 56Q-158 50 -160 30Z', C.chip, 1.6, C.ink),
    card(-44), card(-22), card(0), card(22), card(44),
    shape(ellipse(0, 76, 7), C.paper, 2, C.ink),
    line('M118 -70L178 54', C.ink, 9),
    line('M118 -70L178 54', C.wood, 5),
    solid(doc, 'M108 -92L124 -100L136 -74L120 -66Z', v, { shade: true, angle: 0, gap: 3 }),
    shape('M108 -92C98 -110 106 -124 112 -128C118 -122 126 -110 124 -100Z', C.chip, 1.8, C.ink),
  ];
}

/** The vignettes in variant order, by the name items.mjs uses for each. */
export const VIGNETTES = Object.freeze({ bags, exitDoor, candles, windmill, press, crab, bananas, fondue, telephone, chipShop, woodChips, paintChips });
