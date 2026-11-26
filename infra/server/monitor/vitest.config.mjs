import { defineConfig } from 'vitest/config';
import { shTestTimeouts } from '../../../vitest.timeouts.mjs';
export default defineConfig({ test: { ...shTestTimeouts(), include: ['infra/server/monitor/test/*.test.mjs'], environment: 'node' } });
