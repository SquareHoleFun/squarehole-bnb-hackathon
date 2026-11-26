import assert from 'node:assert/strict';
import { CAMERAS, renderGlb } from '../../models/lib/raster.mjs';

export const PIXELS_PER_UNIT = 310;
export const REVIEW_CAMERAS = Object.fromEntries(['front', 'three-quarter'].map(name => [name, { ...CAMERAS[name], pixelsPerUnit: PIXELS_PER_UNIT }]));
// The existing rasterizer accepts named camera presets. Add namespaced presets without changing its originals.
for (const [name, config] of Object.entries(REVIEW_CAMERAS)) CAMERAS[`unique-${name}`] = config;
export function renderModel(bytes, camera) {
  assert.ok(Object.hasOwn(REVIEW_CAMERAS, camera), 'front or three-quarter camera');
  return renderGlb(bytes, `unique-${camera}`);
}
