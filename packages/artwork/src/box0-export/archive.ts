/**
 * The escrow archive of box 0's records (readiness plan steps 6 and 17): every id's attributes, traitsPacked, file
 * hashes and salt, plus the table bytes, encrypted with AES-256-GCM (node:crypto, 12-byte IV, full 16-byte tag) under
 * a 32-byte key the founder supplies from a file at run time. The public header (root, N, table and generator hashes,
 * the render generator tree, key id, escrow intent) is the cipher's additional data, so it cannot be swapped. Opening
 * the archive refuses a cut tag, rebuilds every leaf and the root, and checks the table bytes against the header and
 * every record's attributes against its traitsPacked: it is the escrow's self-test, possibly years later.
 *
 * F115 R30P chooses three trustees (the default). The header records that intent; the key split comes after sealing,
 * because the split is verified against the sealed archive. `ArchiveKeySplit` is the hook, `NO_KEY_SPLIT` does nothing
 * and says so, and key-split.ts is the gate: trustee escrow only through the verified 2-of-3 splitter (trustees.ts).
 * The key is never printed, logged or written by this code.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { boxLeaf, buildBoxTree } from '../box-commitment';
import type { Hex32 } from '../hash';
import { canonicalJson } from '../manifest';
import type { MetadataTable } from '../misfits-commitment';
import type { Box0Commitment } from './commitment';
import { decodeTableBytes } from './table-bytes';
import { attributesOf, valueOrderHash, type Attribute } from './traits';

export const ARCHIVE_FORMAT = 'squarehole.box0-records-archive/1';
export const RECORDS_FORMAT = 'squarehole.box0-records/1';
/** MF-16's three answers; F115 R30P selects trustees. */
export const ESCROW_MODES = ['zama-plus-floor', 'trustees-2-of-3', 'floor-only'] as const;
export type EscrowMode = (typeof ESCROW_MODES)[number];
export const DEFAULT_ESCROW: EscrowMode = 'trustees-2-of-3';
export const isEscrowMode = (value: unknown): value is EscrowMode => (ESCROW_MODES as readonly unknown[]).includes(value);

/** One of MF-16's answers. Which key split may stand behind it is key-split.ts's `assertEscrowAvailable`. */
export function assertEscrowMode(escrowIntent: EscrowMode): void {
  if (!isEscrowMode(escrowIntent)) throw new Error(`the escrow intent must be one of ${ESCROW_MODES.join(', ')} (MF-16)`);
}
const CIPHER = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID_DOMAIN = 'squarehole.box0-records-archive/key-id/1';

/** String-only (canonical JSON is the cipher's additional data). */
export interface ArchiveHeader {
  readonly [field: string]: string;
  readonly format: string;
  readonly cipher: string;
  readonly keyId: Hex32;
  /** MF-16's answer: who is meant to keep the key. Not a split: the public file's keySplit says whether one was made. */
  readonly escrowIntent: EscrowMode;
  readonly n: string;
  readonly depth: string;
  readonly root: Hex32;
  readonly tableHash: Hex32;
  readonly valueOrderHash: Hex32;
  readonly generatorHash: Hex32;
  /** The committed tree; '' when MF-17 chose generatorHash = 0. */
  readonly generatorTree: string;
  /** The tree that rendered the committed files (the render file's header), in either MF-17 mode. */
  readonly renderGeneratorTree: string;
  readonly platform: string;
  /** JSON of the render encoding. */
  readonly encoding: string;
}

export interface ArchivedRecord {
  readonly id: number;
  readonly attributes: readonly Attribute[];
  /** Decimal string. */
  readonly traitsPacked: string;
  readonly imageSha256: Hex32;
  readonly avatarSha256: Hex32;
  readonly modelSha256: Hex32;
  readonly salt: Hex32;
  readonly bytes: { readonly image: number; readonly avatar: number | null; readonly model: number };
}

export interface ArchivePayload {
  readonly format: string;
  /** The metadata table bytes, 0x hex. */
  readonly table: string;
  /** sha256 of each input file, when the caller gives them. */
  readonly inputs: Readonly<Record<string, string>>;
  readonly records: readonly ArchivedRecord[];
}

export interface SealedArchive {
  /** The archive file's text. */
  readonly text: string;
  /** sha256 of `text` (UTF-8). */
  readonly sha256: Hex32;
  readonly header: ArchiveHeader;
}

export interface OpenedArchive extends ArchivePayload {
  readonly header: ArchiveHeader;
  readonly root: Hex32;
}

/** 32 raw bytes, or 64 hex digits (optional 0x and surrounding whitespace). Text that is not hex is refused. */
export function parseArchiveKey(content: Uint8Array): Uint8Array {
  let key: Uint8Array | undefined;
  // Text remains text when echo or an editor adds whitespace (TAB, LF, VT, FF, CR).
  const textBytes = content.every((b) => (b >= 0x20 && b <= 0x7e) || (b >= 0x09 && b <= 0x0d));
  if (content.length === 32 && !textBytes) key = new Uint8Array(content);
  else {
    const text = new TextDecoder().decode(content).trim();
    if (/^(?:0x)?[0-9a-fA-F]{64}$/.test(text)) key = hexToBytes(text.replace(/^0x/i, ''));
  }
  if (!key) throw new Error('the key file must hold 32 raw bytes or 64 hex digits (a passphrase is not a key)');
  const first = key[0];
  if (key.every((b) => b === first)) throw new Error('the key must not be one repeated byte');
  return key;
}

/** A one-way name for a key: sha256(domain ‖ 0x00 ‖ key). Safe to show for a random 256-bit key. */
export function archiveKeyId(key: Uint8Array): Hex32 {
  return `0x${createHash('sha256').update(KEY_ID_DOMAIN).update(Uint8Array.of(0)).update(key).digest('hex')}`;
}

const sha256Text = (text: string): Hex32 => `0x${createHash('sha256').update(text, 'utf8').digest('hex')}`;
const aad = (header: ArchiveHeader) => Buffer.from(canonicalJson(header), 'utf8');

/** Encrypts `payload` under `key` with `header` as additional data; returns the archive file's text. */
export function sealPayload(payload: ArchivePayload, header: ArchiveHeader, key: Uint8Array): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(header));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const file = { format: ARCHIVE_FORMAT, header, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
  return `${JSON.stringify(file, null, 1)}\n`;
}

export function sealArchive(
  c: Box0Commitment,
  key: Uint8Array,
  options: { readonly escrowIntent?: EscrowMode; readonly inputs?: Readonly<Record<string, string>> } = {},
): SealedArchive {
  if (c.testSalts) throw new Error('test salts never go into an escrow archive');
  const escrowIntent = options.escrowIntent ?? DEFAULT_ESCROW;
  assertEscrowMode(escrowIntent);
  const header: ArchiveHeader = {
    format: ARCHIVE_FORMAT,
    cipher: CIPHER,
    keyId: archiveKeyId(key),
    escrowIntent,
    n: String(c.n),
    depth: String(c.depth),
    root: c.root,
    tableHash: c.tableHash,
    valueOrderHash: c.valueOrderHash,
    generatorHash: c.generatorHash,
    generatorTree: c.generatorTree ?? '',
    renderGeneratorTree: c.render.generatorTree,
    platform: c.render.platform,
    encoding: JSON.stringify(c.render.encoding),
  };
  const records: ArchivedRecord[] = c.records.map((r) => ({
    id: r.id,
    attributes: r.attributes,
    traitsPacked: r.traitsPacked.toString(),
    imageSha256: r.imageSha256,
    avatarSha256: r.avatarSha256,
    modelSha256: r.modelSha256,
    salt: r.salt,
    bytes: r.bytes,
  }));
  const text = sealPayload({ format: RECORDS_FORMAT, table: `0x${bytesToHex(c.table.bytes)}`, inputs: options.inputs ?? {}, records }, header, key);
  return { text, sha256: sha256Text(text), header };
}

function parseFile(text: string): { header: ArchiveHeader; iv: Buffer; tag: Buffer; ciphertext: Buffer } {
  let file: { format?: unknown; header?: unknown; iv?: unknown; tag?: unknown; ciphertext?: unknown };
  try {
    file = JSON.parse(text) as typeof file;
  } catch {
    throw new Error(`not a ${ARCHIVE_FORMAT} file (not JSON)`);
  }
  const header = file.header as Record<string, unknown> | undefined;
  if (file.format !== ARCHIVE_FORMAT || typeof header !== 'object' || header === null || header.format !== ARCHIVE_FORMAT) {
    throw new Error(`not a ${ARCHIVE_FORMAT} file`);
  }
  if (!Object.values(header).every((v) => typeof v === 'string')) throw new Error('the archive header must hold strings only');
  if (typeof file.iv !== 'string' || typeof file.tag !== 'string' || typeof file.ciphertext !== 'string') throw new Error('the archive needs iv, tag and ciphertext');
  return { header: header as ArchiveHeader, iv: Buffer.from(file.iv, 'base64'), tag: Buffer.from(file.tag, 'base64'), ciphertext: Buffer.from(file.ciphertext, 'base64') };
}

/**
 * The archived table bytes against the header (tableHash, valueOrderHash) and every record against its position and
 * its traitsPacked. The attributes are not in the leaf, so the root cannot catch a wrong one. Errors name ids only.
 */
function checkRecords(payload: ArchivePayload, header: ArchiveHeader): void {
  if (typeof payload.table !== 'string' || !/^0x(?:[0-9a-f]{2})+$/.test(payload.table)) throw new Error('the archived table must be 0x hex');
  const bytes = hexToBytes(payload.table.slice(2));
  if (`0x${bytesToHex(keccak_256(bytes))}` !== header.tableHash) throw new Error("the archived table does not hash to the header's table hash");
  const table: MetadataTable = decodeTableBytes(bytes);
  if (valueOrderHash(table) !== header.valueOrderHash) throw new Error("the archived table's value order hash is not the header's");
  const pairs = (list: readonly Attribute[]) => JSON.stringify(list.map((a) => [a.trait_type, a.value]));
  payload.records.forEach((r, i) => {
    if (!Array.isArray(r.attributes) || pairs(r.attributes) !== pairs(attributesOf(BigInt(r.traitsPacked), table))) {
      throw new Error(`id ${i + 1}: the archived attributes are not what its traitsPacked says`);
    }
  });
}

/** N records, each at position id − 1 with a decimal traitsPacked (BigInt's own error would quote anything else). */
function checkPositions(records: readonly ArchivedRecord[], n: number): void {
  if (records.length !== n) throw new Error(`the archive holds ${records.length} records; its header says N = ${n}`);
  records.forEach((r, i) => {
    if (r.id !== i + 1) throw new Error(`the archive's record ${i + 1} is not id ${i + 1}`);
    if (typeof r.traitsPacked !== 'string' || !/^[0-9]{1,39}$/.test(r.traitsPacked)) throw new Error(`id ${i + 1}: the archived traitsPacked is not a decimal string`);
  });
}

/**
 * Decrypts the archive, rebuilds the root from its records and checks the table and every record's attributes; refuses
 * another key, a cut tag, any change, a wrong root, and records that disagree with their table or traitsPacked.
 */
export function openArchive(text: string, key: Uint8Array): OpenedArchive {
  const { header, iv, tag, ciphertext } = parseFile(text);
  if (header.keyId !== archiveKeyId(key)) throw new Error("this key is not the archive's key (the key ids differ)");
  // Node accepts a GCM tag of 4 to 16 bytes unless told otherwise: a cut tag would weaken the forgery bound to 2^-32.
  if (tag.length !== TAG_BYTES) throw new Error(`the archive's tag must be ${TAG_BYTES} bytes`);
  if (iv.length !== IV_BYTES) throw new Error(`the archive's iv must be ${IV_BYTES} bytes`);
  let plain: string;
  try {
    const decipher = createDecipheriv(CIPHER, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(header));
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('cannot open the archive: wrong key or a changed file');
  }
  let payload: ArchivePayload;
  try {
    payload = JSON.parse(plain) as ArchivePayload;
  } catch {
    throw new Error(`the archive's plaintext is not ${RECORDS_FORMAT} JSON`); // never quote the secret plaintext
  }
  if (payload.format !== RECORDS_FORMAT || !Array.isArray(payload.records)) throw new Error(`the archive does not hold ${RECORDS_FORMAT}`);
  const n = Number(header.n);
  checkPositions(payload.records, n);
  const leaves = payload.records.map((r) => boxLeaf({ ...r, traitsPacked: BigInt(r.traitsPacked) }, n));
  const root = buildBoxTree(leaves, n).root;
  if (root !== header.root) throw new Error("the records do not rebuild the archive's root");
  checkRecords(payload, header);
  return { ...payload, header, root };
}

export interface KeySplitContext {
  /** sha256 of the archive file the key opens. */
  readonly archiveSha256: Hex32;
  readonly keyId: Hex32;
  readonly escrowIntent: EscrowMode;
  /** The sealed archive's text, for a splitter that proves recovery against it (the trustee splitter requires it). */
  readonly archiveText?: string;
}

export interface SplitReceipt {
  readonly scheme: string;
  readonly note: string;
}

/**
 * The hook for K5's key split (for example 2-of-3 shares, or handing the key to an add-on). A splitter gets the key and
 * the archive's identity once, before any export outputs are written, and must write shares only where the founder
 * chose; it must never print or log keys or shares. Run it through key-split.ts `runKeySplit`: trustee escrow passes
 * only with the 2-of-3 trustee splitter (trustees.ts) and its verified receipt.
 */
export interface ArchiveKeySplit {
  readonly scheme: string;
  split(key: Uint8Array, context: KeySplitContext): SplitReceipt | Promise<SplitReceipt>;
}

export const NO_KEY_SPLIT: ArchiveKeySplit = {
  scheme: 'none',
  split: () => ({ scheme: 'none', note: "not split: explicit non-trustee K5 (MF-16) mode; the key stays in the founder's key file" }),
};
