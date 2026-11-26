import { canvas, blit, label } from '../../models/lib/raster.mjs';
import { SPEC } from '../deal.mjs';

// Integer box reduction for deterministic review boards. Delivery PNGs stay at 1024 px.
export function reduceImage(source, factor) {
  const out = canvas(source.width / factor, source.height / factor);
  for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) for (let c = 0; c < 3; c++) {
    let sum = 0;
    for (let dy = 0; dy < factor; dy++) for (let dx = 0; dx < factor; dx++) sum += source.rgb[((y * factor + dy) * source.width + x * factor + dx) * 3 + c];
    out.rgb[(y * out.width + x) * 3 + c] = Math.round(sum / (factor * factor));
  }
  return out;
}
export function caption(image, row, x, y) {
  const name = SPEC.traits.house.find(v => v.value === row.traits.house).label;
  const lines = [`${row.id} - ${name}`, ...Object.entries(row.traits).filter(([key]) => key !== 'house').map(([key, value]) => `${key} - ${value}`)];
  lines.forEach((line, i) => label(image, line, x, y + i * 19, 2));
}
export function contactSheet(rows, images) {
  const out = canvas(2048, 12 * 640);
  rows.forEach((row, i) => {
    const x = i % 4 * 512, y = Math.floor(i / 4) * 640;
    blit(out, reduceImage(images.get(row.id), 2), x, y);
    caption(out, row, x + 20, y + 512);
  });
  return out;
}
export function modelsSheet(rows, images, renders) {
  const out = canvas(1536, rows.length * 640);
  rows.forEach((row, i) => {
    const y = i * 640;
    blit(out, reduceImage(images.get(row.id), 2), 0, y);
    blit(out, renders.get(`${row.id}/front`), 512, y);
    blit(out, renders.get(`${row.id}/three-quarter`), 1024, y);
    caption(out, row, 20, y + 512);
    label(out, 'FRONT', 532, y + 530);
    label(out, 'THREE-QUARTER', 1044, y + 530);
  });
  return out;
}
