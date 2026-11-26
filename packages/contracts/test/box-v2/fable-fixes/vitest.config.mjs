import { shTestTimeouts } from '../../../../../vitest.timeouts.mjs';
export default { test: { ...shTestTimeouts(), include: ['packages/contracts/test/box-v2/fable-fixes/*.test.ts'] } };
