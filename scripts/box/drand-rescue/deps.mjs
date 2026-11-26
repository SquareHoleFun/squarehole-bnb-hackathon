import { createRequire } from 'node:module';

// Resolution only: the hourly runner installs this workspace's locked viem 2.56.8.
const require = createRequire(new URL('../../../packages/keeper/package.json', import.meta.url));
export const viem = require('viem');
export const { privateKeyToAccount } = require('viem/accounts');
