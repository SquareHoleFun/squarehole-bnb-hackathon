/**
 * Test-only access to the immutable handoff (read-only). Never imported by runtime code.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FeedFixture } from '../schemas';

export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const HANDOFF_ROOT = `${REPO_ROOT}square-hole-handoff/`;

export function readHandoffText(relativePath: string): string {
  return readFileSync(`${HANDOFF_ROOT}${relativePath}`, 'utf8');
}

export function readHandoffJson(relativePath: string): unknown {
  return JSON.parse(readHandoffText(relativePath)) as unknown;
}

/** A fresh, independent copy of `fixtures/feed.json` on every call (safe to mutate in a test). */
export function handoffFixture(): FeedFixture {
  return readHandoffJson('fixtures/feed.json') as FeedFixture;
}

type PathKey = string | number;

function parentOf(root: unknown, path: readonly PathKey[]): Record<PathKey, unknown> {
  let node: unknown = root;
  for (const key of path.slice(0, -1)) {
    if (typeof node !== 'object' || node === null) throw new Error(`no container at ${path.join('.')}`);
    node = (node as Record<PathKey, unknown>)[key];
  }
  if (typeof node !== 'object' || node === null) throw new Error(`no container at ${path.join('.')}`);
  return node as Record<PathKey, unknown>;
}

function lastKey(path: readonly PathKey[]): PathKey {
  const key = path.at(-1);
  if (key === undefined) throw new Error('empty path');
  return key;
}

/** Sets a value at a JSON path in a test copy, allowing deliberately invalid types. */
export function setAt(root: unknown, path: readonly PathKey[], value: unknown): void {
  parentOf(root, path)[lastKey(path)] = value;
}

export function deleteAt(root: unknown, path: readonly PathKey[]): void {
  const parent = parentOf(root, path);
  const key = lastKey(path);
  if (Array.isArray(parent)) {
    parent.splice(Number(key), 1);
    return;
  }
  Reflect.deleteProperty(parent, key);
}
