import { C, MIX } from '../src/palette.mjs';
import { shadeOf } from '../src/bags.mjs';
import { validateTraits } from './deal.mjs';
import { details, ellipse, rounded, rectangle } from './lib/details.mjs';
import { Mesh } from './lib/mesh.mjs';
import { exportGlb } from './lib/export.mjs';
import { addPrint } from './lib/prints.mjs';

/** Authored depth interpretations of the twelve original silhouettes, in their 1024 px coordinates. */
export function modelGlb(traits) {
  validateTraits(traits);
  const m = new Mesh(), accent = C[traits.trim];
  let front, layer = 0;
  const body = (points, color, depth) => { front = m.body(points, color, depth); };
  const panel = (points, color, outline = 8) => m.panel(points, color, front + 2 + (++layer) * 0.2, outline);
  const line = (points, color, width = 7) => m.line(points, width, color, front + 4 + (++layer) * 0.2);
  const strap = (ends, color = C.ink, width = 24) => {
    m.band([ends[0], [512, 279], ends[1]], width, color, 85);
  };
  switch (traits.kind) {
    case '01':
      body(rounded(262, 450, 500, 450, 18), C.canvas, 150);
      panel(rectangle(267, 455, 490, 36), MIX.canvasShade, 0);
      panel(rounded(387, 702, 250, 149, 13), accent);
      line([[400, 728], [400, 836], [624, 836], [624, 728]], shadeOf(C.canvas), 5);
      strap([[387, 485], [637, 485]], C.canvas, 33);
      break;
    case '02':
      body(rectangle(252, 420, 520, 500), C.kraft, 185);
      panel(rectangle(679, 426, 88, 489), MIX.kraftDark, 0);
      panel(rectangle(256, 424, 420, 50), MIX.kraftDark, 0);
      line([[679, 420], [679, 919]], C.ink, 9);
      line([[280, 850], [648, 850]], MIX.kraftDark, 5);
      panel(rounded(320.22, 610, 289.96, 150, 15.6), MIX.kraftLight, 0);
      strap([[380, 450], [550, 450]], C.kraft, 21);
      break;
    case '03':
      body(rounded(342, 511, 340, 389, 20), C.canvas, 32);
      panel([[354, 511], [512, 470], [670, 511]], MIX.canvasShade);
      panel(rounded(376, 565, 272, 300, 17), MIX.canvasShade, 0);
      for (const [x, y] of [[425, 610], [520, 595], [600, 630], [455, 685], [560, 700], [418, 760], [510, 775], [600, 758], [470, 838], [565, 840]]) panel(rounded(x - 11, y - 4, 22, 8, 3), C.kraft, 0);
      m.band([[512, 482], [512, 279], [386, 332]], 6, C.canvas, 48, 4);
      m.panel(rounded(301, 332, 170, 122, 13), C.aqua, 55);
      m.panel(ellipse(386, 354, 6, 6, 8), C.ink, 57, 0);
      break;
    case '04':
      body([[432, 467], [370, 499], [290, 580], [245, 690], [250, 790], [295, 865], [400, 905], [512, 910], [624, 905], [729, 865], [774, 790], [779, 690], [734, 580], [654, 499], [592, 467]], MIX.kraftLight, 240);
      panel([[432, 466], [417, 420], [455, 397], [483, 451], [501, 418], [532, 458], [552, 402], [582, 439], [602, 412], [592, 467]], MIX.kraftLight);
      for (let x = 360; x <= 670; x += 62) line([[x, 545], [x, 865]], C.kraft, 3);
      for (let y = 565; y <= 845; y += 56) line([[300, y], [724, y]], C.kraft, 3);
      panel(rounded(420, 458, 184, 31, 14), C.canvas);
      strap([[456, 463], [568, 463]], C.canvas, 19);
      break;
    case '05':
      body([[512, 382], [580, 395], [635, 451], [690, 550], [755, 662], [800, 756], [801, 826], [770, 876], [704, 901], [612, 910], [412, 910], [320, 901], [254, 876], [223, 826], [223, 756], [269, 662], [334, 550], [389, 451], [444, 395]], C.gold, 290);
      line([[512, 395], [492, 550], [488, 730], [500, 900]], MIX.goldDark, 7);
      line([[280, 650], [370, 710], [512, 733], [655, 710], [750, 650]], MIX.goldDark, 7);
      panel(ellipse(500, 555, 110, 30), MIX.goldDark, 0);
      strap([[467, 392], [557, 392]], C.ink, 32);
      break;
    case '06':
      body(rounded(332, 479, 360, 441, 62), C.ink, 240);
      panel(rounded(325, 472, 374, 44, 20), MIX.plumDeep);
      panel(rounded(368, 540, 32, 347, 16), MIX.plumDeep, 0);
      panel(rectangle(337, 673, 350, 75), accent);
      for (const x of [368, 465, 559, 656]) {
        m.line([[512, 318], [x, 485]], 14, C.ink, 94, 12);
        for (let i = 0; i < 5; i++) {
          const f = (i + 0.5) / 5;
          m.panel(rectangle(512 + (x - 512) * f - 5, 318 + 167 * f - 8, 10, 17), C.steel, 96, 0);
        }
      }
      m.line([...ellipse(512, 303, 27, 27), [539, 303]], 14, C.steel, 98, 12);
      break;
    case '07': {
      body(rounded(182, 589, 660, 291, 144), C.leaf, 240);
      panel(ellipse(696, 734, 145, 145), MIX.leafDark);
      panel(ellipse(722, 734, 105, 122), C.canvas);
      for (const r of [78, 55, 32]) {
        const arc = Array.from({ length: 13 }, (_, i) => [722 + r * Math.cos(Math.PI + i * Math.PI / 12), 734 + r * 1.2 * Math.sin(Math.PI + i * Math.PI / 12)]);
        line(arc, C.leaf, 7);
      }
      for (const x of [360, 591]) { panel(rounded(x - 23, 587, 46, 295, 7), accent); panel(rounded(x - 30, 708, 60, 53, 8), C.steel, 6); }
      strap([[360, 600], [591, 600]], accent, 30);
      break;
    }
    case '08':
      body(rounded(277, 450, 470, 450, 10), C.canvas, 150);
      m.panel([[305, 445], [338, 396], [404, 440], [462, 360], [520, 425], [584, 369], [636, 438], [702, 391], [720, 445]], C.gold, 40, 9, 12);
      for (let row = 0; row < 5; row++) for (let col = 0; col < 4; col++) {
        const x = 352 + col * 108 + (row % 2) * 54;
        if (x < 704) panel(ellipse(x, 549 + row * 76, 21, 21, 12), accent, 0);
      }
      strap([[418, 481], [606, 481]], accent, 16);
      break;
    case '09':
      body(rounded(167, 568, 690, 312, 131), C.tomato, 240);
      for (const x of [405, 571]) panel(rectangle(x, 573, 48, 302), C.canvas, 0);
      for (const x of [276, 748]) panel(ellipse(x, 724, 84, 119), MIX.tomatoDark, 8);
      line([[308, 630], [718, 630]], C.ink, 14);
      for (let x = 314; x < 710; x += 20) line([[x, 630], [x + 10, 630]], C.steel, 6);
      panel(rounded(663, 620, 34, 50, 8), C.steel, 6);
      strap([[374, 605], [650, 605]], C.ink, 34);
      break;
    case '10':
      body(rounded(272, 359, 480, 561, 110), C.aqua, 230);
      // Shoulder straps behind the body are solid loops, not painted on the front.
      for (const sign of [-1, 1]) m.band([[512 + sign * 160, 420], [512 + sign * 280, 540], [512 + sign * 280, 760], [512 + sign * 210, 850]], 30, MIX.aquaDark, -95, 8);
      panel(rounded(349, 631, 326, 258, 44), accent);
      line([[369, 668], [410, 647], [600, 647], [654, 668]], C.steel, 7);
      panel(rounded(599, 669, 24, 57, 5), C.steel, 5);
      line([[330, 565], [341, 475], [409, 425], [512, 410], [615, 425], [683, 475], [694, 565]], MIX.aquaDark, 8);
      strap([[474, 369], [550, 369]], C.ink, 29);
      break;
    case '11': {
      body([[272, 242], [752, 242], [738, 315], [756, 465], [752, 650], [738, 795], [752, 862], [272, 862], [287, 795], [272, 650], [268, 465], [287, 315]], C.steel, 150);
      for (const y of [248, 796]) panel(rectangle(280, y, 464, 63), MIX.steelDark, 0);
      for (let i = 0; i < 10; i++) {
        const x = 272 + i * 48;
        panel([[x, 243], [x + 24, 228], [x + 48, 243]], C.steel, 0);
        panel([[x, 860], [x + 24, 878], [x + 48, 860]], C.steel, 0);
      }
      panel([[368, 468], [420, 445], [512, 433], [605, 445], [656, 468], [656, 590], [605, 610], [512, 618], [420, 610], [368, 590]], C.tomato);
      panel(ellipse(444, 703, 62, 36, 12), C.gold);
      panel(ellipse(580, 718, 57, 32, 12), C.gold);
      panel(ellipse(512, 283, 34, 15, 12), C.ink, 0);
      break;
    }
    case '12': {
      front = 105;
      for (const [x, y] of [[408, 800], [606, 800], [512, 692], [382, 632], [637, 644], [502, 548]]) m.ellipsoid(x, y, 0, 106, 78, 93, C.gold);
      // Clip both diagonal families to the net's pear silhouette, matching the original diamond weave.
      const net = [[512, 397], [624, 500], [735, 650], [720, 810], [630, 895], [390, 895], [305, 810], [290, 650], [400, 500]];
      for (const z of [-103, 103]) {
        m.band([...net, net[0]], 5, accent, z, 3);
        for (const sign of [-1, 1]) for (let i = -3; i <= 3; i++) {
          const cuts = [];
          const distance = ([x, y]) => x - 512 + sign * (y - 650) - i * 110;
          net.forEach((a, j) => {
            const b = net[(j + 1) % net.length], da = distance(a), db = distance(b);
            if (da * db < 0) { const f = da / (da - db); cuts.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]); }
          });
          if (cuts.length === 2) m.band(cuts, 5, accent, z, 3);
        }
      }
      m.panel(rounded(476, 377, 72, 36, 14), accent, 108);
      strap([[490, 388], [534, 388]], accent, 18);
      break;
    }
  }
  addPrint(m, traits.kind, traits.kind === '03' ? 59 : front + 12);
  // Layer separation is millimetres in model space; no coplanar decals or textures.
  let z = front + 10;
  for (const part of details(traits)) {
    z += 0.7;
    if (part.fill) m.panel(part.points, part.fill, z, part.width, 3);
    else m.line(part.points, part.width, part.color, z, 3);
  }
  m.hook();
  return exportGlb(m.finish());
}
