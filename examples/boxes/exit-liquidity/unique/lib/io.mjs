import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
export function requireNode() {
  if (process.versions.node !== '24.22.1') throw new Error('Use Node 24.22.1 for the pinned artwork build');
}
