/**
 * The share file of box 0's 2-of-3 trustee key split (F115 R30P; F122 R37E: Privy's audited shamir-secret-sharing
 * 0.0.4), and recovery from any two of them.
 *
 * A share is what `split(key, 3, 2)` returns for one trustee: 33 bytes, the key's 32 bytes as y values over GF(2^8)
 * (x^8 + x^4 + x^3 + x + 1) followed by the share's x coordinate. Its file (`squarehole.box0-archive-key-share/1`) holds
 * the share in base64 and only public facts beside it: the trustee number, the key id, the archive's sha256, the split
 * id (shared by the three shares of one split) and a checksum: sha256 of the canonical JSON of those fields and a
 * domain. The checksum catches a damaged or edited file; anyone can recompute it, so the proof of a share is recovery:
 * the rebuilt key must have the archive's key id and open the archive with its own check.
 *
 * Messages name share files by position and trustee number, never a key or share byte; JSON errors (which quote their
 * input) are not passed on.
 */
import { createHash } from 'node:crypto';
import { combine } from 'shamir-secret-sharing';
import type { Hex32 } from '../hash';
import { canonicalJson } from '../manifest';
import { archiveKeyId, openArchive, type OpenedArchive } from './archive';
import { Refusal } from './safe-paths';

export const TRUSTEE_SCHEME = 'shamir-2-of-3';
export const SHARE_FORMAT = 'squarehole.box0-archive-key-share/1';
export const TRUSTEES = 3;
export const THRESHOLD = 2;
export const KEY_BYTES = 32;
const SHARE_BYTES = KEY_BYTES + 1;
const CHECKSUM_DOMAIN = 'squarehole.box0-archive-key-share/checksum/1';
const HEX32 = /^0x[0-9a-f]{64}$/;
const SPLIT_ID = /^0x[0-9a-f]{32}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const ABOUT =
  "One of three shares of the key of box 0's records archive (box0-records.enc.json), split 2-of-3 with shamir-secret-sharing 0.0.4. " +
  'Any two trustees\' shares and the archive rebuild the key: node scripts/box/box0-commitment.mjs recover --share <this file> --share <another trustee\'s file> --archive box0-records.enc.json. ' +
  'One share alone reveals nothing about the key. Keep this file private and apart from the other shares. ' +
  'share: base64 of 33 bytes, the 32 key bytes as y values over GF(2^8) (x^8+x^4+x^3+x+1) followed by the x coordinate.';

export const shareFileName = (trustee: number): string => `box0-archive-key-share-${trustee}-of-${TRUSTEES}.json`;

export const sha256Hex = (data: Uint8Array | string): Hex32 => `0x${createHash('sha256').update(data).digest('hex')}`;

/** A share file's fields (the checksum and the about line aside). */
export interface ShareFields {
  readonly format: typeof SHARE_FORMAT;
  readonly scheme: typeof TRUSTEE_SCHEME;
  readonly trustee: number;
  readonly keyId: Hex32;
  readonly archiveSha256: Hex32;
  readonly splitId: Hex32;
  /** base64 of the 33 share bytes. */
  readonly share: string;
}

export interface ParsedShare extends ShareFields {
  /** The share bytes; zeroed by whoever parsed them once used. */
  readonly bytes: Uint8Array;
}

function shareChecksum(f: ShareFields): Hex32 {
  const { format, scheme, keyId, archiveSha256, splitId, share } = f;
  return sha256Hex(canonicalJson({ domain: CHECKSUM_DOMAIN, format, scheme, trustee: String(f.trustee), keyId, archiveSha256, splitId, share }));
}

/** The share file's text (pretty JSON). */
export function shareFileText(fields: ShareFields): string {
  const { format, scheme, trustee, keyId, archiveSha256, splitId, share } = fields;
  const file = { format, about: ABOUT, scheme, trustee, keyId, archiveSha256, splitId, share, shareChecksum: shareChecksum(fields) };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Parses share file number `position` (1-based, as given); refuses any field out of shape and a wrong checksum. */
export function parseShareFile(text: string, position: number): ParsedShare {
  const label = `share file ${position}`;
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    throw new Refusal(`${label} is not valid JSON`);
  }
  if (typeof file !== 'object' || file === null || Array.isArray(file)) throw new Refusal(`${label} is not a ${SHARE_FORMAT} file`);
  const f = file as Record<string, unknown>;
  if (f.format !== SHARE_FORMAT) throw new Refusal(`${label} is not a ${SHARE_FORMAT} file`);
  if (f.scheme !== TRUSTEE_SCHEME) throw new Refusal(`${label} is not a ${TRUSTEE_SCHEME} share`);
  const trustee = f.trustee;
  if (trustee !== 1 && trustee !== 2 && trustee !== 3) throw new Refusal(`${label}'s trustee must be 1, 2 or 3`);
  const { keyId, archiveSha256, splitId, share } = f;
  if (typeof keyId !== 'string' || !HEX32.test(keyId)) throw new Refusal(`${label}'s keyId must be 0x and 64 lower-case hex digits`);
  if (typeof archiveSha256 !== 'string' || !HEX32.test(archiveSha256)) throw new Refusal(`${label}'s archiveSha256 must be 0x and 64 lower-case hex digits`);
  if (typeof splitId !== 'string' || !SPLIT_ID.test(splitId)) throw new Refusal(`${label}'s splitId must be 0x and 32 lower-case hex digits`);
  if (typeof share !== 'string' || !BASE64.test(share)) throw new Refusal(`${label}'s share must be ${SHARE_BYTES} bytes in base64`);
  const raw = Buffer.from(share, 'base64');
  try {
    if (raw.length !== SHARE_BYTES || raw.toString('base64') !== share) throw new Refusal(`${label}'s share must be ${SHARE_BYTES} bytes in base64`);
    const fields: ShareFields = { format: SHARE_FORMAT, scheme: TRUSTEE_SCHEME, trustee, keyId: keyId as Hex32, archiveSha256: archiveSha256 as Hex32, splitId: splitId as Hex32, share };
    if (f.shareChecksum !== shareChecksum(fields)) throw new Refusal(`${label} (trustee ${trustee}) does not match its checksum: the file was changed or damaged`);
    // A plain Uint8Array: the library refuses a Buffer.
    return { ...fields, bytes: new Uint8Array(raw) };
  } finally {
    raw.fill(0);
  }
}

/** The archive key, rebuilt in memory. The caller zeroes `key` (fill(0)) when done and never prints or writes it. */
export interface RecoveredKey {
  readonly key: Uint8Array;
  readonly keyId: Hex32;
  readonly archiveSha256: Hex32;
  readonly splitId: Hex32;
  /** The two trustees' numbers, in the order given. */
  readonly trustees: readonly [number, number];
  /** The archive, opened and checked with the rebuilt key (records, table, root). */
  readonly opened: OpenedArchive;
}

/** Two parsed shares → the key, checked by key id and by opening the archive (its own check). */
export async function recoverFromShares(a: ParsedShare, b: ParsedShare, archiveText: string): Promise<RecoveredKey> {
  if (a.trustee === b.trustee) throw new Refusal(`both share files are trustee ${a.trustee}'s: the shares of two trustees are needed`);
  if (a.keyId !== b.keyId) throw new Refusal('the share files are shares of different keys (their key ids differ)');
  if (a.archiveSha256 !== b.archiveSha256) throw new Refusal('the share files were made for different archives');
  if (a.splitId !== b.splitId) throw new Refusal('the share files come from different splits: give two shares of the same split (a trustee change makes a new split)');
  if (sha256Hex(archiveText) !== a.archiveSha256) throw new Refusal('the archive is not the one these shares were made for (its sha256 differs)');
  let key: Uint8Array;
  try {
    key = await combine([a.bytes, b.bytes]);
  } catch {
    throw new Refusal('the two shares cannot be combined (the same share point twice, or damaged shares)');
  }
  try {
    if (key.length !== KEY_BYTES || archiveKeyId(key) !== a.keyId) {
      throw new Refusal("the shares do not rebuild the archive's key (the key ids differ): a share was changed or comes from another split");
    }
    let opened: OpenedArchive;
    try {
      opened = openArchive(archiveText, key);
    } catch (error) {
      // openArchive's messages name ids and fields only.
      throw new Refusal(`the rebuilt key does not open the archive: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    return { key, keyId: a.keyId, archiveSha256: a.archiveSha256, splitId: a.splitId, trustees: [a.trustee, b.trustee], opened };
  } catch (error) {
    key.fill(0);
    throw error;
  }
}

/**
 * Rebuilds the archive key from exactly two share files' texts and the archive's text, in memory: the files must be
 * two trustees' shares of the same split, made for this archive; the rebuilt key must have the archive's key id and
 * open the archive with its own check. One share alone is refused (it reveals nothing about the key).
 */
export async function recoverArchiveKey(shareTexts: readonly string[], archiveText: string): Promise<RecoveredKey> {
  if (shareTexts.length < THRESHOLD) {
    throw new Refusal(`two share files are needed: ${shareTexts.length === 1 ? 'one share alone cannot rebuild the key' : 'none was given'}`);
  }
  if (shareTexts.length > THRESHOLD) throw new Refusal("give exactly two share files (any two trustees' shares)");
  const parsed: ParsedShare[] = [];
  try {
    shareTexts.forEach((text, i) => parsed.push(parseShareFile(text, i + 1)));
    return await recoverFromShares(parsed[0] as ParsedShare, parsed[1] as ParsedShare, archiveText);
  } finally {
    parsed.forEach((p) => p.bytes.fill(0));
  }
}
