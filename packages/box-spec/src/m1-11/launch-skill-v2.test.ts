/** CQ11-D: every offered draft and preset passes the real frozen twin. */
import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { modelForV2, checkSpecV2, fromPreset, type Twin } from '../../scripts/lib/check-spec-v2.mjs';
import * as twin from '../generated/box-spec.v2';
const root = new URL('../../../../skills/square-hole-launch/references/v2/', import.meta.url);
for (const dir of ['examples', 'configurations', 'presets']) {
  for (const file of readdirSync(new URL(`${dir}/`, root)).filter((x) => x.endsWith('.json'))) {
    it(`CQ11-D offered ${dir}/${file} is buildable with the current menu`, () => {
      const doc = JSON.parse(readFileSync(new URL(`${dir}/${file}`, root), 'utf8'));
      const model = modelForV2({ network: doc.network ?? 'demo', twin: twin as unknown as Twin });
      const result = checkSpecV2(model, dir === 'presets' ? fromPreset(doc) : doc);
      expect(result.ok, JSON.stringify(result.problems ?? result.explanation)).toBe(true);
      expect(result.wire.gradLayout).toBe(3);
      expect(result.ctx?.listing).toBeDefined();
    });
  }
}
