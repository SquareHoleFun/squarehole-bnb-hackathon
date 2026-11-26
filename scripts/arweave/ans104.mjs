import { constants, createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { fail, readBytes, MAX_FILE } from './common.mjs';

const digest = (value) => createHash('sha384').update(value).digest();
function deepHash(value) {
  if (Array.isArray(value)) return value.reduce((acc, child) => digest(Buffer.concat([acc, deepHash(child)])), digest(Buffer.from(`list${value.length}`)));
  return digest(Buffer.concat([digest(Buffer.from(`blob${value.length}`)), digest(value)]));
}

function avroLong(value) {
  let n = BigInt(value) << 1n;
  const bytes = [];
  do { bytes.push(Number(n & 127n) | (n > 127n ? 128 : 0)); n >>= 7n; } while (n);
  return Buffer.from(bytes);
}

export function encodeTags(tags) {
  if (!Array.isArray(tags) || tags.length > 128) fail('invalid ANS-104 tags');
  const seen = new Set();
  const parts = [];
  if (tags.length) parts.push(avroLong(tags.length));
  for (const tag of tags) {
    if (typeof tag?.name !== 'string' || !tag.name || typeof tag.value !== 'string' || !tag.value || seen.has(tag.name)) fail('invalid ANS-104 tags');
    seen.add(tag.name);
    for (const s of [tag.name, tag.value]) {
      const bytes = Buffer.from(s, 'utf8');
      parts.push(avroLong(bytes.length), bytes);
    }
  }
  parts.push(Buffer.from([0]));
  const encoded = Buffer.concat(parts);
  if (encoded.length > 4096) fail('ANS-104 tags exceed limit');
  return encoded;
}

export function dataItemSize(payloadSize, tags) {
  return 1044n + BigInt(encodeTags(tags).length) + payloadSize;
}

export async function loadArweaveKey(env) {
  let bytes;
  try {
    bytes = await readBytes(env.SH_ARWEAVE_KEY_FILE, 16_384);
    const jwk = JSON.parse(bytes.toString('utf8'));
    if (jwk.kty !== 'RSA' || jwk.e !== 'AQAB' || typeof jwk.d !== 'string') throw new Error();
    return createPrivateKey({ key: jwk, format: 'jwk' });
  } catch { fail('cannot load Arweave RSA JWK from runtime key-file environment variable'); }
  finally { bytes?.fill(0); }
}

/** ANS-104 signature type 1, no target or anchor, Avro tags, unmodified payload.
 * Signing material never leaves KeyObject/JWK memory or enters a checkpoint.
 */
export function createDataItem(payload, tags, key) {
  if (!(payload instanceof Uint8Array) || !payload.length || payload.length > MAX_FILE) fail('invalid data item payload size');
  if (key?.type !== 'private' || key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength !== 4096
      || key.asymmetricKeyDetails.publicExponent !== 65537n) fail('Arweave requires a 4096-bit RSA private key with exponent 65537');
  const owner = Buffer.from(createPublicKey(key).export({ format: 'jwk' }).n, 'base64url');
  const encoded = encodeTags(tags);
  const message = deepHash([Buffer.from('dataitem'), Buffer.from('1'), Buffer.from('1'), owner, Buffer.alloc(0), Buffer.alloc(0), encoded, Buffer.from(payload)]);
  let signature;
  try { signature = sign('sha256', message, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }); }
  catch { fail('data item signing failed; details suppressed'); }
  const prefix = Buffer.alloc(1044);
  prefix.writeUInt16LE(1, 0);
  signature.copy(prefix, 2); owner.copy(prefix, 514);
  prefix.writeBigUInt64LE(BigInt(tags.length), 1028);
  prefix.writeBigUInt64LE(BigInt(encoded.length), 1036);
  return { id: createHash('sha256').update(signature).digest('base64url'), bytes: Buffer.concat([prefix, encoded, payload]) };
}
