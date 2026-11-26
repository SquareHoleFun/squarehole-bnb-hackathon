import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { MAX_RAW_BLOCK_BYTES, rawCidV1, readBytes } from '../../../scripts/ipfs/pin-raw-lib.mjs';
import { contentType, ZERO_HASH } from './content.mjs';

const pictureRoles = new Set(['file', 'logo', 'cover', 'collection cover', 'banner', 'teaser', 'item', 'image', 'avatar']);
export const servedRole = role => pictureRoles.has(role) || role === 'model' || role === 'public reveal list';
export function roleMatchesMime(role, mime) {
  if (pictureRoles.has(role)) return ['image/png', 'image/jpeg', 'image/webp'].includes(mime);
  return (role === 'model' && mime === 'model/gltf-binary') || (role === 'public reveal list' && mime === 'application/json');
}

/** File names do not select content types. Expected hashes are supplied by the reviewed producer/spec. */
export function assetRecord(bytes, expected) {
  const mime = contentType(bytes);
  const sha256 = `0x${createHash('sha256').update(bytes).digest('hex')}`;
  const cid = rawCidV1(sha256);
  if (!roleMatchesMime(expected.role, mime) || expected.sha256 !== sha256
      || (expected.mime !== undefined && expected.mime !== mime)
      || (expected.cid !== undefined && expected.cid !== cid)
      || (expected.bytes !== undefined && expected.bytes !== bytes.length)) throw new Error('public asset differs from role, MIME or commitment');
  return { role: expected.role, mime, sha256, cid, bytes: bytes.length };
}

export async function readAsset(directory, file) {
  if (typeof file?.path !== 'string' || !file.path || isAbsolute(file.path) || file.path.includes('\\')
      || file.path.split('/').some(part => !part || part === '.' || part === '..')
      || [...file.path].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new Error('invalid public asset path');
  const base = await realpath(directory);
  const path = await realpath(resolve(base, file.path));
  const within = relative(base, path);
  if (within === '..' || within.startsWith('../') || isAbsolute(within)) throw new Error('public asset escapes its directory');
  return readBytes(path, MAX_RAW_BLOCK_BYTES);
}

/** Every nonzero leaf resource must be a verified block in the same inventory (deduplication is by CID).
 * This checks byte coverage, not the list's on-chain root or permission to publish hidden material.
 */
export function requireListAssets(lists, records) {
  const byHash = new Map(records.map(record => [record.sha256, record]));
  for (const list of lists) for (const item of list.items) {
    for (const role of ['image', 'avatar', 'model']) {
      const hash = item[`${role}Sha256`];
      if (hash === ZERO_HASH) continue;
      const record = byHash.get(hash);
      if (!record || !roleMatchesMime(role, record.mime)) throw new Error(`public list missing required ${role} block`);
    }
  }
}
