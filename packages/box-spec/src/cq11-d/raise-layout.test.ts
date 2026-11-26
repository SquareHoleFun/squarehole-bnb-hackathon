import { expect, it } from 'vitest';
import { boxCurve, fullRange } from '../layout-v2';
// @ts-expect-error the CLI module is JavaScript without a separate declaration file
import { curveProblem } from '../../scripts/lib/spec-numbers-v2.mjs';
const coin = { symbol: 'P', decimals: 8 };
it('rejects raises outside registry bounds before a quote', () => {
  expect(curveProblem({ boxCurve, fullRange }, 999_999n, coin)).toContain('RAISE_NOT_BUILDABLE');
  expect(curveProblem({ boxCurve, fullRange }, 1n << 128n, coin)).toContain('RAISE_NOT_BUILDABLE');
  expect(curveProblem({ boxCurve, fullRange }, 1_000_000n, coin)).toBeNull();
});
it('checks that full-range graduation can be built before a quote', () => {
  expect(curveProblem({ boxCurve, fullRange: () => { throw Error('range'); } }, 1_000_000n, coin)).toContain('RAISE_NOT_BUILDABLE');
});
