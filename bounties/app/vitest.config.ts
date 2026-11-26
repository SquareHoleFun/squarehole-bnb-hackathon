import { defineConfig } from 'vitest/config';
import { privyBridge } from './build/privy-bridge';

// SH-280: the bridge's address module (virtual:privy-bridge) as the development server has it.
export default defineConfig({ plugins: [privyBridge()], test: { include: ['test/**/*.test.ts'], environment: 'node' } });
