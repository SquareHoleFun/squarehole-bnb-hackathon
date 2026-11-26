import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { loadModelV2, readSourcesV2 } from '../scripts/lib/outputs-v2.mjs';
import type { Twin } from '../scripts/lib/check-spec-v2.mjs';
import * as twin from './generated/box-spec.v2';

it('F132 source describes the two-give admission enforced by the deployed shop', () => {
  const sources = readSourcesV2();
  expect(sources.spec.shop).toMatchObject({ minimumSeed: '2 * minInitialGiveT' });
  expect(sources.spec.fields.find((f) => f.name === 'contentsParams')).toMatchObject({
    note: expect.stringContaining('two cheapest initially listed gives'),
  });
});

it('F132 generator refuses the superseded percentage admission policy', () => {
  const sources = readSourcesV2();
  sources.spec.shop = { ...(sources.spec.shop as object), minimumSeed: 'ceil(minInitialGiveT * 10000 / collectionBps)' };
  expect(() => loadModelV2(sources)).toThrow('shop: unsupported minimum seed rule');
});

it('F132 launch explanation describes the allowance floor and fixed snapshot', async () => {
  // Match the Node-only presentation import used by the existing launch-skill tests.
  const { checkSpecV2, modelForV2 }: typeof import('../scripts/lib/check-spec-v2.mjs') =
    await import('../scripts/lib/' + 'spec-launch-v2.mjs');
  const draft = JSON.parse(readFileSync(new URL('../../../skills/square-hole-launch/references/v2/examples/junkyard-shop.json', import.meta.url), 'utf8'));
  const model = modelForV2({ network: 'demo', twin: twin as unknown as Twin });
  const result = checkSpecV2(model, draft);
  expect(result.ok).toBe(true);
  const text = JSON.stringify([result.overview, result.notes]);
  expect(text).toContain('cheapest active listed give');
  expect(text).toContain('bounded by the frozen weekly snapshot');
  expect(text).toContain('two cheapest initially listed gives');
});
