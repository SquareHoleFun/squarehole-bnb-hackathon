import assert from 'node:assert/strict';
import { constants, createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import test from 'node:test';
import { createDataItem, dataItemSize, encodeTags } from './ans104.mjs';

// Ephemeral test-only key objects; no private material is exported or persisted.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 4096 });
const h384 = (b) => createHash('sha384').update(b).digest();
function referenceHash(value) {
  if (Array.isArray(value)) return value.reduce((acc, child) => h384(Buffer.concat([acc, referenceHash(child)])), h384(Buffer.from(`list${value.length}`)));
  return h384(Buffer.concat([h384(Buffer.from(`blob${value.length}`)), h384(value)]));
}

test('ANS-104 RSA item has independently verified wire layout, signature, tags and id', () => {
  const data = Buffer.from('obviously fake published bytes');
  const tags = [{ name: 'Content-Type', value: 'image/webp' }, { name: 'Item-Id', value: '9007199254740993' }];
  const item = createDataItem(data, tags, privateKey);
  const bytes = item.bytes;
  assert.equal(bytes.readUInt16LE(0), 1);
  assert.deepEqual(bytes.subarray(514, 1026), Buffer.from(publicKey.export({ format: 'jwk' }).n, 'base64url'));
  assert.deepEqual([...bytes.subarray(1026, 1028)], [0, 0]);
  assert.equal(bytes.readBigUInt64LE(1028), 2n);
  const tagBytes = encodeTags(tags);
  assert.equal(bytes.readBigUInt64LE(1036), BigInt(tagBytes.length));
  assert.deepEqual(tagBytes, Buffer.concat([Buffer.from([4, 24]), Buffer.from('Content-Type'), Buffer.from([20]), Buffer.from('image/webp'), Buffer.from([14]), Buffer.from('Item-Id'), Buffer.from([32]), Buffer.from('9007199254740993'), Buffer.from([0])]));
  assert.deepEqual(bytes.subarray(1044, 1044 + tagBytes.length), tagBytes);
  assert.deepEqual(bytes.subarray(1044 + tagBytes.length), data);
  const digest = referenceHash(['dataitem', '1', '1'].map((s) => Buffer.from(s)).concat([bytes.subarray(514, 1026), Buffer.alloc(0), Buffer.alloc(0), tagBytes, data]));
  assert.equal(verify('sha256', digest, { key: createPublicKey(privateKey), padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, bytes.subarray(2, 514)), true);
  assert.equal(item.id, createHash('sha256').update(bytes.subarray(2, 514)).digest('base64url'));
  assert.equal(BigInt(bytes.length), dataItemSize(BigInt(data.length), tags));
  const changed = Buffer.from(digest); changed[0] ^= 1;
  assert.equal(verify('sha256', changed, { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, bytes.subarray(2, 514)), false);
});

test('rejects other key types/sizes and oversized or duplicate tags', () => {
  const small = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  assert.throws(() => createDataItem(Buffer.from('fake'), [], small), /4096/);
  assert.throws(() => encodeTags([{ name: 'x', value: 'a' }, { name: 'x', value: 'b' }]), /tags/);
  assert.throws(() => encodeTags([{ name: 'x', value: 'a'.repeat(4096) }]), /tags/);
});
