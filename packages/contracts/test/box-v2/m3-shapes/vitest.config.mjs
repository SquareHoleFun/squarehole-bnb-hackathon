import { shTestTimeouts } from '../../../../../vitest.timeouts.mjs';
export default { test: { ...shTestTimeouts(), include: ['packages/contracts/test/box-v2/m3-shapes/*.test.ts'] } };
