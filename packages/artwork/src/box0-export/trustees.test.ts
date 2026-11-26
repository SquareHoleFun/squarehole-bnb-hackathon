/**
 * Box 0's 2-of-3 trustee key split (F115 R30P "trustees"; F122 R37E: Privy's audited shamir-secret-sharing):
 * TrusteeKeySplit writes one share file per trustee folder, proves that every two shares rebuild the key, match its key
 * id and open the archive, and that one share or a share of another split does not, before it returns a receipt; on
 * any failure it removes what it wrote. recoverArchiveKey rebuilds the key from any two share files in memory. No key
 * or share byte reaches a thrown message or the console.
 */
import { createHash, randomBytes } from 'node:crypto';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bytesToHex } from '@noble/hashes/utils.js';
import { combine } from 'shamir-secret-sharing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '../manifest';
import { messageOf, randomTestSet, readR7, readR7Json, rejectionOf } from '../test-support/box0-export';
import { REPO, fakeRepo, outsideRepoTemp, workspaces } from '../test-support/box0-workspaces';
import { archiveKeyId, sealArchive, type KeySplitContext, type SealedArchive } from './archive';
import { buildBox0Commitment } from './commitment';
import { parseFrozenSet, parseTraitTable } from './inputs';
import { parseRenderHashes } from './renders';
import {
  RECEIPT_FORMAT,
  SHARE_FORMAT,
  TRUSTEE_SCHEME,
  TrusteeKeySplit,
  isVerifiedTrusteeReceipt,
  recoverArchiveKey,
  shareFileName,
  type TrusteeSplitReceipt,
} from './trustees';

/**
 * Lets tests simulate a changed read-back or modes that a stick does not keep, and records which paths were fsynced
 * (by the path each descriptor was opened with). chmod still runs on the real files.
 */
const readBack = vi.hoisted(() => ({ tamper: false, modes: new Map<string, number>(), synced: [] as string[], opened: new Map<number, string>() }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const readFileSync = ((path: unknown, ...rest: unknown[]) => {
    const out = (fs.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
    if (readBack.tamper && typeof path === 'string' && /-of-3\.json(\.partial)?$/.test(path) && typeof out === 'string') return out.replace('"trustee": ', '"trustee":  ');
    return out;
  }) as typeof fs.readFileSync;
  const openSync = ((path: unknown, ...rest: unknown[]) => {
    const fd = (fs.openSync as (...args: unknown[]) => number)(path, ...rest);
    if (typeof path === 'string') readBack.opened.set(fd, path);
    return fd;
  }) as typeof fs.openSync;
  const fsyncSync = ((fd: number) => {
    fs.fsyncSync(fd);
    const path = readBack.opened.get(fd);
    if (path !== undefined) readBack.synced.push(path);
  }) as typeof fs.fsyncSync;
  const statSync = ((path: unknown, ...rest: unknown[]) => {
    const stat = (fs.statSync as (...args: unknown[]) => import('node:fs').Stats)(path, ...rest);
    const mode = typeof path === 'string' ? readBack.modes.get(path) : undefined;
    if (mode !== undefined) stat.mode = (stat.mode & ~0o777) | mode;
    return stat;
  }) as typeof fs.statSync;
  const replaced = { readFileSync, openSync, fsyncSync, statSync, chmodSync: vi.fn(fs.chmodSync) };
  return { ...fs, ...replaced, default: { ...fs, ...replaced } };
});

/** Lets a test fault the library's combine (a regression that would make a proof pass or fail wrongly). */
type Combine = (shares: Uint8Array[]) => Promise<Uint8Array>;
const shamirFault = vi.hoisted(() => ({ combine: undefined as undefined | ((shares: Uint8Array[], real: Combine) => Promise<Uint8Array>) }));
vi.mock('shamir-secret-sharing', async (importOriginal) => {
  const real = await importOriginal<typeof import('shamir-secret-sharing')>();
  const faulted: Combine = (shares) => (shamirFault.combine ? shamirFault.combine(shares, real.combine) : real.combine(shares));
  return { ...real, combine: faulted };
});

const n = 13;
const set = randomTestSet(n, readR7().types, [3]);
const commitment = buildBox0Commitment(
  { frozenSet: parseFrozenSet(set.frozenSet, n), renders: parseRenderHashes(set.renders, n), table: parseTraitTable(readR7Json()), generator: { tree: set.generatorTree } },
  { n },
);
const key = new Uint8Array(randomBytes(32));
const sealed = sealArchive(commitment, key, { escrowIntent: 'trustees-2-of-3' });
const contextOf = (s: SealedArchive = sealed): KeySplitContext => ({ archiveSha256: s.sha256, keyId: s.header.keyId, escrowIntent: 'trustees-2-of-3', archiveText: s.text });

const ws = workspaces('box0-trustees');
afterEach(() => {
  readBack.tamper = false;
  readBack.modes.clear();
  vi.mocked(chmodSync).mockClear();
  shamirFault.combine = undefined;
  ws.trash();
});
const itOutsideRepo = it.skipIf(!outsideRepoTemp);

const sha256 = (bytes: Uint8Array | string) => `0x${createHash('sha256').update(bytes).digest('hex')}`;

/** Three new trustee folders and an export folder in a fresh workspace. */
function folders(dir = ws.make()) {
  return { dir, destinations: [1, 2, 3].map((t) => join(dir, `trustee-${t}`)), exportDir: join(dir, 'out') };
}

/** A split, committed (the share files under their final names). */
async function splitInto(dir = ws.make(), k: Uint8Array = key, s: SealedArchive = sealed) {
  const f = folders(dir);
  const splitter = new TrusteeKeySplit({ destinations: f.destinations, exportDir: f.exportDir });
  const receipt = await splitter.split(k, contextOf(s));
  splitter.commit();
  const files = f.destinations.map((d, i) => join(d, shareFileName(i + 1)));
  return { ...f, splitter, receipt, files, texts: files.map((file) => readFileSync(file, 'utf8')) };
}

interface ShareFile {
  format: string;
  scheme: string;
  trustee: number;
  keyId: string;
  archiveSha256: string;
  splitId: string;
  share: string;
  shareChecksum: string;
  about: string;
}
const parse = (text: string) => JSON.parse(text) as ShareFile;

/** The documented checksum: sha256 of the canonical JSON of the share's fields and a domain (recomputed independently here). */
function checksumOf(f: ShareFile): string {
  const { format, scheme, keyId, archiveSha256, splitId, share } = f;
  return sha256(canonicalJson({ domain: 'squarehole.box0-archive-key-share/checksum/1', format, scheme, trustee: String(f.trustee), keyId, archiveSha256, splitId, share }));
}
const reseal = (f: ShareFile) => `${JSON.stringify({ ...f, shareChecksum: checksumOf(f) }, null, 2)}\n`;

/** Every rendering of the key and of `shareTexts`' shares (hex, base64 and their 16-character prefixes). */
function secretsOf(k: Uint8Array, shareTexts: readonly string[] = []): string[] {
  const all = [bytesToHex(k), Buffer.from(k).toString('base64')];
  for (const text of shareTexts) {
    const share = parse(text).share;
    all.push(share, Buffer.from(share, 'base64').toString('hex'));
  }
  return all.flatMap((s) => [s, s.slice(0, 16)]);
}

/** Runs `fn` with console and process output captured; returns its value or its rejection (message and stack). */
async function quietly<T>(fn: () => Promise<T>): Promise<{ value?: T; message: string; output: string }> {
  const lines: string[] = [];
  const keep = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  const spies = [
    ...(['log', 'error', 'warn', 'info', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(keep)),
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => (keep(chunk), true)),
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => (keep(chunk), true)),
  ];
  try {
    const value = await fn();
    return { value, message: '', output: lines.join('\n') };
  } catch (error) {
    return { message: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error), output: lines.join('\n') };
  } finally {
    spies.forEach((s) => s.mockRestore());
  }
}

function expectNoSecret(text: string, secrets: readonly string[]) {
  for (const secret of secrets) expect(text.includes(secret), 'a key or share byte was echoed').toBe(false);
}

const nothingIn = (dir: string) => !existsSync(dir) || readdirSync(dir).length === 0;

describe('TrusteeKeySplit: three share files, verified before success', () => {
  itOutsideRepo('writes one share file per new trustee folder (folders 0700, files 0600) with only public fields beside the share', async () => {
    const r = await splitInto();
    r.destinations.forEach((d, i) => {
      expect(readdirSync(d)).toEqual([shareFileName(i + 1)]);
      expect(statSync(d).mode & 0o777).toBe(0o700);
      expect(statSync(r.files[i] as string).mode & 0o777).toBe(0o600);
    });
    expect(shareFileName(2)).toBe('box0-archive-key-share-2-of-3.json');
    const files = r.texts.map(parse);
    files.forEach((f, i) => {
      expect(Object.keys(f).sort()).toEqual(['about', 'archiveSha256', 'format', 'keyId', 'scheme', 'share', 'shareChecksum', 'splitId', 'trustee']);
      expect(f).toMatchObject({ format: SHARE_FORMAT, scheme: TRUSTEE_SCHEME, trustee: i + 1, keyId: archiveKeyId(key), archiveSha256: sealed.sha256 });
      expect(f.splitId).toMatch(/^0x[0-9a-f]{32}$/);
      expect(f.splitId).toBe(files[0]?.splitId);
      expect(Buffer.from(f.share, 'base64')).toHaveLength(33);
      expect(f.shareChecksum).toBe(checksumOf(f));
      expect(f.about).toMatch(/any two/i);
    });
    expect(new Set(files.map((f) => f.share)).size).toBe(3);
    expect(SHARE_FORMAT).toBe('squarehole.box0-archive-key-share/1');
    expectNoSecret(r.texts.join('\n'), secretsOf(key));
  });

  itOutsideRepo('returns a frozen, verified receipt: scheme, key id, archive sha256 and the sha256 of each share file', async () => {
    const r = await splitInto();
    const receipt: TrusteeSplitReceipt = r.receipt;
    expect(receipt).toMatchObject({ format: RECEIPT_FORMAT, scheme: 'shamir-2-of-3', threshold: 2, keyId: sealed.header.keyId, archiveSha256: sealed.sha256, splitId: parse(r.texts[0] as string).splitId });
    expect(receipt.shareFiles).toEqual(r.files.map((file, i) => ({ trustee: i + 1, file: shareFileName(i + 1), sha256: sha256(readFileSync(file)), permissionsKept: true })));
    // Proofs about these shares: the three pairs only. The refusal rules run too, but are listed as guards.
    expect(receipt.verified).toHaveLength(3);
    expect(receipt.verified.join('\n')).toMatch(/^trustees 1\+2 .*\ntrustees 1\+3 .*\ntrustees 2\+3 /);
    expect(receipt.guards.join('\n')).toMatch(/each share alone is refused/);
    expect(receipt.guards.join('\n')).toMatch(/a second split of the same key/);
    expect(receipt.note).toMatch(/^verified: every two of the three shares rebuild the key/);
    expect(isVerifiedTrusteeReceipt(receipt)).toBe(true);
    expect(isVerifiedTrusteeReceipt({ ...receipt })).toBe(false);
    expect(Object.isFrozen(receipt) && Object.isFrozen(receipt.shareFiles) && Object.isFrozen(receipt.shareFiles[0])).toBe(true);
    expectNoSecret(JSON.stringify(receipt), secretsOf(key, r.texts));
  });

  itOutsideRepo('splits, verifies and prints nothing (console and process output captured)', async () => {
    const run = await quietly(() => splitInto());
    expect(run.message).toBe('');
    expect(run.output).toBe('');
  });

  itOutsideRepo.each([
    { what: 'folder mode', affected: [2], folderMode: 0o777, fileMode: 0o600 },
    { what: 'share file mode', affected: [3], folderMode: 0o700, fileMode: 0o666 },
    { what: 'both modes for all trustees', affected: [1, 2, 3], folderMode: 0o777, fileMode: 0o777 },
  ])('accepts a stick that ignores $what, warns once per affected trustee and records permissionsKept', async ({ affected, folderMode, fileMode }) => {
    const f = folders();
    for (const trustee of affected) {
      const dir = f.destinations[trustee - 1] as string;
      readBack.modes.set(dir, folderMode);
      readBack.modes.set(join(dir, `${shareFileName(trustee)}.partial`), fileMode);
      readBack.modes.set(join(dir, shareFileName(trustee)), fileMode);
    }
    const run = await quietly(() => splitInto(f.dir));
    expect(run.message).toBe('');
    const r = run.value;
    if (!r) throw new Error('split returned no result');
    expect(run.output.split('\n')).toEqual(affected.map((trustee) =>
      `warning: trustee ${trustee}'s folder or share file did not keep mode 0700 / 0600; the share is readable by anyone on a machine the stick is plugged into.`,
    ));
    expect(r.receipt.shareFiles).toEqual(r.files.map((file, i) => ({
      trustee: i + 1, file: shareFileName(i + 1), sha256: sha256(readFileSync(file)), permissionsKept: !affected.includes(i + 1),
    })));
    expect(isVerifiedTrusteeReceipt(r.receipt)).toBe(true);
    expect(r.receipt.verified).toHaveLength(3);
    expect(r.receipt.guards).toHaveLength(2);
    r.destinations.forEach((dir, i) => {
      expect(chmodSync).toHaveBeenCalledWith(dir, 0o700);
      expect(chmodSync).toHaveBeenCalledWith(join(dir, `${shareFileName(i + 1)}.partial`), 0o600);
      expect(readdirSync(dir)).toEqual([shareFileName(i + 1)]);
    });
    expectNoSecret(run.output + JSON.stringify(r.receipt), secretsOf(key, r.texts));
  });

  itOutsideRepo('discard() removes the share files and folders of a finished split (the CLI calls it when its own outputs fail)', async () => {
    const r = await splitInto();
    expect(r.splitter.discard()).toEqual([]);
    for (const d of r.destinations) expect(existsSync(d)).toBe(false);
    expect(isVerifiedTrusteeReceipt(r.receipt)).toBe(false);
  });

  itOutsideRepo('keeps each share under a provisional name (.partial) until commit() gives it its final name; discard() removes either', async () => {
    const f = folders();
    const splitter = new TrusteeKeySplit({ destinations: f.destinations, exportDir: f.exportDir });
    const receipt = await splitter.split(key, contextOf());
    f.destinations.forEach((d, i) => expect(readdirSync(d)).toEqual([`${shareFileName(i + 1)}.partial`]));
    splitter.commit();
    f.destinations.forEach((d, i) => {
      expect(readdirSync(d)).toEqual([shareFileName(i + 1)]);
      expect(sha256(readFileSync(join(d, shareFileName(i + 1))))).toBe(receipt.shareFiles[i]?.sha256);
      expect(statSync(join(d, shareFileName(i + 1))).mode & 0o777).toBe(0o600);
    });
    expect(isVerifiedTrusteeReceipt(receipt)).toBe(true);
    const g = folders();
    const pending = new TrusteeKeySplit({ destinations: g.destinations, exportDir: g.exportDir });
    const withdrawn = await pending.split(key, contextOf());
    expect(pending.discard()).toEqual([]);
    expect(isVerifiedTrusteeReceipt(withdrawn)).toBe(false);
    for (const d of g.destinations) expect(existsSync(d)).toBe(false);
  });

  itOutsideRepo('commit() runs once, only after a verified split; a final-named file in the way is never overwritten and the split is removed', async () => {
    const f = folders();
    const splitter = new TrusteeKeySplit({ destinations: f.destinations, exportDir: f.exportDir });
    expect(messageOf(() => splitter.commit())).toMatch(/nothing to commit/);
    const receipt = await splitter.split(key, contextOf());
    const inTheWay = join(f.destinations[1] as string, shareFileName(2));
    writeFileSync(inTheWay, 'not ours');
    const run = await quietly(async () => splitter.commit());
    expect(run.message).toMatch(/trustee 2's share file .* already exists; nothing is overwritten/);
    expect(run.output).toBe('');
    expectNoSecret(run.message, secretsOf(key));
    expect(readFileSync(inTheWay, 'utf8')).toBe('not ours');
    expect(readdirSync(f.destinations[1] as string)).toEqual([shareFileName(2)]);
    expect(existsSync(f.destinations[0] as string) || existsSync(f.destinations[2] as string)).toBe(false);
    expect(isVerifiedTrusteeReceipt(receipt)).toBe(false);
    expect(messageOf(() => splitter.commit())).toMatch(/nothing to commit/);
    const done = await splitInto();
    expect(messageOf(() => done.splitter.commit())).toMatch(/nothing to commit/);
  });

  itOutsideRepo('fsyncs each share file, its trustee folder and the folder above it, and the trustee folder again after commit', async () => {
    readBack.synced.length = 0;
    const r = await splitInto();
    r.destinations.forEach((d, i) => {
      expect(readBack.synced).toContain(join(d, `${shareFileName(i + 1)}.partial`));
      expect(readBack.synced.filter((p) => p === d).length).toBeGreaterThanOrEqual(2);
      expect(readBack.synced).toContain(dirname(d));
    });
  });
});

describe('recoverArchiveKey: any two share files and the archive', () => {
  itOutsideRepo.each([
    [1, 2],
    [1, 3],
    [2, 3],
    [3, 1],
  ])('trustees %i and %i rebuild the key in memory, match its key id and open the archive', async (a, b) => {
    const r = await splitInto();
    const recovered = await recoverArchiveKey([r.texts[a - 1] as string, r.texts[b - 1] as string], sealed.text);
    expect(bytesToHex(recovered.key)).toBe(bytesToHex(key));
    expect(recovered).toMatchObject({ keyId: sealed.header.keyId, archiveSha256: sealed.sha256, trustees: [a, b] });
    expect(recovered.opened.root).toBe(commitment.root);
    expect(recovered.opened.records).toHaveLength(n);
  });

  itOutsideRepo('refuses one share alone, the same trustee twice and three shares', async () => {
    const r = await splitInto();
    const [one, two, three] = r.texts as [string, string, string];
    expect(await rejectionOf(recoverArchiveKey([one], sealed.text))).toMatch(/two share files are needed: one share alone cannot rebuild the key/);
    expect(await rejectionOf(recoverArchiveKey([], sealed.text))).toMatch(/two share files are needed/);
    expect(await rejectionOf(recoverArchiveKey([one, one], sealed.text))).toMatch(/both share files are trustee 1's/);
    expect(await rejectionOf(recoverArchiveKey([one, two, three], sealed.text))).toMatch(/give exactly two share files/);
  });

  itOutsideRepo('refuses a share of another split of the same key: by its split id, and by the key id when the split id is forged too', async () => {
    const first = await splitInto();
    const second = await splitInto();
    const raw = (t: string) => new Uint8Array(Buffer.from(parse(t).share, 'base64'));
    const xOf = (t: string) => raw(t)[32];
    const a = first.texts[0] as string;
    // Each split draws its x coordinates anew, so trustee 2 of the second split may share trustee 1's x (about 1 in 255):
    // take the second split's trustee 2 or 3 whose x differs (one always does); the same x is the case below.
    const b = second.texts.slice(1).find((t) => xOf(t) !== xOf(a)) as string;
    expect(await rejectionOf(recoverArchiveKey([a, b], sealed.text))).toMatch(/the share files come from different splits/);
    const forged = reseal({ ...parse(b), splitId: parse(a).splitId });
    expect(await rejectionOf(recoverArchiveKey([a, forged], sealed.text))).toMatch(/the shares do not rebuild the archive's key \(the key ids differ\)/);
    // The math under it: two points of two different polynomials interpolate to another key.
    const mixed = await combine([raw(a), raw(b)]);
    expect(archiveKeyId(mixed)).not.toBe(archiveKeyId(key));
    // A forged share at a's x coordinate is refused before any key is rebuilt.
    const sameX = raw(b);
    sameX[32] = xOf(a) as number;
    const atSameX = reseal({ ...parse(forged), share: Buffer.from(sameX).toString('base64') });
    expect(await rejectionOf(recoverArchiveKey([a, atSameX], sealed.text))).toMatch(/the two shares cannot be combined/);
  });

  itOutsideRepo('refuses a share relabeled as another trustee (re-checksummed): the same share point twice cannot be combined', async () => {
    const r = await splitInto();
    const one = r.texts[0] as string;
    const relabeled = reseal({ ...parse(one), trustee: 2 });
    expect(await rejectionOf(recoverArchiveKey([one, relabeled], sealed.text))).toMatch(/the two shares cannot be combined/);
  });

  itOutsideRepo('refuses a share of another key and archive', async () => {
    const otherKey = new Uint8Array(randomBytes(32));
    const other = sealArchive(commitment, otherKey, { escrowIntent: 'trustees-2-of-3' });
    const mine = await splitInto();
    const theirs = await splitInto(ws.make(), otherKey, other);
    expect(await rejectionOf(recoverArchiveKey([mine.texts[0] as string, theirs.texts[1] as string], sealed.text))).toMatch(/the share files are shares of different keys/);
  });

  itOutsideRepo('refuses a tampered share by its checksum, a consistent forgery by the key id, and never echoes a share file', async () => {
    const r = await splitInto();
    const [one, two] = r.texts as [string, string];
    const f = parse(two);
    const bytes = Buffer.from(f.share, 'base64');
    bytes[5] = (bytes[5] as number) ^ 0x01;
    const flipped = { ...f, share: bytes.toString('base64') };
    const messages = [
      await rejectionOf(recoverArchiveKey([one, JSON.stringify(flipped)], sealed.text)),
      await rejectionOf(recoverArchiveKey([one, JSON.stringify({ ...f, trustee: 3 })], sealed.text)),
      await rejectionOf(recoverArchiveKey([one, reseal(flipped)], sealed.text)),
      await rejectionOf(recoverArchiveKey([one, reseal({ ...f, share: bytes.subarray(1).toString('base64') })], sealed.text)),
      await rejectionOf(recoverArchiveKey([one, two.slice(0, -20)], sealed.text)),
      await rejectionOf(recoverArchiveKey([one, JSON.stringify({ ...f, format: f.share })], sealed.text)),
      await rejectionOf(recoverArchiveKey([one, reseal({ ...f, trustee: 7 })], sealed.text)),
    ];
    expect(messages[0]).toMatch(/share file 2 \(trustee 2\) does not match its checksum/);
    expect(messages[1]).toMatch(/share file 2 \(trustee 3\) does not match its checksum/);
    expect(messages[2]).toMatch(/the shares do not rebuild the archive's key \(the key ids differ\)/);
    expect(messages[3]).toMatch(/share file 2's share must be 33 bytes/);
    expect(messages[4]).toMatch(/share file 2 is not valid JSON/);
    expect(messages[5]).toMatch(/share file 2 is not a squarehole.box0-archive-key-share\/1 file/);
    expect(messages[6]).toMatch(/share file 2's trustee must be 1, 2 or 3/);
    expectNoSecret(messages.join('\n'), secretsOf(key, [...r.texts, JSON.stringify(flipped)]));
  });

  itOutsideRepo('refuses an archive the shares were not made for (another seal with the same key, another key, a cut file)', async () => {
    const r = await splitInto();
    const pair = [r.texts[0] as string, r.texts[2] as string];
    const resealed = sealArchive(commitment, key, { escrowIntent: 'trustees-2-of-3' });
    const otherKey = sealArchive(commitment, new Uint8Array(randomBytes(32)), { escrowIntent: 'trustees-2-of-3' });
    for (const text of [resealed.text, otherKey.text, sealed.text.slice(0, -2)]) {
      expect(await rejectionOf(recoverArchiveKey(pair, text))).toMatch(/the archive is not the one these shares were made for \(its sha256 differs\)/);
    }
  });
});

describe('trustee folders: explicit, apart, outside every repository', () => {
  it('refuses trustee folders inside this repository before creating anything', () => {
    const tag = bytesToHex(randomBytes(4));
    const inRepo = [1, 2, 3].map((t) => join(REPO, `.box0-trustee-test-${tag}-${t}`));
    expect(() => new TrusteeKeySplit({ destinations: inRepo, exportDir: join(ws.make(), 'out') })).toThrow(/trustee folder 1 .* is inside a git working tree/);
    for (const d of inRepo) expect(existsSync(d)).toBe(false);
  });

  itOutsideRepo('refuses a folder inside a git working tree, as written or through a link, before creating anything', () => {
    const f = folders();
    const { sub, link } = fakeRepo(f.dir);
    const [d1, d2, d3] = f.destinations as [string, string, string];
    expect(() => new TrusteeKeySplit({ destinations: [join(sub, 't1'), d2, d3], exportDir: f.exportDir })).toThrow(/trustee folder 1 .* is inside a git working tree/);
    expect(() => new TrusteeKeySplit({ destinations: [d1, join(link, 't2'), d3], exportDir: f.exportDir })).toThrow(/trustee folder 2 .* is inside a git working tree/);
    for (const d of [...f.destinations, join(sub, 't1'), join(sub, 't2')]) expect(existsSync(d)).toBe(false);
  });

  itOutsideRepo('refuses the export folder, anything nested with it or another trustee folder, other secret outputs inside one, and anything but three new folders', () => {
    const f = folders();
    const [d1, d2, d3] = f.destinations as [string, string, string];
    const refuse = (destinations: readonly string[], refusal: RegExp, otherOutputs?: readonly { path: string; what: string }[]) =>
      expect(() => new TrusteeKeySplit({ destinations, exportDir: f.exportDir, ...(otherOutputs ? { otherOutputs } : {}) })).toThrow(refusal);
    refuse([d1, f.exportDir, d3], /trustee folder 2 .* is the export folder or is nested with it/);
    refuse([d1, d2, join(f.exportDir, 'shares')], /trustee folder 3 .* is the export folder or is nested with it/);
    refuse([d1, d1, d3], /trustee folders 1 and 2 are the same folder or nested/);
    refuse([d1, join(d1, 'inner'), d3], /trustee folders 1 and 2 are the same folder or nested/);
    refuse([d1, d2], /exactly three trustee folders/);
    refuse([d1, d2, d3, join(f.dir, 'trustee-4')], /exactly three trustee folders/);
    refuse([d1, '', d3], /exactly three trustee folders/);
    refuse([d1, d2, d3], /the plain records file .* lies in trustee folder 2/, [{ path: join(d2, 'plain.json'), what: 'the plain records file' }]);
    mkdirSync(d2);
    refuse([d1, d2, d3], /trustee folder 2 .* already exists/);
    refuse([d1, join(f.dir, 'missing', 'trustee-2'), d3], /the parent of trustee folder 2 .* is not an existing folder/);
    const locked = join(f.dir, 'locked');
    mkdirSync(locked, { mode: 0o500 });
    try {
      let writable = true;
      try {
        accessSync(locked, constants.W_OK);
      } catch {
        writable = false;
      }
      if (!writable) refuse([d1, join(locked, 'trustee-2'), d3], /the parent of trustee folder 2 .* is not writable/);
    } finally {
      chmodSync(locked, 0o700);
    }
    expect(existsSync(d1) || existsSync(d3) || existsSync(f.exportDir)).toBe(false);
  });

  itOutsideRepo('compares names as a case-insensitive disk does (APFS): names that differ only in case or Unicode form are the same folder', () => {
    const f = folders();
    const [, d2, d3] = f.destinations as [string, string, string];
    const upper = join(f.dir, 'Trustee-1');
    const lower = join(f.dir, 'trustee-1');
    const make = (destinations: readonly string[], more: { exportDir?: string; otherOutputs?: { path: string; what: string }[] } = {}) => () =>
      new TrusteeKeySplit({ destinations, exportDir: more.exportDir ?? f.exportDir, ...(more.otherOutputs ? { otherOutputs: more.otherOutputs } : {}) });
    expect(make([upper, d2, d3], { otherOutputs: [{ path: join(lower, 'plain.json'), what: 'the plain records file' }] })).toThrow(/the plain records file .* lies in trustee folder 1/);
    expect(make([upper, d2, d3], { exportDir: join(lower, 'out') })).toThrow(/trustee folder 1 .* is the export folder or is nested with it/);
    expect(make([upper, d2, d3], { exportDir: lower })).toThrow(/trustee folder 1 .* is the export folder or is nested with it/);
    expect(make([upper, join(f.dir, 'TRUSTEE-1'), d3])).toThrow(/trustee folders 1 and 2 are the same folder or nested/);
    expect(make([join(f.dir, 'café'), join(f.dir, 'café'), d3])).toThrow(/trustee folders 1 and 2 are the same folder or nested/);
    expect(readdirSync(f.dir)).toEqual([]);
  });

  itOutsideRepo('refuses, by identity on disk, an export folder or other output that a link made after the check puts in a trustee folder, and removes the shares', async () => {
    for (const which of ['export folder', 'plain records file'] as const) {
      const f = folders();
      const later = join(f.dir, 'later');
      const target =
        which === 'export folder' ? { exportDir: join(later, 'out') } : { exportDir: f.exportDir, otherOutputs: [{ path: join(later, 'plain.json'), what: 'the plain records file' }] };
      const splitter = new TrusteeKeySplit({ destinations: f.destinations, ...target });
      // Dangling until the split makes trustee folder 1; the folder rules saw no link.
      symlinkSync(f.destinations[0] as string, later);
      const run = await quietly(() => splitter.split(key, contextOf()));
      expect(run.value).toBeUndefined();
      expect(run.message).toMatch(new RegExp(`the ${which} .* lies in trustee folder 1 \\(the same folder on disk\\)`));
      expect(run.message).toMatch(/the share files written so far were removed/);
      for (const d of f.destinations) expect(existsSync(d)).toBe(false);
    }
  });
});

describe('failures leave no share file, no receipt and no secret in messages or output', () => {
  itOutsideRepo('a folder that cannot be created after two shares were written: both are removed and the split is refused', async () => {
    const f = folders();
    const locked = join(f.dir, 'locked');
    mkdirSync(locked);
    const destinations = [f.destinations[0] as string, f.destinations[1] as string, join(locked, 'trustee-3')];
    const splitter = new TrusteeKeySplit({ destinations, exportDir: f.exportDir });
    chmodSync(locked, 0o500);
    try {
      const run = await quietly(() => splitter.split(key, contextOf()));
      expect(run.value).toBeUndefined();
      expect(run.message).toMatch(/creating trustee folder 3 failed \(EACCES\)/);
      expect(run.message).toMatch(/the share files written so far were removed/);
      expect(run.output).toBe('');
      expectNoSecret(`${run.message}\n${run.output}`, secretsOf(key));
    } finally {
      chmodSync(locked, 0o700);
    }
    for (const d of destinations) expect(existsSync(d)).toBe(false);
  });

  itOutsideRepo('a share file that reads back changed: all three are removed and the split is refused', async () => {
    const f = folders();
    const splitter = new TrusteeKeySplit({ destinations: f.destinations, exportDir: f.exportDir });
    readBack.tamper = true;
    const run = await quietly(() => splitter.split(key, contextOf()));
    readBack.tamper = false;
    expect(run.message).toMatch(/trustee 1's share file reads back different from what was written/);
    expect(run.output).toBe('');
    expectNoSecret(run.message, secretsOf(key));
    for (const d of f.destinations) expect(existsSync(d)).toBe(false);
  });

  itOutsideRepo('refuses another key, a context of another archive or escrow intent, a missing archive, and a second run, before writing anything', async () => {
    const otherKey = new Uint8Array(randomBytes(32));
    const other = sealArchive(commitment, key, { escrowIntent: 'trustees-2-of-3' });
    const cases: [Uint8Array, KeySplitContext, RegExp][] = [
      [otherKey, contextOf(), /the key is not the archive's key \(the key ids differ\)/],
      [key, { ...contextOf(), archiveSha256: other.sha256 }, /the archive text is not the archive named by the split context/],
      [key, { ...contextOf(), archiveText: other.text }, /the archive text is not the archive named by the split context/],
      [key, { ...contextOf(), escrowIntent: 'floor-only' }, /the trustee split goes only with trustee escrow \(trustees-2-of-3\)/],
      [key, { archiveSha256: sealed.sha256, keyId: sealed.header.keyId, escrowIntent: 'trustees-2-of-3' }, /the trustee split needs the sealed archive's text/],
      [key.slice(1), contextOf(), /the archive key must be 32 bytes/],
    ];
    const secrets = secretsOf(key).concat(secretsOf(otherKey));
    for (const [k, context, refusal] of cases) {
      const f = folders();
      const run = await quietly(() => new TrusteeKeySplit({ destinations: f.destinations, exportDir: f.exportDir }).split(k, context));
      expect(run.message).toMatch(refusal);
      expect(run.output).toBe('');
      expectNoSecret(run.message, secrets);
      expect(f.destinations.every(nothingIn)).toBe(true);
    }
    const once = await splitInto();
    expect(await rejectionOf(once.splitter.split(key, contextOf()))).toMatch(/this trustee splitter has already run/);
  });

  describe('a proof that fails (the library faulted): refused, no receipt, nothing left, no secret in the message', () => {
    const cases: [string, (shares: Uint8Array[], real: Combine) => Promise<Uint8Array>, RegExp][] = [
      [
        'trustees 2+3 rebuild a wrong key',
        (() => {
          let pairs = 0;
          return async (shares, real) => {
            const k = await real(shares);
            if (shares.length === 2 && ++pairs === 3) k[0] = (k[0] as number) ^ 1;
            return k;
          };
        })(),
        /trustees 2\+3: the shares do not rebuild the archive's key/,
      ],
      ['the library combines one share alone', async (shares, real) => (shares.length === 1 ? new Uint8Array(key) : real(shares)), /the library combined trustee 1's share alone/],
      [
        "a share of a second split rebuilds the key",
        (() => {
          let pairs = 0;
          return async (shares, real) => (shares.length === 2 && ++pairs > 3 ? new Uint8Array(key) : real(shares));
        })(),
        /a share of a second split of the same key rebuilt it/,
      ],
    ];
    itOutsideRepo.each(cases)('%s', async (_, fault, refusal) => {
      const f = folders();
      const splitter = new TrusteeKeySplit({ destinations: f.destinations, exportDir: f.exportDir });
      shamirFault.combine = fault;
      const run = await quietly(() => splitter.split(key, contextOf()));
      shamirFault.combine = undefined;
      expect(run.value).toBeUndefined();
      expect(run.message).toMatch(refusal);
      expect(run.message).toMatch(/the share files written so far were removed/);
      expect(run.output).toBe('');
      expectNoSecret(run.message, secretsOf(key));
      for (const d of f.destinations) expect(existsSync(d)).toBe(false);
      expect(messageOf(() => splitter.commit())).toMatch(/nothing to commit/);
    });
  });

  itOutsideRepo('a share file in the way (written by someone else after the folders were checked) is never overwritten', async () => {
    const f = folders();
    const splitter = new TrusteeKeySplit({ destinations: f.destinations, exportDir: f.exportDir });
    mkdirSync(f.destinations[2] as string, { mode: 0o700 });
    writeFileSync(join(f.destinations[2] as string, shareFileName(3)), 'not ours');
    const run = await quietly(() => splitter.split(key, contextOf()));
    expect(run.message).toMatch(/creating trustee folder 3 failed \(EEXIST\)/);
    expect(readFileSync(join(f.destinations[2] as string, shareFileName(3)), 'utf8')).toBe('not ours');
    expect(existsSync(f.destinations[0] as string) || existsSync(f.destinations[1] as string)).toBe(false);
  });
});
