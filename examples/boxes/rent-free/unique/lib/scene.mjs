import { makeHouse } from '../../models/lib/houses.mjs';
import { validateTraits } from '../deal.mjs';
import { Details, oval, roundRect } from './geometry.mjs';

// Attachment anchors in the approved builders' 512 px reference coordinates.
// These describe where new details fit, not a second implementation of the twelve houses.
const ANCHORS = [
  { base: 443, left: 100, door: [266, 315, 83], window: [138, 301, 86, 88], post: 106, plant: 380 },
  { base: 443, left: 135, door: [272, 303, 79], window: [171, 272, 86, 88], post: 128, plant: 379 },
  { base: 443, left: 48, door: [195, 308, 76], window: [81, 308, 81, 82], post: 50, plant: 436 },
  { base: 409, left: 121, door: [208, 294, 93], window: [204, 178, 100, 100], post: 142, plant: 365 },
  { base: 410, left: 86, door: [246, 256, 92], window: [111, 252, 86, 88], post: 89, plant: 383 },
  { base: 410, left: 77, door: [255, 251, 97], window: [116, 220, 106, 106], post: 85, plant: 385 },
  { base: 464, left: 123, door: [256, 340, 76], window: [150, 330, 80, 84], post: 108, plant: 470 },
  { base: 464, left: 113, door: [217, 318, 78], window: [143, 290, 53, 117], post: 114, plant: 396 },
  { base: 464, left: 80, door: [255, 338, 87], window: [113, 307, 108, 108], post: 83, plant: 374 },
  { base: 385, left: 120, door: [316, 238, 85], window: [158, 229, 126, 102], post: 121, plant: 434 },
  { base: 384, left: 97, door: [258, 244, 94], window: [131, 244, 87, 88], post: 102, plant: 390 },
  { base: 384, left: 67, door: [251, 232, 95], window: [110, 214, 101, 103], post: 76, plant: 379 },
];

function doorDetail(d, a, value) {
  const [x, top, w] = a.door, y = Math.max(top + 18, a.base - 126), cx = x + w / 2;
  // Clay insets on dark doors; forest on the original clay/butter doors. Keep each original surround and knob.
  const material = ['02', '09', '11', '12'].includes(a.house) ? 'forest' : 'clay';
  const panelBase = a.base - (['02', '05', '06'].includes(a.house) ? 16 : 0);
  if (value === 'Plain panel') d.box(cx - 17, panelBase - 105, 34, 32, material, 18, 3);
  if (value === 'Twin panels') {
    d.box(cx - 20, panelBase - 105, 16, 32, material, 18, 3);
    d.box(cx + 4, panelBase - 105, 16, 32, material, 18, 3);
  }
  if (value === 'Stable panel') {
    d.box(cx - 21, panelBase - 104, 42, 34, material, 18, 3);
    d.line([cx - 17, panelBase - 99], [cx + 17, panelBase - 75], 6, 'butter', 19);
    d.box(cx - 25, panelBase - 113, 50, 7, 'butter', 19, 3, 2);
  }
  if (value === 'Diamond pane') d.outlined([[cx, y], [cx + 23, y + 25], [cx, y + 50], [cx - 23, y + 25]], 'butter', 19, 4);
  if (value === 'Round pane') d.outlined(oval(cx, y + 25, 23, 25), 'butter', 19, 4);
}
function windowDetail(d, a, value) {
  const [x, y, w, h] = a.window;
  if (value === 'Bare frame') return;
  if (value === 'Clay sill') {
    d.box(x - 8, y + h - 2, w + 16, 14, 'forest', 27, 20);
    d.box(x - 2, y + h + 2, w + 4, 6, 'clay', 28, 1, 2);
  }
  if (value === 'Side shutters') {
    // Keep clear of doors and wall edges even on the narrow Step gable and Townhouse.
    for (const sx of [x - 18, x + w + 2]) {
      d.box(sx, y + 9, 16, h - 18, 'forest', 20, 8, 3);
      d.box(sx + 4, y + 14, 8, h - 28, 'clay', 21, 1, 2);
    }
  }
  if (value === 'Rain hood') {
    d.outlined([[x - 9, y + 2], [x + 2, y - 20], [x + w - 2, y - 20], [x + w + 9, y + 2]], 'clay', 31, 26, 0.67);
  }
}
function postDetail(d, a, value) {
  const x = a.post, b = a.base;
  if (value === 'Quiet post') {
    // An empty, low letter tray; no mail amount or current economic state is implied.
    d.box(x - 24, b - 22, 48, 22, 'forest', 53, 30);
    d.box(x - 18, b - 17, 36, 8, 'clay', 54, 1, 2);
    return;
  }
  const wall = value === 'Wall post';
  const bottom = wall ? b - 37 : b;
  if (value === 'Pillar post' || value === 'Round post') {
    d.box(x - 7, b - 59, 14, 54, 'forest', 45, 18, 2);
    d.box(x - 17, b - 10, 34, 10, 'forest', 51, 28, 3);
  }
  const y = value === 'Parcel post' ? b - 68 : b - 88;
  if (value === 'Round post') d.outlined(oval(x, y + 22, 25, 24), 'clay', 58, 32, 0.73);
  else {
    const height = value === 'Pillar post' ? 44 : bottom - y;
    d.box(x - 24, y, 48, height, 'forest', 56, wall ? 56 : 34, 7);
    d.box(x - 18, y + 6, 36, height - 12, 'clay', 57, 1, 4);
  }
  d.box(x - 13, y + 15, 26, 6, 'forest', 59, 2, 2);
  if (value === 'Parcel post') {
    d.line([x - 15, y + 36], [x + 15, y + 36], 5, 'forest', 59);
    d.box(x + 7, y + 44, 5, 10, 'forest', 59, 2, 1);
  }
}
function plantDetail(d, a, value) {
  const b = a.base, center = a.plant;
  const pot = (x, y, small = false) => {
    const w = small ? 17 : 24, h = small ? 26 : 34;
    d.outlined([[x - w, y - h], [x + w, y - h], [x + w - 5, y], [x - w + 5, y]], 'clay', 59, 31, 0.7);
    d.box(x - w - 2, y - h - 2, 2 * w + 4, 8, 'forest', 60, 34, 3);
  };
  const leaf = (x, y, direction, size = 1) => {
    const p = [[x, y], [x + direction * 20 * size, y - 9 * size], [x + direction * 22 * size, y - 25 * size], [x + direction * 7 * size, y - 20 * size]];
    d.outlined(p, 'green', 56, 7, 0.65);
  };
  if (value === 'Twin pots') {
    for (const [dx, lift] of [[-18, 0], [19, 8]]) {
      const x = center + dx;
      d.line([x, b - 28], [x, b - 58 - lift], 6, 'forest', 54);
      leaf(x, b - 42 - lift, dx < 0 ? -1 : 1, 0.7);
      pot(x, b, true);
    }
    return;
  }
  d.line([center, b - 35], [center, b - (value === 'Tall sprig' ? 96 : 68)], 6, 'forest', 54);
  if (value === 'Clover pot') {
    for (const [dx, dy, r] of [[-14, -58, 15], [14, -58, 15], [0, -76, 17]]) d.outlined(oval(center + dx, b + dy, r, r, 12), 'green', 56, 13, 0.65);
  } else {
    leaf(center, b - 42, -1); leaf(center, b - 47, 1);
    if (value === 'Fan leaves') {
      d.outlined(oval(center, b - 76, 10, 21, 12), 'green', 57, 8, 0.60);
      leaf(center, b - 57, -1, 1.05); leaf(center, b - 60, 1, 1.05);
    }
    if (value === 'Tall sprig') { leaf(center, b - 69, -1, 0.8); leaf(center, b - 80, 1, 0.7); }
  }
  pot(center, b);
}
function stepDetail(d, a, value) {
  const [x, , w] = a.door, b = a.base;
  if (value === 'Round step') {
    // Rounded corners in elevation on a deeper projecting tread.
    const polygon = roundRect(x - 5, b - 15, w + 10, 15, 7);
    d.prism(polygon, 9, 61, 'forest');
    d.box(x + 2, b - 11, w - 4, 6, 'clay', 62, 2, 3);
  } else {
    const twin = value === 'Twin step';
    d.box(x - 6, b - 13, w + 12, 13, 'forest', 54, 45, 3);
    d.box(x, b - 10, w, 6, value === 'Butter step' ? 'butter' : 'clay', 55, 1, 2);
    if (twin) {
      d.box(x + 2, b - 24, w - 4, 11, 'forest', 36, 27, 3);
      d.box(x + 7, b - 21, w - 14, 5, 'clay', 37, 1, 2);
    }
  }
}

export function houseScene(traits) {
  validateTraits(traits);
  const variant = Number(traits.house); // A bounded geometry selector, never a token amount.
  const base = makeHouse(variant), a = { ...ANCHORS[variant - 1], house: traits.house };
  // Recover the imported builder's reference frame from the lower green walls. No rescaling.
  const lower = base.filter(t => t.material === 'green').flatMap(t => t.points).filter(p => p[1] < 0.1);
  const originX = a.left - Math.min(...lower.map(p => p[0])) * 350;
  const frontZ = Math.max(...lower.map(p => p[2]));
  const details = new Details(([x, y, z]) => [(x - originX) / 350, (a.base - y) / 350, frontZ + z / 350]);
  doorDetail(details, a, traits.door);
  windowDetail(details, a, traits.window);
  postDetail(details, a, traits.post);
  plantDetail(details, a, traits.plant);
  stepDetail(details, a, traits.step);
  const all = [...base, ...details.triangles];
  const points = all.flatMap(t => t.points);
  const center = [0, 2].map(axis => (Math.min(...points.map(p => p[axis])) + Math.max(...points.map(p => p[axis]))) / 2);
  return all.map(t => ({ material: t.material, points: t.points.map(([x, y, z]) => [x - center[0], y, z - center[1]]) }));
}
