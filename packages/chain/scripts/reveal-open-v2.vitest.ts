import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['packages/chain/scripts/reveal-open-v2.test.ts'] } });
