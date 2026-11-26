import { MAX_RAW_BLOCK_BYTES } from '../../../scripts/ipfs/pin-raw-lib.mjs';

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, names) => object(value) && Object.keys(value).sort().join(',') === names.join(',');
const digest = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value);
export const ZERO_HASH = `0x${'0'.repeat(64)}`;

export function imageType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF'
      && bytes.readUInt32LE(4) === bytes.length - 8 && bytes.toString('ascii', 8, 12) === 'WEBP'
      && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16))) return 'image/webp';
  return null;
}

/** Exact canonical string-only schema used by Create, not arbitrary JSON or a private reveal envelope.
 * Schema validation cannot establish publication permission: only approved public blocks may be pinned.
 */
export function publicRevealList(bytes) {
  if (!bytes.length || bytes.length > MAX_RAW_BLOCK_BYTES) return null;
  try {
    const text = utf8.decode(bytes);
    const list = JSON.parse(text);
    if (!keys(list, ['format', 'items', 'n']) || list.format !== 'squarehole.box-reveal-list/1'
        || typeof list.n !== 'string' || !/^[1-9][0-9]{0,6}$/.test(list.n)
        || BigInt(list.n) > 1n << 20n || !Array.isArray(list.items)
        || BigInt(list.items.length) !== BigInt(list.n)) return null;
    const items = [];
    for (const [index, item] of list.items.entries()) {
      if (!keys(item, ['avatarSha256', 'id', 'imageSha256', 'modelSha256', 'salt', 'traitsPacked'])
          || item.id !== String(BigInt(index) + 1n)
          || !['imageSha256', 'avatarSha256', 'modelSha256', 'salt'].every(key => digest(item[key]))
          || item.imageSha256 === ZERO_HASH || typeof item.traitsPacked !== 'string'
          || !/^(0|[1-9][0-9]{0,38})$/.test(item.traitsPacked) || BigInt(item.traitsPacked) >= 1n << 128n) return null;
      const { avatarSha256, id, imageSha256, modelSha256, salt, traitsPacked } = item;
      items.push({ avatarSha256, id, imageSha256, modelSha256, salt, traitsPacked });
    }
    // Fixed schema, sorted keys: equivalent to artwork canonicalJson without a runtime TS/package dependency.
    if (text !== JSON.stringify({ format: list.format, items, n: list.n })) return null;
    return list;
  } catch { return null; }
}

const extensions = new Set(['KHR_mesh_quantization', 'KHR_texture_transform']);
const integer = value => Number.isSafeInteger(value) && value >= 0;

/** Container/resource checks from artwork glbSha256 and edition checkHandMadeModel, without Misfit anchors.
 * Also validate every chunk boundary, BIN length, buffer view and embedded image. Mesh semantics stay with
 * the producer/viewer. No decoder extensions, remote/relative resources, HTML or SVG images are admitted.
 */
export function validGlb(bytes) {
  try {
    if (bytes.length < 20 || bytes.length > MAX_RAW_BLOCK_BYTES || bytes.length % 4 !== 0
        || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2
        || bytes.readUInt32LE(8) !== bytes.length || bytes.readUInt32LE(16) !== 0x4e4f534a) return false;
    const length = bytes.readUInt32LE(12);
    if (!length || length % 4 !== 0 || 20 + length > bytes.length) return false;
    const json = JSON.parse(utf8.decode(bytes.subarray(20, 20 + length)));
    if (!object(json) || !object(json.asset) || json.asset.version !== '2.0'
        || (json.asset.minVersion !== undefined && json.asset.minVersion !== '2.0')) return false;
    let bin = Buffer.alloc(0);
    const at = 20 + length;
    if (at !== bytes.length) {
      if (at + 8 > bytes.length || bytes.readUInt32LE(at + 4) !== 0x004e4942
          || bytes.readUInt32LE(at) % 4 !== 0 || at + 8 + bytes.readUInt32LE(at) !== bytes.length) return false;
      bin = bytes.subarray(at + 8);
    }
    for (const field of ['extensionsUsed', 'extensionsRequired']) {
      if (json[field] !== undefined && (!Array.isArray(json[field]) || json[field].some(name => !extensions.has(name)))) return false;
    }
    // Check extension objects too: undeclared extensions must not bypass the resource policy.
    const pending = [json];
    while (pending.length) {
      const value = pending.pop();
      if (!value || typeof value !== 'object') continue;
      if (value.extensions !== undefined && (!object(value.extensions) || Object.keys(value.extensions).some(name => !extensions.has(name)))) return false;
      if (value.uri !== undefined && (typeof value.uri !== 'string' || !value.uri.startsWith('data:image/'))) return false;
      pending.push(...Object.values(value));
    }
    for (const field of ['buffers', 'bufferViews', 'images', 'meshes', 'nodes', 'scenes', 'accessors', 'textures', 'materials', 'animations', 'skins', 'samplers', 'cameras']) {
      if (json[field] !== undefined && (!Array.isArray(json[field]) || !json[field].every(object))) return false;
    }
    const buffers = json.buffers ?? [];
    if (buffers.length > 1 || (bin.length > 0 && buffers.length !== 1)) return false;
    if (buffers.length && (buffers[0].uri !== undefined || !integer(buffers[0].byteLength)
        || buffers[0].byteLength === 0 || buffers[0].byteLength > bin.length || bin.length - buffers[0].byteLength > 3)) return false;
    const views = json.bufferViews ?? [];
    for (const view of views) {
      if (view.buffer !== 0 || !buffers.length || !integer(view.byteOffset ?? 0) || !integer(view.byteLength)
          || !view.byteLength || (view.byteOffset ?? 0) + view.byteLength > buffers[0].byteLength) return false;
    }
    for (const img of json.images ?? []) {
      let data;
      let mime = img.mimeType;
      if (img.uri !== undefined) {
        const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(img.uri);
        if (!match || img.bufferView !== undefined || (mime !== undefined && mime !== match[1])) return false;
        mime = match[1]; data = Buffer.from(match[2], 'base64');
        if (data.toString('base64') !== match[2]) return false;
      } else {
        if (!integer(img.bufferView) || !views[img.bufferView]) return false;
        const view = views[img.bufferView];
        data = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
      }
      if (!mime || imageType(data) !== mime) return false;
    }
    return true;
  } catch { return false; }
}

export function contentType(bytes) {
  if (!bytes.length || bytes.length > MAX_RAW_BLOCK_BYTES) return null;
  return imageType(bytes) ?? (validGlb(bytes) ? 'model/gltf-binary' : null)
    ?? (publicRevealList(bytes) ? 'application/json' : null);
}
