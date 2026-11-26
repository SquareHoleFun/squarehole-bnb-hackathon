// @vitest-environment node
/**
 * SH-ARWEAVE-PICTURES-SPIKE: the browser's type-3 data item, checked offline against an independent node:crypto deep
 * hash, the repo's own tag encoder (scripts/arweave/ans104.mjs) and pinned test values. No network.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hexToBytes, verifyMessage } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { HEADER_LENGTH, base64url, createEthDataItem, deepHash, encodeTags, itemSize, verifyEthDataItem, type Tag } from './ans104-eth';

// Fixed, public test keys (never a real wallet): RFC 6979 signing makes the items below reproducible.
const KEY_A = `0x${'11'.repeat(32)}` as const;
const KEY_B = `0x${'22'.repeat(32)}` as const;
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);
const SHA = createHash('sha256').update(PNG_BYTES).digest('hex');
const TAGS: readonly Tag[] = [
  { name: 'Content-Type', value: 'image/png' },
  { name: 'App-Name', value: 'Square Hole' },
  { name: 'SHA-256', value: SHA },
  { name: 'Box-Chain-Id', value: '11155111' },
];

// The repo's own encoder (node:crypto, untyped .mjs): the browser's must give the same bytes.
const { encodeTags: repoEncodeTags } = (await import('../../../../../scripts/arweave/ans104.mjs' as string)) as { encodeTags(tags: readonly Tag[]): Buffer };
const h384 = (b: Uint8Array) => createHash('sha384').update(b).digest();
type Deep = Uint8Array | readonly Deep[];
function referenceDeepHash(value: Deep): Buffer {
  if (Array.isArray(value)) return (value as readonly Deep[]).reduce<Buffer>((acc, child) => h384(Buffer.concat([acc, referenceDeepHash(child)])), h384(Buffer.from(`list${value.length}`)));
  const bytes = value as Uint8Array;
  return h384(Buffer.concat([h384(Buffer.from(`blob${bytes.length}`)), h384(bytes)]));
}

describe('ANS-104 type 3 (Ethereum) data item', () => {
  it('encodes tags byte for byte as scripts/arweave/ans104.mjs does, with its limits', () => {
    for (const tags of [TAGS, [], [{ name: 'Ü', value: 'ñ'.repeat(70) }], [{ name: 'Item-Id', value: '9007199254740993' }]]) {
      expect(Buffer.from(encodeTags(tags))).toEqual(repoEncodeTags(tags));
    }
    expect(() => encodeTags([{ name: 'x', value: 'a' }, { name: 'x', value: 'b' }])).toThrow(/tags/);
    expect(() => encodeTags([{ name: 'x', value: '' }])).toThrow(/tags/);
    expect(() => encodeTags([{ name: 'x', value: 'a'.repeat(4096) }])).toThrow(/tags/);
  });

  it('deep hash equals an independent node:crypto implementation', async () => {
    const parts = [Buffer.from('dataitem'), Buffer.from('1'), Buffer.from('3'), Buffer.alloc(65, 4), Buffer.alloc(0), Buffer.alloc(0), Buffer.from(encodeTags(TAGS)), Buffer.from(PNG_BYTES)];
    expect(Buffer.from(await deepHash(parts))).toEqual(referenceDeepHash(parts));
    expect(Buffer.from(await deepHash([]))).toEqual(referenceDeepHash([]));
  });

  it('lays out, signs (EIP-191 over the 48-byte deep hash) and names the item as the offline proof and Turbo do', async () => {
    const account = privateKeyToAccount(KEY_A);
    const item = await createEthDataItem(PNG_BYTES, TAGS, account);
    const bytes = Buffer.from(item.bytes);
    const rawTags = encodeTags(TAGS);
    expect(bytes.readUInt16LE(0)).toBe(3);
    const signature = bytes.subarray(2, 67);
    expect(bytes.subarray(67, 132)).toEqual(Buffer.from(hexToBytes(account.publicKey)));
    expect([bytes[132], bytes[133]]).toEqual([0, 0]);
    expect(bytes.readBigUInt64LE(134)).toBe(4n);
    expect(bytes.readBigUInt64LE(142)).toBe(BigInt(rawTags.length));
    expect(bytes.subarray(HEADER_LENGTH, HEADER_LENGTH + rawTags.length)).toEqual(Buffer.from(rawTags));
    expect(bytes.subarray(HEADER_LENGTH + rawTags.length)).toEqual(Buffer.from(PNG_BYTES));
    expect(bytes.length).toBe(itemSize(PNG_BYTES.length, TAGS));
    expect(item.id).toBe(createHash('sha256').update(signature).digest('base64url'));
    // The signature is the account's personal_sign of the independently computed deep hash.
    const message = referenceDeepHash([Buffer.from('dataitem'), Buffer.from('1'), Buffer.from('3'), bytes.subarray(67, 132), Buffer.alloc(0), Buffer.alloc(0), Buffer.from(rawTags), Buffer.from(PNG_BYTES)]);
    expect(await verifyMessage({ address: account.address, message: { raw: message }, signature: `0x${signature.toString('hex')}` })).toBe(true);
    // Pinned test values: a change in layout, tags or signing changes them.
    expect(account.address).toBe('0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A');
    expect(item.id).toBe('t2p4GOVpjQzJGhxqNKaYqFDIc1F9fJqFSgmm5gdlqPQ');
  });

  it('reads an item back and refuses one changed in its data or tags; the same key and item give the same id', async () => {
    const account = privateKeyToAccount(KEY_A);
    const item = await createEthDataItem(PNG_BYTES, TAGS, account);
    const parsed = await verifyEthDataItem(item.bytes);
    expect(parsed?.valid).toBe(true);
    expect(parsed?.id).toBe(item.id);
    expect(parsed?.tagCount).toBe(4);
    expect(Buffer.from(parsed?.data ?? [])).toEqual(Buffer.from(PNG_BYTES));
    const data = Uint8Array.from(item.bytes); data[data.length - 1] = (data[data.length - 1] ?? 0) ^ 1;
    expect((await verifyEthDataItem(data))?.valid).toBe(false);
    const tag = Uint8Array.from(item.bytes); tag[HEADER_LENGTH + 3] = (tag[HEADER_LENGTH + 3] ?? 0) ^ 1;
    expect((await verifyEthDataItem(tag))?.valid).toBe(false);
    expect((await createEthDataItem(PNG_BYTES, TAGS, account)).id).toBe(item.id);
    expect((await createEthDataItem(PNG_BYTES, TAGS, privateKeyToAccount(KEY_B))).id).not.toBe(item.id);
    const otherType = Uint8Array.from(item.bytes); otherType[0] = 1;
    expect(await verifyEthDataItem(otherType)).toBeNull();
    expect(await verifyEthDataItem(item.bytes.subarray(0, 100))).toBeNull();
  });

  it('refuses a compressed or wrong-length owner key and a short signature', async () => {
    const account = privateKeyToAccount(KEY_A);
    await expect(createEthDataItem(PNG_BYTES, TAGS, { publicKey: `0x02${'00'.repeat(32)}`, signMessage: account.signMessage })).rejects.toThrow(/uncompressed/);
    await expect(createEthDataItem(PNG_BYTES, TAGS, { publicKey: account.publicKey, signMessage: async () => '0x1234' })).rejects.toThrow(/65 bytes/);
  });

  it('base64url has no padding or + and /', () => {
    expect(base64url(Uint8Array.from([0xfb, 0xff, 0xfe]))).toBe('-__-');
  });
});
