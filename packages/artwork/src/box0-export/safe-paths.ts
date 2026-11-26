/**
 * Where box 0's secrets may go: never inside a git working tree (so no salt, record, key or key share can be committed
 * by accident), never over an existing file (a second run makes new salts and a new root; the first archive must
 * survive). Symbolic links are followed, including a dangling one at the end of the path: a link into a repository is
 * inside it. One implementation for the CLI (scripts/box/lib/safe-paths.mjs re-exports it) and the trustee splitter.
 */
import { accessSync, constants, existsSync, lstatSync, readlinkSync, realpathSync, statSync, writeFileSync, type Stats } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/** A refusal whose message is safe to print: it names paths and fields, never a secret. */
export class Refusal extends Error {}

const MAX_LINKS = 40;

/** lstat that treats a missing path, or one under a file, as absent. */
function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

/**
 * Where `path` really lands: the realpath of its nearest existing ancestor joined with the rest. A dangling link on
 * the way (one realpath cannot follow) is read and followed by hand.
 */
export function realPathOf(path: string, links = 0): string {
  if (links > MAX_LINKS) throw new Refusal(`${path} goes through more than ${MAX_LINKS} symbolic links`);
  let dir = resolve(path);
  let rest: string[] = [];
  for (;;) {
    const stat = lstatOrNull(dir);
    if (stat?.isSymbolicLink() && !existsSync(dir)) {
      return realPathOf(join(resolve(dirname(dir), readlinkSync(dir)), ...rest), links + 1);
    }
    if (stat) return join(realpathSync(dir), ...rest);
    const up = dirname(dir);
    if (up === dir) return join(dir, ...rest);
    rest = [basename(dir), ...rest];
    dir = up;
  }
}

function treeAbove(start: string): string | null {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** The nearest folder at or above `path`, as written or where its links lead, that holds a `.git` entry, or null. */
export function gitWorkTreeOf(path: string): string | null {
  return treeAbove(resolve(path)) ?? treeAbove(realPathOf(path));
}

export function assertOutsideGit(path: string, what: string): void {
  const tree = gitWorkTreeOf(path);
  if (tree) throw new Refusal(`${what} ${path} is inside a git working tree (${tree}); choose a folder outside any repository`);
}

/** Whether anything (a dangling symbolic link included) is at `path`. */
export function isTaken(path: string): boolean {
  return existsSync(path) || lstatOrNull(path) !== null;
}

export function assertNew(path: string, what: string): void {
  if (isTaken(path)) throw new Refusal(`${what} ${path} already exists; nothing is overwritten (a new run makes new salts)`);
}

/** Refuses `path` unless the folder it would be made in (where its links lead) exists now and is writable. */
export function assertWritableParent(path: string, what: string): void {
  const parent = dirname(realPathOf(path));
  let isFolder: boolean;
  try {
    isFolder = statSync(parent).isDirectory();
  } catch {
    isFolder = false;
  }
  if (!isFolder) throw new Refusal(`the parent of ${what} ${path} is not an existing folder`);
  try {
    accessSync(parent, constants.W_OK);
  } catch {
    throw new Refusal(`the parent of ${what} ${path} is not writable`);
  }
}

/** Writes a new file (fails if it exists) with `mode`. */
export function writeNew(path: string, text: string, mode: number): void {
  writeFileSync(path, text, { flag: 'wx', mode });
}
