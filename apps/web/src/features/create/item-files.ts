/**
 * The item files the creator chose in this visit, by the sha256 of their bytes as uploaded (items are hashed as
 * uploaded, so these files are the exact bytes the spec commits): the pictures and, R74-ART, the 3D models (`<id>.glb`).
 * In memory only: never stored, so a reload keeps the art's hashes (draft.ts) but not these files, and the pictures and
 * models must be added again to go into a BoxSpec file (F-1).
 */
import type { Hex } from './create-model';

let files = new Map<string, Blob>();

/** The files of the art just read; any earlier art's files are let go. */
export function keepItemFiles(next: ReadonlyMap<string, Blob>): void {
  files = new Map([...next].map(([sha256, file]) => [sha256.toLowerCase(), file]));
}

/** The file whose bytes hash to `sha256`, or null when this visit did not read it. */
export const itemFileOf = (sha256: Hex): Blob | null => files.get(sha256.toLowerCase()) ?? null;

/** Start over (and tests): no files. */
export const forgetItemFiles = (): void => { files = new Map(); };
