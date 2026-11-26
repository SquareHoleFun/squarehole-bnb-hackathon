import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
export const isMain = url => process.argv[1] && url === pathToFileURL(resolve(process.argv[1])).href;
export function write(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}
export function requireNode() {
  if (process.versions.node !== '24.22.1') throw new Error('Use Node 24.22.1 for reproducible artifacts');
}
