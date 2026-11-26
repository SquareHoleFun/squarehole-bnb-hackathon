import { defineConfig } from 'vitest/config';
import { shTestTimeouts } from '../../../vitest.timeouts.mjs';
export default defineConfig({ test: { ...shTestTimeouts(), environment: 'node', include: ['infra/server/test/**/*.test.mjs'] } });
