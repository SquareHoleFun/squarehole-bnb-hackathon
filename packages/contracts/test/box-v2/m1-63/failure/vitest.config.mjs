import { shTestTimeouts } from '../../../../../../vitest.timeouts.mjs';
export default { test: { ...shTestTimeouts(), include: ['packages/contracts/test/box-v2/m1-63/failure/*.test.ts'] } };
