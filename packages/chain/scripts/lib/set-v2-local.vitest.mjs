import { defineConfig } from 'vitest/config';

// The lane owns this local-script test; the workspace chain project only discovers src/ and test/.
export default defineConfig({
  test: { environment: 'node', include: ['packages/chain/scripts/lib/set-v2-local.test.ts'] },
});
