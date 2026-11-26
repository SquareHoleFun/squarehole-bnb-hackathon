import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';

// Same wire format and size bound as packages/artwork/src/misfits-commitment.ts.
// Kept dependency-free for the founder's Node CLI; shared commitment vectors test parity.
export const MAX_RAW_BLOCK_BYTES = 1_048_576;
export const DEFAULT_ENCODING = Object.freeze({
  imageSize: 512, imageFormat: 'webp', imageQuality: 90,
  avatarSize: 256, avatarFormat: 'webp', avatarQuality: 90,
});
const PINATA_IMPORT = 'https://api.pinata.cloud/pinning/pinFileToIPFS?car=true';
const KEY_LIMIT = 16_384;
const PREFIX = Buffer.from([1, 0x55, 0x12, 0x20]);
const sha256 = (bytes) => `0x${createHash('sha256').update(bytes).digest('hex')}`;
const isDigest = (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);

// Only fixed, locally authored messages cross the CLI boundary. Never attach an upstream cause.
export class PinRawError extends Error {}
const fail = (message) => { throw new PinRawError(message); };

export function rawCidV1(digest) {
  if (!isDigest(digest)) fail('digest must be a 32-byte hex string');
  const bytes = Buffer.concat([PREFIX, Buffer.from(digest.slice(2), 'hex')]);
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let result = 'b';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits) result += alphabet[(buffer << (5 - bits)) & 31];
  return result;
}

function varint(value) {
  const bytes = [];
  do {
    const next = value % 128;
    value = Math.floor(value / 128);
    bytes.push(next | (value ? 128 : 0));
  } while (value);
  return Buffer.from(bytes);
}

/** CARv1: canonical DAG-CBOR { roots: [CID], version: 1 }, then one raw block.
 * No UnixFS wrapping, directory, or 256 KiB chunking. The whole file is the root block.
 */
export function rawBlockCar(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_RAW_BLOCK_BYTES) fail('a raw block must contain at most 1 MiB');
  const cid = Buffer.concat([PREFIX, Buffer.from(sha256(bytes).slice(2), 'hex')]);
  // CBOR tag 42 contains a byte string with a leading identity byte followed by the binary CID.
  const header = Buffer.concat([
    Buffer.from('a265726f6f747381d82a582500', 'hex'), cid,
    Buffer.from('6776657273696f6e01', 'hex'),
  ]);
  return Buffer.concat([varint(header.length), header, varint(cid.length + bytes.length), cid, bytes]);
}

/** Bounded reads also handle a file growing after stat. Callers replace filesystem errors. */
export async function readBytes(path, limit) {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) fail('file is not regular or exceeds its size limit');
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > limit) fail('file exceeds its size limit');
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

function objectWithKeys(value, allowed) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.includes(key));
}

const hasControlCharacter = (value) => [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

function parseManifest(input, baseDirectory) {
  if (!objectWithKeys(input, ['files', 'encoding']) || !Array.isArray(input.files)
      || input.files.length === 0 || input.files.length > 20_000) fail('manifest needs a files array of 1..20000 entries');
  if (input.encoding !== undefined && !objectWithKeys(input.encoding, Object.keys(DEFAULT_ENCODING))) fail('invalid encoding profile');
  const encoding = { ...DEFAULT_ENCODING, ...input.encoding };
  for (const role of ['image', 'avatar']) {
    const size = encoding[`${role}Size`];
    const quality = encoding[`${role}Quality`];
    if (!Number.isSafeInteger(size) || size < 1 || size > 16_384
        || !Number.isSafeInteger(quality) || quality < 1 || quality > 100
        || !['webp', 'png', 'jpeg'].includes(encoding[`${role}Format`])) fail('invalid encoding profile');
  }
  const byId = new Map();
  const files = input.files.map((entry, i) => {
    const index = i + 1;
    if (!objectWithKeys(entry, ['path', 'role', 'id', 'sha256']) || typeof entry.path !== 'string'
        || entry.path.length === 0 || hasControlCharacter(entry.path)) fail(`file ${index}: invalid manifest entry`);
    const role = entry.role ?? 'file';
    if (!['file', 'logo', 'cover', 'banner', 'image', 'avatar', 'model'].includes(role)) fail(`file ${index}: invalid role`);
    if (entry.sha256 !== undefined && !isDigest(entry.sha256)) fail(`file ${index}: invalid expected sha256`);
    const itemRole = ['image', 'avatar', 'model'].includes(role);
    if (itemRole !== (entry.id !== undefined)) fail(`file ${index}: item roles require an id`);
    if (entry.id !== undefined) {
      if (typeof entry.id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(entry.id)) fail(`file ${index}: id must be a positive decimal string`);
      const roles = byId.get(entry.id) ?? new Set();
      if (roles.has(role)) fail(`file ${index}: duplicate id and role`);
      roles.add(role);
      byId.set(entry.id, roles);
    }
    return { index, role, ...(entry.id === undefined ? {} : { id: entry.id }), path: resolve(baseDirectory, entry.path), expected: entry.sha256?.toLowerCase() };
  });
  for (const roles of byId.values()) {
    if (!roles.has('image') || !roles.has('avatar')) fail('each item id needs both image and avatar files');
  }
  return { files, encoding };
}

export function gatewayOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
    return url.origin;
  } catch {
    fail('gateway must be an HTTPS origin without credentials, path, query or fragment');
  }
}

async function credential(options, env, read) {
  if (Boolean(options.keyEnv) === Boolean(options.keyFile)) fail('pin needs exactly one credential source: key-env or key-file');
  let value;
  if (options.keyEnv) {
    if (typeof options.keyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.keyEnv)) fail('invalid credential environment variable name');
    value = env[options.keyEnv];
  } else {
    try {
      value = (await read(options.keyFile, KEY_LIMIT)).toString('utf8');
    } catch {
      fail('cannot read credential file (regular file, at most 16 KiB required)');
    }
  }
  if (typeof value !== 'string' || value.length > KEY_LIMIT) fail('missing or invalid credential');
  value = value.trim();
  if (!/^[A-Za-z0-9._~-]+$/.test(value)) fail('missing or invalid credential');
  return value;
}

export async function responseBytes(response, limit) {
  const chunks = [];
  let length = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > limit) throw new Error(); // for-await cancels the response stream on failure.
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks, length);
}

async function upload(bytes, cid, key, fetch, timeoutMs) {
  const body = new FormData();
  body.append('file', new Blob([rawBlockCar(bytes)], { type: 'application/vnd.ipld.car' }), 'block.car');
  body.append('pinataOptions', JSON.stringify({ cidVersion: 1, wrapWithDirectory: false }));
  let returned;
  try {
    const response = await fetch(PINATA_IMPORT, {
      method: 'POST', headers: { Authorization: `Bearer ${key}` }, body,
      redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error();
    }
    returned = JSON.parse((await responseBytes(response, 16_384)).toString('utf8'))?.IpfsHash;
  } catch {
    fail('Pinata import failed (transport, HTTP or response); no response details were logged');
  }
  if (returned !== cid) fail('Pinata CID mismatch; stopped without accepting the pin');
}

export async function verifyGateway(origin, record, fetch, timeoutMs) {
  let bytes;
  try {
    const response = await fetch(`${origin}/ipfs/${record.cid}`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error();
    }
    bytes = await responseBytes(response, MAX_RAW_BLOCK_BYTES);
  } catch {
    fail('gateway check failed (transport, HTTP or response size)');
  }
  if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) fail('gateway bytes do not match the file sha256');
}

/** Raw CAR import for a checkpointed worker. Pinata is queried before upload so a
 * retry can recover an accepted import whose response/checkpoint was lost.
 * Kubo imports/pins the same content-addressed root idempotently.
 */
export async function ensureRawPin({ provider, api, token, bytes, sha256: expected, fetch = globalThis.fetch, timeoutMs = 60_000 }) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_RAW_BLOCK_BYTES
      || sha256(bytes) !== expected) fail('raw block bytes must match the expected sha256 and fit 1 MiB');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) fail('invalid pin timeout');
  if (!['kubo', 'pinata'].includes(provider)) fail('unknown pin provider');
  if ((provider === 'pinata' || token !== undefined)
      && (typeof token !== 'string' || !/^[A-Za-z0-9._~-]{1,16384}$/.test(token))) fail('missing or invalid pin credential');
  const cid = rawCidV1(expected);
  if (provider === 'pinata') {
    let rows;
    try {
      const response = await fetch(`https://api.pinata.cloud/data/pinList?status=pinned&hashContains=${cid}&pageLimit=10`, {
        method: 'GET', headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(); }
      rows = JSON.parse((await responseBytes(response, 65_536)).toString('utf8')).rows;
      if (!Array.isArray(rows) || rows.some((row) => !row || typeof row.ipfs_pin_hash !== 'string')) throw new Error();
    } catch { fail('Pinata pin lookup failed; no response details were logged'); }
    if (rows.some((row) => row.ipfs_pin_hash === cid && row.date_unpinned === null)) return;
    await upload(bytes, cid, token, fetch, timeoutMs);
    return;
  }
  // The droplet RPC must be behind HTTPS; local deployments may use a loopback tunnel.
  const origin = kuboOrigin(api);
  const body = new FormData();
  body.append('file', new Blob([rawBlockCar(bytes)], { type: 'application/vnd.ipld.car' }), 'block.car');
  let records;
  try {
    const response = await fetch(`${origin}/api/v0/dag/import?pin-roots=true&silent=false`, {
      method: 'POST', headers: token === undefined ? {} : { Authorization: `Bearer ${token}` }, body,
      redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(); }
    records = (await responseBytes(response, 16_384)).toString('utf8').trim().split('\n').map((line) => JSON.parse(line));
  } catch { fail('Kubo import failed (transport, HTTP or response); no response details were logged'); }
  const roots = records.filter((record) => record?.Root);
  if (records.some((record) => record?.Error || record?.Message)
      || roots.length !== 1 || roots[0].Root.Cid?.['/'] !== cid
      || ![undefined, ''].includes(roots[0].Root.PinErrorMsg)) fail('Kubo root CID or pin result mismatch');
}

export function kuboOrigin(value) {
  try {
    const url = new URL(value);
    const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
        || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
    return url.origin;
  } catch { fail('Kubo needs an HTTPS origin or loopback HTTP origin without credentials, path, query or fragment'); }
}

/** Inject fetch/readBytes for offline tests. Production output contains only computed public-art fields.
 * Preflight the whole list, then keep at most one file/CAR in memory while uploading sequentially.
 */
export async function runPinRaw(options, dependencies = {}) {
  const { env = process.env, fetch = globalThis.fetch, readBytes: read = readBytes, onResult = () => {} } = dependencies;
  const { mode, timeoutMs = 60_000, baseDirectory = '.' } = options;
  if (!['dry-run', 'pin', 'check'].includes(mode)) fail('choose dry-run, pin or check');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) fail('timeout-ms must be an integer from 1 to 600000');
  const gateway = options.gateway === undefined ? undefined : gatewayOrigin(options.gateway);
  if (mode === 'check' && !gateway) fail('check needs a gateway');
  const { files, encoding } = parseManifest(options.manifest, baseDirectory);
  const readArt = async (file) => {
    try {
      const bytes = await read(file.path, MAX_RAW_BLOCK_BYTES);
      if (!(bytes instanceof Uint8Array) || bytes.length > MAX_RAW_BLOCK_BYTES) throw new Error();
      return bytes;
    } catch {
      fail(`file ${file.index}: cannot read art (regular file, at most 1 MiB required)`);
    }
  };
  const records = [];
  for (const file of files) {
    const bytes = await readArt(file);
    const hash = sha256(bytes);
    if (file.expected && file.expected !== hash) fail(`file ${file.index}: expected sha256 differs from local bytes`);
    records.push({ index: file.index, role: file.role, ...(file.id === undefined ? {} : { id: file.id }), bytes: bytes.length, sha256: hash, cid: rawCidV1(hash), encoding, upload: 'car-v1-raw' });
  }
  // No credential access at all for either offline computation or a gateway-only check.
  const key = mode === 'pin' ? await credential(options, env, read) : undefined;
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (mode === 'pin') {
      const bytes = await readArt(files[i]);
      if (sha256(bytes) !== record.sha256) fail(`file ${record.index}: bytes changed after preflight`);
      try {
        await upload(bytes, record.cid, key, fetch, timeoutMs);
      } catch (error) {
        if (error instanceof PinRawError) fail(`file ${record.index}: ${error.message}`);
        fail(`file ${record.index}: pin failed`);
      }
    }
    if (mode !== 'dry-run' && gateway) {
      try {
        await verifyGateway(gateway, record, fetch, timeoutMs);
      } catch (error) {
        if (error instanceof PinRawError) fail(`file ${record.index}: ${error.message}`);
        fail(`file ${record.index}: gateway check failed`);
      }
    }
    onResult({ ...record, status: mode === 'dry-run' ? 'computed' : gateway ? 'verified' : 'pinned' });
  }
}
