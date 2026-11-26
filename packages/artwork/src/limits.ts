/**
 * Upload limits (01-PRODUCT Step 2 "validate file signatures, dimensions, size, metadata schema, duplicate IDs and
 * attribute lengths"). One place for the numbers the UI shows and the tests check.
 */
import type { TextRule } from '@squarehole/domain';

export const IMAGE_LIMITS = Object.freeze({
  /** 10 MB per uploaded file (10 × 1024 × 1024 bytes). */
  maxBytes: 10 * 1024 * 1024,
  /** Each side at least 256 px … */
  minSide: 256,
  /** … and at most 4096 px. */
  maxSide: 4096,
  /** A re-encoded PNG larger than this is refused (memory and local draft budget). */
  maxOutputBytes: 48 * 1024 * 1024,
});

/** Accepted upload types, by content (never by file name or browser MIME guess). */
export const ACCEPTED_IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp'] as const);

/** Demo uploads: at most 2,000 NFTs, one image each. */
export const DEMO_MAX_ITEMS = 2000;

/** DN404 NFT ids start at 1 and stop at 2^32 − 2 (ADR-0009, `_totalSupplyOverflows`). */
export const MAX_ITEM_ID = 4_294_967_294n;

export const ATTRIBUTE_LIMITS = Object.freeze({
  key: Object.freeze<TextRule>({ min: 1, max: 64, innerSpaces: true, newlines: false }),
  value: Object.freeze<TextRule>({ min: 1, max: 128, innerSpaces: true, newlines: false }),
  maxPerItem: 32,
  /** 4 MiB of text (about 2,000 items × 32 traits of normal length). */
  maxFileChars: 4 * 1024 * 1024,
  /** Errors listed before "and n more". */
  maxReportedErrors: 12,
});
