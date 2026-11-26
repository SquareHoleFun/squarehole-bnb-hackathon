/**
 * Box 0's 2-of-3 trustee key split (K5 / MF-16; F115 R30P "trustees": "give them to me and I will hand them to three
 * trustees"; F122 R37E: built on Privy's audited shamir-secret-sharing 0.0.4). `TrusteeKeySplit` splits the 32-byte
 * archive key with split(key, 3, 2) and writes each share (trustee-shares.ts) into its own new trustee folder that the
 * founder names (chmod folder 0700, file 0600; F124 R39A allows sticks that ignore the modes, with a warning): three
 * distinct folders, none the export folder or nested with it or with another, none inside a git working tree, none
 * holding another secret output of the run. Names are compared as a
 * case-insensitive disk compares them (APFS: case and Unicode form aside). The folders are checked when the splitter is
 * made, before any secret is read, and again by identity on disk (device and inode) once they exist.
 *
 * Each share is written under a provisional name (`<share file>.partial`) and fsynced with its folder. Before
 * reporting success the splitter reads the three files back and proves that every two of them (1+2, 1+3, 2+3) rebuild
 * the key, match its key id and open the sealed archive with its own check; it also runs the refusal rules (one share
 * alone; a share of a second split of the same key). Only then does it return a frozen receipt (scheme, key id, archive
 * sha256, split id, each share file's sha256 and permissionsKept, the proofs and the guards), registered as verified
 * for key-split.ts. The caller writes its own outputs, then calls `commit()`, which gives the shares their final names; a run that stops
 * earlier leaves only provisional files. On any failure, and on `discard()`, it removes the files and folders it made.
 * Its messages name trustees, folders and fields, never a key or share byte; it prints only permission warnings.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { combine, split } from 'shamir-secret-sharing';
import type { Hex32 } from '../hash';
import { archiveKeyId, openArchive, type ArchiveKeySplit, type KeySplitContext, type SplitReceipt } from './archive';
import { Refusal, assertWritableParent, gitWorkTreeOf, isTaken, realPathOf } from './safe-paths';
import {
  KEY_BYTES,
  SHARE_FORMAT,
  THRESHOLD,
  TRUSTEES,
  TRUSTEE_SCHEME,
  parseShareFile,
  recoverArchiveKey,
  recoverFromShares,
  sha256Hex,
  type RecoveredKey,
  shareFileName,
  shareFileText,
  type ParsedShare,
} from './trustee-shares';

export { SHARE_FORMAT, TRUSTEE_SCHEME, recoverArchiveKey, shareFileName, type RecoveredKey } from './trustee-shares';

export const RECEIPT_FORMAT = 'squarehole.box0-key-split-receipt/1';
const PAIRS = [
  [0, 1],
  [0, 2],
  [1, 2],
] as const;
/** A share file's name until the caller commits the split: a run that stops before then leaves no final-named share. */
const PENDING = '.partial';
const pendingFileName = (trustee: number): string => `${shareFileName(trustee)}${PENDING}`;

export interface TrusteeFolders {
  /** The three trustee folders, in trustee order: new folders whose parent exists, outside every git working tree. */
  readonly destinations: readonly string[];
  /** The export folder (on a re-split, the archive's folder): no trustee folder may be it or be nested with it. */
  readonly exportDir: string;
  /** The run's other secret outputs (the plain records file): none may lie in a trustee folder. */
  readonly otherOutputs?: readonly { readonly path: string; readonly what: string }[];
}

export interface TrusteeShareFile {
  readonly trustee: number;
  /** The file's name in its trustee folder. */
  readonly file: string;
  /** sha256 of the file's bytes as written and read back. */
  readonly sha256: Hex32;
  /** Whether chmod's folder 0700 and share file 0600 modes both held at read-back. */
  readonly permissionsKept: boolean;
}

export interface TrusteeSplitReceipt extends SplitReceipt {
  readonly format: typeof RECEIPT_FORMAT;
  readonly scheme: typeof TRUSTEE_SCHEME;
  readonly threshold: typeof THRESHOLD;
  readonly keyId: Hex32;
  readonly archiveSha256: Hex32;
  readonly splitId: Hex32;
  readonly shareFiles: readonly TrusteeShareFile[];
  /** What was proven about these shares before this receipt was made: every two of them rebuild the key. */
  readonly verified: readonly string[];
  /** The refusal rules, run on these shares before this receipt was made (checks of the code, not proofs about them). */
  readonly guards: readonly string[];
}

const verifiedReceipts = new WeakSet<object>();
const genuineSplitters = new WeakSet<object>();

/** Whether `value` is a receipt that a TrusteeKeySplit made after verifying recovery (not a copy or a look-alike). */
export function isVerifiedTrusteeReceipt(value: unknown): value is TrusteeSplitReceipt {
  return typeof value === 'object' && value !== null && verifiedReceipts.has(value);
}

const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^E[A-Z]+$/.test(code) ? code : 'error';
};

/** Runs a file operation; its failure becomes a refusal naming the step and the error code (never the error text). */
function attempt<T>(what: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw new Refusal(`${what} failed (${codeOf(error)})`);
  }
}

/**
 * A name as a case-insensitive disk compares it (APFS and HFS+ by default: case and Unicode form aside). On a
 * case-sensitive disk this refuses more than it must, which is safe.
 */
const fold = (path: string): string => path.normalize('NFC').toLowerCase();
const inside = (child: string, parent: string): boolean => {
  const rel = relative(fold(parent), fold(child));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
const nested = (a: string, b: string): boolean => fold(a) === fold(b) || inside(a, b) || inside(b, a);

interface Output {
  readonly path: string;
  readonly what: string;
}

/** "device:inode" of what is at `path` (links followed), or null when nothing is. */
function identityOf(path: string): string | null {
  try {
    const stat = statSync(path);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return null;
  }
}

/** The identities of `path` and of every existing folder above it (links followed). */
function identitiesAbove(path: string): Set<string> {
  const found = new Set<string>();
  for (let dir = resolve(path); ; dir = dirname(dir)) {
    const id = identityOf(dir);
    if (id) found.add(id);
    if (dirname(dir) === dir) return found;
  }
}

/**
 * Once the trustee folders exist: no other output of the run lies in one (nor one in it) by identity on disk, whatever
 * the names say (a disk's own case rules, a link made after the folder rules ran).
 */
function assertApartOnDisk(folders: readonly string[], outputs: readonly Output[]): void {
  const ids = folders.map((dir) => identityOf(dir));
  for (const { path, what } of outputs) {
    const above = identitiesAbove(path);
    const own = identityOf(path);
    folders.forEach((dir, i) => {
      const id = ids[i];
      if ((id !== null && id !== undefined && above.has(id)) || (own !== null && identitiesAbove(dir).has(own))) {
        throw new Refusal(`${what} ${path} lies in trustee folder ${i + 1} (the same folder on disk); a trustee gets only their share`);
      }
    });
  }
}

/** fsync a folder so a new entry in it survives a power loss; a file system that cannot sync a folder is let pass. */
function syncFolder(dir: string, what: string): void {
  attempt(`syncing ${what}`, () => {
    const fd = openSync(dir, 'r');
    try {
      fsyncSync(fd);
    } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(codeOf(error))) throw error;
    } finally {
      closeSync(fd);
    }
  });
}

/** The folder rules, checked by the constructor before any secret is read; returns the resolved folders. */
function checkFolders({ destinations, exportDir, otherOutputs = [] }: TrusteeFolders): readonly string[] {
  if (!Array.isArray(destinations) || destinations.length !== TRUSTEES || destinations.some((d) => typeof d !== 'string' || d === '')) {
    throw new Refusal('exactly three trustee folders are needed, one per trustee');
  }
  if (typeof exportDir !== 'string' || exportDir === '') throw new Refusal('the export folder must be named: no trustee folder may be it or be nested with it');
  const dirs = destinations.map((d) => resolve(d));
  const real = dirs.map((d) => realPathOf(d));
  const exportDirs = [resolve(exportDir), realPathOf(exportDir)];
  dirs.forEach((dir, i) => {
    const tree = gitWorkTreeOf(dir);
    if (tree) throw new Refusal(`trustee folder ${i + 1} ${dir} is inside a git working tree (${tree}); a key share is never committed: choose a folder outside every repository`);
  });
  dirs.forEach((dir, i) => {
    if (exportDirs.some((e) => nested(dir, e) || nested(real[i] as string, e))) {
      throw new Refusal(`trustee folder ${i + 1} ${dir} is the export folder or is nested with it; each share goes apart from the archive`);
    }
  });
  for (const [a, b] of PAIRS) {
    if (nested(dirs[a] as string, dirs[b] as string) || nested(real[a] as string, real[b] as string)) {
      throw new Refusal(`trustee folders ${a + 1} and ${b + 1} are the same folder or nested; each trustee needs a folder of their own`);
    }
  }
  dirs.forEach((dir, i) => {
    if (isTaken(dir)) throw new Refusal(`trustee folder ${i + 1} ${dir} already exists; a trustee folder must be new (nothing is overwritten)`);
    assertWritableParent(dir, `trustee folder ${i + 1}`);
  });
  for (const { path, what } of otherOutputs) {
    const where = [resolve(path), realPathOf(path)];
    dirs.forEach((dir, i) => {
      if (where.some((w) => nested(w, dir) || nested(w, real[i] as string))) throw new Refusal(`${what} ${path} lies in trustee folder ${i + 1} (${dir}); a trustee gets only their share`);
    });
  }
  return Object.freeze(dirs);
}

/** What the split context must name, checked before anything is written; returns the archive's text. */
function preflight(key: Uint8Array, context: KeySplitContext): string {
  if (context.escrowIntent !== 'trustees-2-of-3') throw new Refusal('the trustee split goes only with trustee escrow (trustees-2-of-3)');
  const text = context.archiveText;
  if (typeof text !== 'string') throw new Refusal("the trustee split needs the sealed archive's text (archiveText) to prove recovery against it");
  if (sha256Hex(text) !== context.archiveSha256) throw new Refusal('the archive text is not the archive named by the split context (its sha256 differs)');
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) throw new Refusal(`the archive key must be ${KEY_BYTES} bytes`);
  if (archiveKeyId(key) !== context.keyId) throw new Refusal("the key is not the archive's key (the key ids differ)");
  try {
    openArchive(text, key);
  } catch (error) {
    throw new Refusal(`the archive does not open with the key and pass its own check: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  return text;
}

/** split(key, 3, 2) on a plain Uint8Array copy (the library refuses a Buffer), zeroed afterwards. */
async function splitKey(key: Uint8Array): Promise<Uint8Array[]> {
  const secret = new Uint8Array(key);
  try {
    return await split(secret, TRUSTEES, THRESHOLD);
  } finally {
    secret.fill(0);
  }
}

/** Whether combining `a` and `b` gives the key named `keyId` (a library refusal counts as no). */
async function rebuildsKey(a: Uint8Array, b: Uint8Array, keyId: Hex32): Promise<boolean> {
  try {
    const k = await combine([a, b]);
    const hit = archiveKeyId(k) === keyId;
    k.fill(0);
    return hit;
  } catch {
    return false;
  }
}

/**
 * The proofs behind a receipt, from the share files as read back, and the refusal rules run on them; throws a refusal
 * at the first one that fails.
 */
async function verifyRecovery(
  key: Uint8Array,
  texts: readonly string[],
  shares: readonly Uint8Array[],
  archiveText: string,
): Promise<{ verified: string[]; guards: string[] }> {
  const verified: string[] = [];
  const guards: string[] = [];
  const parsed: ParsedShare[] = [];
  try {
    texts.forEach((text, i) => parsed.push(parseShareFile(text, i + 1)));
    for (const [a, b] of PAIRS) {
      const pair = `trustees ${a + 1}+${b + 1}`;
      let r: RecoveredKey;
      try {
        r = await recoverFromShares(parsed[a] as ParsedShare, parsed[b] as ParsedShare, archiveText);
      } catch (error) {
        throw new Refusal(`${pair}: ${error instanceof Refusal ? error.message : 'recovery failed'}`);
      }
      const same = timingSafeEqual(r.key, key);
      r.key.fill(0);
      if (!same) throw new Refusal(`${pair} rebuild a key other than the archive key`);
      verified.push(`${pair} rebuild the key, match its key id and open the archive (its own check passes)`);
    }
    // Guards: the refusal rules, run on these shares. They check the code, not the shares (one share reveals nothing).
    for (const [i, p] of parsed.entries()) {
      const byRecover = await recoverArchiveKey([texts[i] as string], archiveText).then(
        (r) => (r.key.fill(0), false),
        () => true,
      );
      const byLibrary = await combine([p.bytes]).then(
        (k) => (k.fill(0), false),
        () => true,
      );
      if (!byLibrary) throw new Refusal(`the library combined trustee ${i + 1}'s share alone`);
      if (!byRecover) throw new Refusal(`recover took trustee ${i + 1}'s share alone`);
    }
    guards.push("each share alone is refused (recover needs two share files; the library's combine needs two shares)");
    const decoys = await splitKey(key);
    try {
      for (const [i, share] of shares.entries()) {
        for (const [j, decoy] of decoys.entries()) {
          if (i !== j && (await rebuildsKey(share, decoy, archiveKeyId(key)))) throw new Refusal('a share of a second split of the same key rebuilt it');
        }
      }
    } finally {
      decoys.forEach((d) => d.fill(0));
    }
    guards.push('shares of a second split of the same key, each combined with another trustee\'s share of this split, do not rebuild it');
    return { verified, guards };
  } finally {
    parsed.forEach((p) => p.bytes.fill(0));
  }
}

/**
 * The 2-of-3 trustee splitter. Made with the three trustee folders (checked at once); `split` runs once and leaves
 * provisional share files, `commit` names them once the caller's own outputs are written, `discard` removes them.
 * Instances and the class are frozen, and key-split.ts accepts only instances this constructor made (not a subclass).
 */
export class TrusteeKeySplit implements ArchiveKeySplit {
  readonly scheme = TRUSTEE_SCHEME;
  readonly #folders: readonly string[];
  /** The export folder and the run's other outputs: none may lie in a trustee folder, checked again on disk. */
  readonly #outputs: readonly Output[];
  #state: 'new' | 'running' | 'verified' | 'committed' | 'discarded' = 'new';
  #receipt: TrusteeSplitReceipt | undefined;
  readonly #made: { readonly dirs: string[]; readonly files: string[] } = { dirs: [], files: [] };

  constructor(folders: TrusteeFolders) {
    this.#folders = checkFolders(folders);
    const others = (folders.otherOutputs ?? []).map(({ path, what }) => ({ path: resolve(path), what }));
    this.#outputs = Object.freeze([{ path: resolve(folders.exportDir), what: 'the export folder' }, ...others]);
    genuineSplitters.add(this);
    Object.freeze(this);
  }

  /** Whether `value` was made by this constructor (not a subclass, a copy or an object claiming the scheme). */
  static isGenuine(value: unknown): value is TrusteeKeySplit {
    return typeof value === 'object' && value !== null && genuineSplitters.has(value) && Object.getPrototypeOf(value) === TrusteeKeySplit.prototype;
  }

  /** The three share files' final paths (after `commit`), in trustee order. */
  get shareFiles(): readonly string[] {
    return this.#folders.map((dir, i) => join(dir, shareFileName(i + 1)));
  }

  /** Splits, writes the provisional share files and proves recovery; returns the verified receipt. */
  async split(key: Uint8Array, context: KeySplitContext): Promise<TrusteeSplitReceipt> {
    if (this.#state !== 'new') throw new Refusal('this trustee splitter has already run; make a new one for another split');
    this.#state = 'running';
    const archiveText = preflight(key, context);
    let shares: Uint8Array[] = [];
    try {
      shares = await splitKey(key);
      this.#assertNotDiscarded();
      const splitId: Hex32 = `0x${randomBytes(16).toString('hex')}`;
      const texts = shares.map((s, i) =>
        shareFileText({ format: SHARE_FORMAT, scheme: TRUSTEE_SCHEME, trustee: i + 1, keyId: context.keyId, archiveSha256: context.archiveSha256, splitId, share: Buffer.from(s.buffer, s.byteOffset, s.byteLength).toString('base64') }),
      );
      const back = this.#write(texts);
      assertApartOnDisk(this.#folders, this.#outputs);
      const { verified, guards } = await verifyRecovery(key, back.map(({ text }) => text), shares, archiveText);
      this.#assertNotDiscarded();
      const shareFiles = back.map(({ text, permissionsKept }, i) => Object.freeze({ trustee: i + 1, file: shareFileName(i + 1), sha256: sha256Hex(text), permissionsKept }));
      const receipt: TrusteeSplitReceipt = Object.freeze({
        format: RECEIPT_FORMAT,
        scheme: TRUSTEE_SCHEME,
        threshold: THRESHOLD,
        note: 'verified: every two of the three shares rebuild the key, match its key id and open the archive; guards: one share alone and shares of a second split are refused',
        keyId: context.keyId,
        archiveSha256: context.archiveSha256,
        splitId,
        shareFiles: Object.freeze(shareFiles),
        verified: Object.freeze(verified),
        guards: Object.freeze(guards),
      });
      verifiedReceipts.add(receipt);
      this.#receipt = receipt;
      this.#state = 'verified';
      return receipt;
    } catch (error) {
      this.#state = 'discarded';
      const left = this.#remove();
      const reason = error instanceof Refusal ? error.message : 'the trustee split failed';
      throw new Refusal(`${reason}; ${left.length ? `could not remove ${left.join(', ')}: remove them by hand` : 'the share files written so far were removed'}`);
    } finally {
      shares.forEach((s) => s.fill(0));
    }
  }

  /**
   * Gives the verified split's share files their final names (never over anything), syncs each folder and reads each
   * file back against the receipt. The caller commits once its own outputs are written. On failure the split is
   * removed and its receipt withdrawn.
   */
  commit(): void {
    const receipt = this.#receipt;
    if (this.#state !== 'verified' || !receipt) throw new Refusal('nothing to commit: this trustee splitter holds no verified split waiting for its final names');
    try {
      this.#folders.forEach((dir, i) => {
        const trustee = i + 1;
        const pending = join(dir, pendingFileName(trustee));
        const file = join(dir, shareFileName(trustee));
        if (isTaken(file)) throw new Refusal(`trustee ${trustee}'s share file ${file} already exists; nothing is overwritten`);
        attempt(`naming trustee ${trustee}'s share file`, () => renameSync(pending, file));
        const at = this.#made.files.indexOf(pending);
        if (at >= 0) this.#made.files[at] = file;
        else this.#made.files.push(file);
        syncFolder(dir, `trustee folder ${trustee}`);
        const text = attempt(`reading trustee ${trustee}'s share file back`, () => readFileSync(file, 'utf8'));
        if (sha256Hex(text) !== receipt.shareFiles[i]?.sha256) throw new Refusal(`trustee ${trustee}'s share file reads back different from its receipt`);
      });
      this.#state = 'committed';
    } catch (error) {
      const left = this.discard();
      const reason = error instanceof Refusal ? error.message : 'committing the trustee split failed';
      throw new Refusal(`${reason}; ${left.length ? `could not remove ${left.join(', ')}: remove them by hand` : 'the share files were removed'}`);
    }
  }

  /**
   * Removes the share files and folders of a split (provisional or committed) and withdraws its receipt: for a caller
   * whose own outputs failed, or that was interrupted. Returns what could not be removed.
   */
  discard(): readonly string[] {
    if (this.#receipt) verifiedReceipts.delete(this.#receipt);
    this.#state = 'discarded';
    return this.#remove();
  }

  #assertNotDiscarded(): void {
    if (this.#state === 'discarded') throw new Refusal('the trustee split was discarded while it ran');
  }

  /**
   * Creates each trustee folder and writes its provisional share file (never over anything), syncing the file, the
   * folder and the folder above it; then reads each back.
   */
  #write(texts: readonly string[]): { text: string; permissionsKept: boolean }[] {
    this.#folders.forEach((dir, i) => {
      const trustee = i + 1;
      attempt(`creating trustee folder ${trustee}`, () => mkdirSync(dir, { mode: 0o700 }));
      this.#made.dirs.push(dir);
      attempt(`setting trustee folder ${trustee} to mode 0700`, () => chmodSync(dir, 0o700));
      const file = join(dir, pendingFileName(trustee));
      const fd = attempt(`creating trustee ${trustee}'s share file`, () => openSync(file, 'wx', 0o600));
      this.#made.files.push(file);
      try {
        attempt(`writing trustee ${trustee}'s share file`, () => {
          writeFileSync(fd, texts[i] as string);
          fsyncSync(fd);
        });
      } finally {
        closeSync(fd);
      }
      attempt(`setting trustee ${trustee}'s share file to mode 0600`, () => chmodSync(file, 0o600));
      syncFolder(dir, `trustee folder ${trustee}`);
      syncFolder(dirname(dir), `the folder above trustee folder ${trustee}`);
    });
    return this.#folders.map((dir, i) => {
      const trustee = i + 1;
      const file = join(dir, pendingFileName(trustee));
      const text = attempt(`reading trustee ${trustee}'s share file back`, () => readFileSync(file, 'utf8'));
      if (text !== texts[i]) throw new Refusal(`trustee ${trustee}'s share file reads back different from what was written`);
      const permissionsKept = (statSync(file).mode & 0o777) === 0o600 && (statSync(dir).mode & 0o777) === 0o700;
      if (!permissionsKept) console.warn(`warning: trustee ${trustee}'s folder or share file did not keep mode 0700 / 0600; the share is readable by anyone on a machine the stick is plugged into.`);
      return { text, permissionsKept };
    });
  }

  #remove(): string[] {
    const left: string[] = [];
    const gone = (run: () => void, path: string) => {
      try {
        run();
      } catch (error) {
        if (codeOf(error) !== 'ENOENT') left.push(path);
      }
    };
    for (const file of this.#made.files.splice(0).reverse()) gone(() => unlinkSync(file), file);
    for (const dir of this.#made.dirs.splice(0).reverse()) gone(() => rmdirSync(dir), dir);
    return left;
  }
}

// key-split.ts trusts TrusteeKeySplit.isGenuine and its prototype's split: neither may be replaced.
Object.freeze(TrusteeKeySplit.prototype);
Object.freeze(TrusteeKeySplit);
