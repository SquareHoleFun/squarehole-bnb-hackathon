import { defineConfig } from 'vitest/config';
import { shTestTimeouts } from '../../../../vitest.timeouts.mjs';

export default defineConfig({ test: { ...shTestTimeouts(), environment: 'node', include: ['packages/box-spec/test/set-v2/**/*.test.ts'] } });
