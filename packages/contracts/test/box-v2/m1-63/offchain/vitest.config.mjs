import { createRequire } from 'node:module';
import { shTestTimeouts } from '../../../../../../vitest.timeouts.mjs';

// These dependencies are already installed for chain; some lane workspace links are absent.
const require = createRequire(new URL('../../../../../chain/package.json', import.meta.url));
export default {
  resolve: { alias: [
    { find: /^viem$/, replacement: require.resolve('viem') },
    { find: /^zod$/, replacement: require.resolve('zod') },
  ] },
  test: { ...shTestTimeouts(), include: ['packages/contracts/test/box-v2/m1-63/offchain/*.test.ts'] },
};
