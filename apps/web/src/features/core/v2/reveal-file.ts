/**
 * TA-50: the hidden-art creator's reveal file (create-model.ts `revealFile`), read back on the box page. The file lists
 * every item's number, packed traits, picture hash and salt, and the root they commit to. The page rebuilds the tree
 * from the list itself and keeps the file only when that tree's root is both the file's and the collection's own
 * (`revealRoot()` on chain), so a proof it hands the contract is one the contract accepts. Nothing here fetches a
 * picture: the file's picture hashes stay in memory and are never asked for (an item's picture is shown only once the
 * chain says it is revealed, by the hash the chain stored).
 */
import { boxLeaf, buildBoxTree, BOX_TREE_MAX_ITEMS, type BoxTree } from '@squarehole/artwork';
import type { Hex } from 'viem';
import type { ItemRevealV2 } from '../../../../../../packages/chain/src/core/v2';

/** The list format create-model.ts writes (`revealList`). */
export const REVEAL_LIST_FORMAT = 'squarehole.box-reveal-list/1';
/** Maximum retained reveal JSON (10,000 items are about 4 MB); asset bytes are discarded in bounded chunks. */
export const MAX_REVEAL_FILE_BYTES = 64 * 1024 * 1024;

const HASH = /^0x[0-9a-fA-F]{64}$/;
const RAW = /^(0|[1-9][0-9]{0,38})$/;

/** Why a file was not kept, in the page's words. */
export class RevealFileError extends Error {
  override readonly name = 'RevealFileError';
}

export interface RevealFile {
  /** The root the list builds, equal to the file's and the collection's. */
  readonly root: Hex;
  readonly n: number;
  /** The item's reveal with its proof (ids 1..n); null for any other number. */
  revealOf(id: bigint): ItemRevealV2 | null;
}

interface Entry { readonly traitsPacked: bigint; readonly imageHash: Hex; readonly avatarHash: Hex; readonly modelHash: Hex; readonly salt: Hex }

const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new RevealFileError('This is not a reveal file.');
  return value as Record<string, unknown>;
};
const hash = (value: unknown): Hex => {
  if (typeof value !== 'string' || !HASH.test(value)) throw new RevealFileError('This reveal file is damaged.');
  return value.toLowerCase() as Hex;
};

/**
 * Parses the file's text and checks it against the collection's committed root (`chainRoot`, read on chain) and its
 * size. Throws RevealFileError with one plain line when the file is not this box's.
 */
export function parseRevealFile(text: string, chainRoot: Hex, collectionSize: bigint): RevealFile {
  let body: Record<string, unknown>;
  try {
    body = record(JSON.parse(text));
    // Create's private BoxSpec backup embeds hidden art's complete reveal file.
    if (body.format === 'squarehole.boxspec/2') {
      const list = record(body.revealList);
      // Open BoxSpecs carry the root in the spec; private hidden backups carry it in the list too.
      body = { ...list, revealRoot: list.revealRoot ?? record(body.spec).revealRoot };
    }
  } catch (error) {
    if (error instanceof RevealFileError) throw error;
    throw new RevealFileError('This is not a reveal file.');
  }
  if (body.format !== REVEAL_LIST_FORMAT || !Array.isArray(body.items)) throw new RevealFileError('This is not a reveal file.');
  if (typeof body.n !== 'string' || !RAW.test(body.n)) throw new RevealFileError('This reveal file is damaged.');
  const n = Number(body.n);
  if (!Number.isSafeInteger(n) || n < 1 || n > BOX_TREE_MAX_ITEMS || body.items.length !== n) throw new RevealFileError('This reveal file is damaged.');
  if (BigInt(n) !== collectionSize) throw new RevealFileError('This reveal file is for another box.');
  const fileRoot = hash(body.revealRoot);
  if (fileRoot !== chainRoot.toLowerCase()) throw new RevealFileError('This reveal file is for another box.');
  const entries: Entry[] = body.items.map((raw, i) => {
    const item = record(raw);
    if (item.id !== String(i + 1) || typeof item.traitsPacked !== 'string' || !RAW.test(item.traitsPacked)) throw new RevealFileError('This reveal file is damaged.');
    const traitsPacked = BigInt(item.traitsPacked);
    if (traitsPacked >= 1n << 128n) throw new RevealFileError('This reveal file is damaged.');
    return { traitsPacked, imageHash: hash(item.imageSha256), avatarHash: hash(item.avatarSha256), modelHash: hash(item.modelSha256), salt: hash(item.salt) };
  });
  let tree: BoxTree;
  try {
    // Avatar and model are zero in every box today (create-model.ts `revealList`); a leaf commits them all the same.
    tree = buildBoxTree(entries.map((entry, i) => boxLeaf({ id: i + 1, traitsPacked: entry.traitsPacked, imageSha256: entry.imageHash, avatarSha256: entry.avatarHash, modelSha256: entry.modelHash, salt: entry.salt }, n)), n);
  } catch {
    throw new RevealFileError('This reveal file is damaged.');
  }
  if (tree.root.toLowerCase() !== fileRoot) throw new RevealFileError('This reveal file is damaged.');
  return {
    root: fileRoot,
    n,
    revealOf(id) {
      if (id < 1n || id > BigInt(n)) return null;
      const entry = entries[Number(id) - 1];
      if (!entry) return null;
      return { traitsPacked: entry.traitsPacked, imageHash: entry.imageHash, avatarHash: entry.avatarHash, modelHash: entry.modelHash, salt: entry.salt, proof: tree.proof(Number(id)) };
    },
  };
}

/** What the reader needs of a chosen file: its size and bounded reads (a browser File; a Blob in tests). */
export interface RevealFileSource {
  readonly size: number;
  slice(start?: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

/** Reads only recovery fields; pictures/models never become one string or a parsed object. */
export async function readRevealFile(file: RevealFileSource, chainRoot: Hex, collectionSize: bigint): Promise<RevealFile> {
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > 256 * 1024 * 1024) throw new RevealFileError('This file is too large to be a reveal file.');
  const fields = new Set(['format', 'spec', 'revealList', 'revealRoot', 'n', 'items']);
  const parts: string[] = ['{'];
  let retained = 0;
  const append = (part: string) => {
    // UTF-16 storage is bounded too, including hostile non-ASCII input.
    retained += part.length * 2;
    if (retained > MAX_REVEAL_FILE_BYTES) throw new RevealFileError('This file is too large to be a reveal file.');
    parts.push(part);
  };
  let phase: 'start' | 'key' | 'colon' | 'value' | 'done' = 'start';
  let key = '';
  let keyText = '';
  let quoted = false;
  let escaped = false;
  const stack: string[] = [];
  let capture = false;
  let first = true;
  let valueStarted = false;
  let afterComma = false;
  const seen = new Set<string>();
  const damaged = () => { throw new RevealFileError('This is not a reveal file.'); };
  // Blob.slice bounds each read even on browsers without File.stream(). No whole-file text() call.
  const chunkBytes = 64 * 1024;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for (let offset = 0; offset < file.size; offset += chunkBytes) {
      const chunk = decoder.decode(await file.slice(offset, offset + chunkBytes).arrayBuffer(), { stream: offset + chunkBytes < file.size });
      let from = capture ? 0 : -1;
      for (let i = 0; i < chunk.length; i++) {
        const c = chunk[i] as string;
        if (phase === 'value') {
          if (!quoted && stack.length === 0 && (c === ',' || c === '}')) {
            if (!valueStarted) damaged();
            if (capture) append(chunk.slice(from, i));
            capture = false; from = -1;
            phase = c === ',' ? 'key' : 'done';
            afterComma = c === ',';
            continue;
          }
          if (!valueStarted && !/\s/.test(c)) valueStarted = true;
          if (quoted) {
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === '"') quoted = false;
          } else if (c === '"') quoted = true;
          else if (c === '{' || c === '[') {
            stack.push(c === '{' ? '}' : ']');
            if (stack.length > 64) damaged();
          } else if (c === '}' || c === ']') {
            if (stack.pop() !== c) damaged();
          }
          continue;
        }
        if (phase === 'key' && (quoted || c === '"')) {
          keyText += c;
          if (keyText.length > 256) damaged();
          if (!quoted) quoted = true;
          else if (escaped) escaped = false;
          else if (c === '\\') escaped = true;
          else if (c === '"') {
            quoted = false;
            key = JSON.parse(keyText) as string;
            keyText = '';
            if (fields.has(key)) {
              if (seen.has(key)) damaged();
              seen.add(key);
            }
            phase = 'colon';
          }
          continue;
        }
        if (/\s/.test(c)) continue;
        if (phase === 'start' && c === '{') phase = 'key';
        else if (phase === 'key' && c === '}' && !afterComma) phase = 'done';
        else if (phase === 'colon' && c === ':') {
          phase = 'value'; valueStarted = false;
          capture = fields.has(key);
          if (capture) {
            append(`${first ? '' : ','}${JSON.stringify(key)}:`);
            first = false; from = i + 1;
          }
        } else damaged();
      }
      if (capture) append(chunk.slice(from));
    }
    if (phase !== 'done' || quoted || stack.length) damaged();
  } catch (error) {
    if (error instanceof RevealFileError) throw error;
    throw new RevealFileError('This is not a reveal file.');
  }
  parts.push('}');
  return parseRevealFile(parts.join(''), chainRoot, collectionSize);
}
