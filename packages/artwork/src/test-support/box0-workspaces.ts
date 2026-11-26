/**
 * TEST ONLY for the box 0 exporter's file-writing tests (the CLI, the trustee splitter): temporary workspaces outside
 * the repository, a stand-in repository, and the repository's root. Workspaces are never deleted: after each test they
 * move into the repository's ignored scratch trash (`.cache/trash/<name>`).
 */
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('../../../../', import.meta.url));

const tempRelative = relative(REPO, tmpdir());
/** The lane sandbox may redirect tmpdir into the checkout; a test that writes secrets needs an off-repository one. */
export const outsideRepoTemp = isAbsolute(tempRelative) || tempRelative === '..' || tempRelative.startsWith(`..${sep}`);

/** Workspaces named `<name>-*` in tmpdir; `trash()` (an afterEach) moves this file's workspaces into the trash. */
export function workspaces(name: string) {
  const prefix = join(tmpdir(), `${name}-`);
  const made: string[] = [];
  return {
    make(): string {
      const dir = mkdtempSync(prefix);
      made.push(dir);
      return dir;
    },
    trash(): void {
      for (const dir of made.splice(0)) {
        if (!dir.startsWith(prefix)) throw new Error('unexpected test workspace');
        const trash = join(REPO, '.cache/trash', name);
        mkdirSync(trash, { recursive: true, mode: 0o700 });
        moveInto(dir, join(trash, basename(dir)));
      }
    },
  };
}

/**
 * A rename, or where tmpdir is on another filesystem than the repository (Linux's tmpfs /tmp: EXDEV) a copy that keeps
 * symbolic links as they are, then the removal of the source: the workspace still ends up only in the trash.
 */
function moveInto(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    cpSync(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    rmSync(from, { recursive: true });
  }
}

/** A stand-in repository (a folder with a `.git` entry) in `dir` and a symbolic link to its subfolder `sub`. */
export function fakeRepo(dir: string) {
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'sub'));
  const link = join(dir, 'link');
  symlinkSync(join(repo, 'sub'), link);
  return { repo, sub: join(repo, 'sub'), link };
}
