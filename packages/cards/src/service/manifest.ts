/**
 * The core manifest the card service reads, from the file the indexer reads too (/srv/squarehole/manifests on the
 * droplet, mounted read-only): read again when the file changes (looked at no more than every few seconds), so the
 * cards follow the Sepolia broadcast without a restart. A missing file is no manifest; a file that does not parse is an
 * invalid one (both: no box is known, every card is the generic one).
 */
import { readFileSync, statSync } from 'node:fs';

export function manifestFile(path: string | null, checkEveryMs = 5000, now: () => number = Date.now): () => unknown {
  let checkedAt = Number.NEGATIVE_INFINITY;
  let stamp: string | null = null;
  let manifest: unknown = null;
  return () => {
    if (path === null) return null;
    const at = now();
    if (at - checkedAt < checkEveryMs) return manifest;
    checkedAt = at;
    let next: string | null;
    try {
      const info = statSync(path);
      next = `${info.mtimeMs}:${info.size}:${info.ino}`;
    } catch {
      stamp = null;
      manifest = null;
      return manifest;
    }
    if (next !== stamp) {
      stamp = next;
      try {
        manifest = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      } catch {
        manifest = { invalid: true };
      }
    }
    return manifest;
  };
}
