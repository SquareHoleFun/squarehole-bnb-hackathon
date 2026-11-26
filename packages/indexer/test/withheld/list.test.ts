import { mkdirSync, mkdtempSync, writeFileSync, renameSync, statSync, utimesSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createWithheldPictures, parsePictures } from '../../src/withheld/list.mjs';

const id = `ipfs:bafkreia${'a'.repeat(51)}`;
const ar = `ar:${'A'.repeat(43)}`;
const entry = (id: string) => ({ id, reason: 'legal-notice', since: '2026-10-28T12:00:00.000Z' });
const digest = (id: string) => createHash('sha256').update(`sh-withheld-v1:${id}`).digest('hex');
export function fixture() {
  mkdirSync('.cache/tmp', { recursive: true });
  const dir = mkdtempSync(resolve('.cache/tmp/withheld-'));
  const file = join(dir, 'pictures.json');
  let now = 0;
  const warn = vi.fn();
  const list = createWithheldPictures({ file, now: () => now, warn });
  const replace = (text: string) => { writeFileSync(join(dir, 'pending'), text); renameSync(join(dir, 'pending'), file); };
  return { dir, file, warn, list, replace, advance: () => { now += 10_000; } };
}
it('W1: reloads on change time, at most every 10 s; missing means empty', () => {
  const f = fixture();
  expect(f.list.has(id)).toBe(false);
  f.replace(JSON.stringify([entry(id), entry(ar)]));
  expect(f.list.has(id)).toBe(false);
  f.advance();
  expect(f.list.has(id)).toBe(true);
  expect(f.list.snapshot()).toEqual({ version: 1, hashes: [digest(id), digest(ar)].sort() });
  const stamp = statSync(f.file);
  writeFileSync(f.file, JSON.stringify([entry(ar)]));
  utimesSync(f.file, stamp.atime, stamp.mtime); // ctime, not mtime, must detect this update.
  f.advance();
  expect(f.list.has(id)).toBe(false);
  renameSync(f.file, join(f.dir, 'retained.json'));
  f.advance();
  expect(f.list.snapshot()).toEqual({ version: 1, hashes: [] });
  expect(f.warn).not.toHaveBeenCalled();
});
it('W1: malformed JSON or schema retains the last good list; one sanitized warning until recovery', () => {
  const f = fixture(); f.replace(JSON.stringify([entry(id)]));
  expect(f.list.has(id)).toBe(true);
  for (const broken of ['private notice {', JSON.stringify([{ ...entry(ar), description: 'private' }]), 'null']) {
    f.replace(broken); f.advance(); expect(f.list.has(id)).toBe(true);
    f.advance(); expect(f.list.has(id)).toBe(true);
  }
  expect(f.warn).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(f.warn.mock.calls)).not.toMatch(/private|bafkrei|ar:/);
  f.replace('[]'); f.advance(); expect(f.list.has(id)).toBe(false);
  f.replace('{'); f.advance(); f.list.snapshot(); expect(f.warn).toHaveBeenCalledTimes(2);
});
it('W1: a broken first file starts empty and later recovers', () => {
  const f = fixture(); f.replace('{'); expect(f.list.snapshot().hashes).toEqual([]);
  f.replace(JSON.stringify([entry(ar), entry(ar)])); f.advance();
  expect(f.list.snapshot().hashes).toEqual([digest(ar)]);
});
it('W1: strict private schema and canonical supported IDs only', () => {
  expect(parsePictures(JSON.stringify([entry(id), entry(ar)]))).toHaveLength(2);
  for (const patch of [{ id: 'https://bad.invalid/picture' }, { id: `${id}/x` }, { id: `${id.slice(0, -1)}b` },
    { id: 'ar:short' }, { reason: 'taste' }, { since: 'yesterday' }, { since: '2026-02-30' }, { notice: 'private' }]) {
    expect(() => parsePictures(JSON.stringify([{ ...entry(id), ...patch }]))).toThrow();
  }
});
it('W1: unchanged missing or equivalent files keep the same snapshot during a slow card draw', () => {
  const f = fixture(); const empty = f.list.snapshot().hashes;
  f.advance(); expect(f.list.snapshot().hashes).toBe(empty);
  f.replace(JSON.stringify([entry(id)])); f.advance(); const hashes = f.list.snapshot().hashes;
  f.replace(JSON.stringify([{ ...entry(id), reason: 'illegal' }])); f.advance();
  expect(f.list.snapshot().hashes).toBe(hashes);
});
