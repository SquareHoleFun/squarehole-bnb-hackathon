import { describe, expect, it } from 'vitest';
import { loadModelV2, outputsV2, readSourcesV2 } from '../../scripts/lib/outputs-v2.mjs';

describe('CQ11-D: frozen shapes are the source of the generated twins', () => {
  it('accepts the data against every frozen Solidity enum and struct', () => {
    expect(() => loadModelV2(readSourcesV2())).not.toThrow();
  });

  it('generates only the current listing and exact raise, with no retired context fields', () => {
    const outputs = outputsV2(loadModelV2(readSourcesV2()));
    expect(outputs).toHaveLength(2);
    for (const [path, text] of outputs) {
      expect(text, path).toContain('ctx.listing');
      expect(text, path).not.toMatch(/\bTarget(?:V2)?\b|ctx\.(?:listings|targets|offeredLegs|offeredDests|offeredAddOns|targetSlotOffered|gradLayouts)\b|\.raise(?:Min|Max)\b/);
      expect(text, path).toContain('FULL_RANGE');
    }
  });
});
