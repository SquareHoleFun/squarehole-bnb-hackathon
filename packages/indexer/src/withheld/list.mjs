import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync, statSync } from 'node:fs';

export const DEFAULT_PICTURES_FILE = '/srv/squarehole/withheld/pictures.json';
const ID = /^(?:ipfs:bafkrei[a-h][a-z2-7]{50}[aeimquy4]|ar:[A-Za-z0-9_-]{43})$/;
export const validPictureId = id => typeof id === 'string' && ID.test(id);
export const validReason = reason => reason === 'illegal' || reason === 'legal-notice';
const digest = text => createHash('sha256').update(text).digest('hex');
const stamp = stat => `${stat.dev}:${stat.ino}:${stat.ctimeNs}:${stat.mtimeNs}:${stat.size}`;
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value.slice(0, 10);
}

/** No free text or notice data is permitted, even in a hand-edited file. */
export function parsePictures(text) {
  const entries = JSON.parse(text);
  if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry !== 'object'
    || Object.keys(entry).sort().join(',') !== 'id,reason,since'
    || !validPictureId(entry.id) || !validReason(entry.reason) || !validDate(entry.since))) {
    throw new Error('invalid withheld pictures');
  }
  return entries;
}

/** Shared by all three services. Poll on demand, once per 10 s, including failed/missing reads.
 * Synchronous reads keep concurrent callers on one snapshot. Open/fstat pins the inode across a rename.
 * Invalid/unreadable files retain the last good set, with one content-free warning per failure episode.
 */
export function createWithheldPictures({ file = DEFAULT_PICTURES_FILE, now = Date.now, warn = console.warn } = {}) {
  let nextCheck = -Infinity;
  let seen = null;
  let warned = false;
  let ids = new Set();
  let hashes = Object.freeze([]);
  const replace = entries => {
    ids = new Set(entries.map(entry => entry.id));
    const next = [...ids].map(id => digest(`sh-withheld-v1:${id}`)).sort();
    if (next.length !== hashes.length || next.some((hash, i) => hash !== hashes[i])) hashes = Object.freeze(next);
    warned = false;
  };
  const refresh = () => {
    const time = now();
    if (time < nextCheck) return;
    nextCheck = time + 10_000;
    try {
      const current = stamp(statSync(file, { bigint: true }));
      if (current === seen) return;
      const fd = openSync(file, 'r');
      try {
        const opened = fstatSync(fd, { bigint: true });
        if (!opened.isFile()) throw new Error('not a file');
        // A bad version is not parsed again until its change time moves.
        seen = stamp(opened);
        replace(parsePictures(readFileSync(fd, 'utf8')));
      } finally { closeSync(fd); }
    } catch (error) {
      if (error?.code === 'ENOENT') { seen = null; replace([]); return; }
      if (!warned) { warned = true; warn('withheld pictures: unreadable list; retaining last good list'); }
    }
  };
  return {
    has(id) { refresh(); return ids.has(id); },
    snapshot() { refresh(); return { version: 1, hashes }; },
  };
}
