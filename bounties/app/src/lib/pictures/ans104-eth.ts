// SH-294: a copy of apps/web/src/features/pictures/ans104-eth.ts (the platform's own; the launch stage builds only bounties/,
// test/stage-imports.test.ts), unchanged. Change it there first, then here.
/**
 * SH-ARWEAVE-PICTURES-WEB (from the SH-ARWEAVE-PICTURES-SPIKE prototype): one ANS-104 data item signed by an Ethereum
 * key (signature type 3), built in the browser.
 *
 * The same layout and signing the offline proof verified (2026-10-24) and Turbo accepted live in the spike (8 free uploads):
 * - bytes: u16le type 3, 65-byte signature, 65-byte owner (the uncompressed secp256k1 key, 0x04 || X || Y), no target,
 *   no anchor, u64le tag count, u64le tag byte length, the Avro tags, then the payload unchanged;
 * - signed message: the 48-byte deep hash (SHA-384, "list"/"blob" prefixes) of
 *   ["dataitem", "1", "3", owner, target, anchor, raw tags, payload], signed with EIP-191 (`personal_sign` of the raw bytes);
 * - id: base64url(sha256(signature)).
 * Tags are encoded exactly as the repo's scripts/arweave/ans104.mjs `encodeTags` does (the tests compare both), in
 * Uint8Array form so the browser needs no node:crypto. Every hash is WebCrypto's.
 *
 * Sources: https://github.com/ArweaveTeam/arweave-standards/blob/master/ans/ANS-104.md and
 * https://github.com/Irys-xyz/arbundles (src/constants.ts, src/ar-data-base.ts, src/deepHash.ts,
 * src/signing/chains/ethereumSigner.ts), read 2026-10-24.
 */
import { bytesToHex, hashMessage, hexToBytes, recoverPublicKey, type Hex } from 'viem';

export interface Tag { readonly name: string; readonly value: string }
/** What signs an item: an account with its uncompressed public key (viem's `privateKeyToAccount` gives one). */
export interface ItemSigner {
  readonly publicKey: Hex;
  signMessage(args: { readonly message: { readonly raw: Uint8Array } }): Promise<Hex>;
}
export interface DataItem { readonly id: string; readonly bytes: Uint8Array }

export const ETHEREUM_SIGNATURE_TYPE = 3;
const SIG_LENGTH = 65;
const OWNER_LENGTH = 65;
/** Signature type, signature, owner, the two presence bytes, the tag count and the tag byte length. */
export const HEADER_LENGTH = 2 + SIG_LENGTH + OWNER_LENGTH + 1 + 1 + 8 + 8;
const MAX_TAGS = 128;
const MAX_TAG_BYTES = 4096;

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function concat(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/** WebCrypto digest of a copy (the digest never reads a shared or resizable buffer). */
async function digestOf(algorithm: 'SHA-256' | 'SHA-384', bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, new Uint8Array(bytes)));
}
export const sha256Of = (bytes: Uint8Array) => digestOf('SHA-256', bytes);
export const hexOf = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Avro long: zig-zag, then 7 bits a byte, low first (non-negative values only here). */
function avroLong(value: number): Uint8Array {
  let n = BigInt(value) << 1n;
  const bytes: number[] = [];
  do { bytes.push(Number(n & 127n) | (n > 127n ? 128 : 0)); n >>= 7n; } while (n);
  return Uint8Array.from(bytes);
}

/** The Avro tag array (scripts/arweave/ans104.mjs `encodeTags`, byte for byte): at most 128 unique, non-empty tags. */
export function encodeTags(tags: readonly Tag[]): Uint8Array<ArrayBuffer> {
  if (tags.length > MAX_TAGS) throw new Error('invalid ANS-104 tags');
  const seen = new Set<string>();
  const parts: Uint8Array[] = [];
  if (tags.length) parts.push(avroLong(tags.length));
  for (const tag of tags) {
    if (typeof tag?.name !== 'string' || !tag.name || typeof tag.value !== 'string' || !tag.value || seen.has(tag.name)) throw new Error('invalid ANS-104 tags');
    seen.add(tag.name);
    for (const text of [tag.name, tag.value]) {
      const bytes = utf8(text);
      parts.push(avroLong(bytes.length), bytes);
    }
  }
  parts.push(Uint8Array.of(0));
  const encoded = concat(...parts);
  if (encoded.length > MAX_TAG_BYTES) throw new Error('ANS-104 tags exceed limit');
  return encoded;
}

type Deep = Uint8Array | readonly Deep[];
const isList = (value: Deep): value is readonly Deep[] => Array.isArray(value);

/** Arweave's deep hash (SHA-384). */
export async function deepHash(value: Deep): Promise<Uint8Array> {
  if (isList(value)) {
    let acc = await digestOf('SHA-384', utf8(`list${value.length}`));
    for (const child of value) acc = await digestOf('SHA-384', concat(acc, await deepHash(child)));
    return acc;
  }
  return digestOf('SHA-384', concat(await digestOf('SHA-384', utf8(`blob${value.length}`)), await digestOf('SHA-384', value)));
}

const signingMessage = (owner: Uint8Array, rawTags: Uint8Array, data: Uint8Array) =>
  deepHash([utf8('dataitem'), utf8('1'), utf8(String(ETHEREUM_SIGNATURE_TYPE)), owner, new Uint8Array(0), new Uint8Array(0), rawTags, data]);

/** The size a signed item will have, before signing. */
export const itemSize = (payloadBytes: number, tags: readonly Tag[]): number => HEADER_LENGTH + encodeTags(tags).length + payloadBytes;

/** Signs `data` with `tags` as one type-3 data item. */
export async function createEthDataItem(data: Uint8Array, tags: readonly Tag[], signer: ItemSigner): Promise<DataItem> {
  const owner = hexToBytes(signer.publicKey);
  if (owner.length !== OWNER_LENGTH || owner[0] !== 4) throw new Error('owner must be an uncompressed secp256k1 key');
  const rawTags = encodeTags(tags);
  const message = await signingMessage(owner, rawTags, data);
  const signature = hexToBytes(await signer.signMessage({ message: { raw: message } }));
  if (signature.length !== SIG_LENGTH) throw new Error('signature must be 65 bytes');
  const head = new Uint8Array(HEADER_LENGTH);
  const view = new DataView(head.buffer);
  view.setUint16(0, ETHEREUM_SIGNATURE_TYPE, true);
  head.set(signature, 2);
  head.set(owner, 2 + SIG_LENGTH);
  // Bytes 132 and 133 stay 0: no target, no anchor.
  view.setBigUint64(2 + SIG_LENGTH + OWNER_LENGTH + 2, BigInt(tags.length), true);
  view.setBigUint64(2 + SIG_LENGTH + OWNER_LENGTH + 10, BigInt(rawTags.length), true);
  return { id: base64url(await sha256Of(signature)), bytes: concat(head, rawTags, data) };
}

export interface ParsedItem {
  readonly id: string;
  readonly owner: Uint8Array;
  readonly tagCount: number;
  readonly rawTags: Uint8Array;
  readonly data: Uint8Array;
  /** The signature recovers the owner key over the item's own deep hash. */
  readonly valid: boolean;
}

/** Reads a type-3 item back from its bytes alone and checks its signature (tests, and the publisher's own check). */
export async function verifyEthDataItem(bytes: Uint8Array): Promise<ParsedItem | null> {
  if (bytes.length < HEADER_LENGTH) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, true) !== ETHEREUM_SIGNATURE_TYPE) return null;
  const signature = bytes.subarray(2, 2 + SIG_LENGTH);
  const owner = bytes.subarray(2 + SIG_LENGTH, 2 + SIG_LENGTH + OWNER_LENGTH);
  let at = 2 + SIG_LENGTH + OWNER_LENGTH;
  if (bytes[at] !== 0 || bytes[at + 1] !== 0) return null;
  at += 2;
  const tagCount = view.getBigUint64(at, true);
  const tagBytes = view.getBigUint64(at + 8, true);
  at += 16;
  if (tagCount > BigInt(MAX_TAGS) || tagBytes > BigInt(MAX_TAG_BYTES) || BigInt(at) + tagBytes > BigInt(bytes.length)) return null;
  const rawTags = bytes.subarray(at, at + Number(tagBytes));
  const data = bytes.subarray(at + Number(tagBytes));
  const message = await signingMessage(owner, rawTags, data);
  let valid: boolean;
  try {
    const recovered = hexToBytes(await recoverPublicKey({ hash: hashMessage({ raw: message }), signature: bytesToHex(signature) }));
    valid = recovered.length === owner.length && recovered.every((byte, i) => byte === owner[i]);
  } catch {
    valid = false;
  }
  return { id: base64url(await sha256Of(signature)), owner, tagCount: Number(tagCount), rawTags, data, valid };
}
