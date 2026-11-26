import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve, relative } from 'node:path';

export const { keccak256, toHex, decodeAbiParameters, encodeAbiParameters } =
  createRequire(new URL('../../../packages/chain/package.json', import.meta.url))('viem');
export const ZERO = `0x${'0'.repeat(40)}`;
export const API = 'https://api.etherscan.io/v2/api';
// Only our own diagnostics cross the CLI boundary; filesystem, HTTP and parser errors may contain secrets.
export class VerificationError extends Error {}
export function requireValue(ok, message) {
  if (!ok) throw new VerificationError(message);
}
export function address(value) {
  requireValue(typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && value.toLowerCase() !== ZERO, 'invalid contract address');
  return value.toLowerCase();
}
export function hex(value, bytes) {
  requireValue(typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(value), 'invalid hex bytes');
  requireValue(bytes === undefined || value.length === 2 + bytes * 2, 'invalid hex length');
  return value.toLowerCase();
}
export function chainId(value, allowMainnet = false) {
  requireValue(['1', '11155111', '31337'].includes(String(value)), 'unsupported chain');
  requireValue(String(value) !== '1' || allowMainnet, 'chain 1 requires --allow-mainnet (G08)');
  return String(value);
}
export function localPath(base, path) {
  requireValue(typeof path === 'string' && path.length > 0 && !isAbsolute(path) && !path.includes('\\'), 'expected a relative public build path');
  const result = resolve(base, path);
  requireValue(!relative(resolve(base), result).startsWith('..'), 'build path escapes its root');
  return result;
}
export async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new VerificationError('cannot read public JSON input'); }
}
export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
