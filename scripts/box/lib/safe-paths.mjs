/**
 * Where box 0's secrets may go (never inside a git working tree, never over an existing file; symbolic links
 * followed). The implementation is packages/artwork/src/box0-export/safe-paths.ts, shared with the trustee splitter;
 * this module re-exports it for the box scripts.
 */
import { importArtwork } from './load-ts.mjs';

const paths = await importArtwork('box0-export/safe-paths.ts');

export const { Refusal, realPathOf, gitWorkTreeOf, isTaken, assertOutsideGit, assertNew, assertWritableParent, writeNew } = paths;
