/**
 * Boxes created on the creation page in the Demo (box creation flow § 6; F69 C1 "multiple sets"): mock data, labelled
 * Demo everywhere, never deployed. Each box is kept as its encoded BoxSpec (the bytes a factory would receive) plus its
 * site record (§ 4: who created it, the rights confirmation, the links) and a little display data (when, a logo
 * thumbnail, a collection cover thumbnail, a few item thumbnails, the banner and up to 4 teasers), the last 20 of this
 * tab, in sessionStorage (best effort: every access in try/catch; memory when storage is blocked or full), so a reload
 * keeps them.
 *
 * Stored entries are untrusted on read: each is decoded and validated again (`validateBoxSpecV1` against the version
 * context, with the Demo's rules: holder payouts are offered there, F74 U1), its hash recomputed, its pictures accepted
 * only as small image data URLs (shown through <img> only, BC-095), its links only as https text, its rights record
 * only for this spec. Anything else is dropped.
 */
import { BoxType, CONTEXT_V2, Reason, decodeBoxSpecV1, encodeBoxSpecV1, specHash, validateBoxSpecV1, type BoxSpecV1 } from '@squarehole/box-spec';
import { DEMO_CHAIN_ID, type Address } from '@squarehole/domain';
import { useSyncExternalStore } from 'react';
import { formatBoxId } from './box-id';
import { NO_LINKS, type BoxRecord, type SiteLinks } from './box-model';
import { cleanLinks } from './site-links';
import { demoTokenFor, recordFromSpec } from './spec-record';

// Renamed from sh.boxes.demo-created.v1 (SH-V2-FE8, F130): the privacy notice shows the key. Tab-only, so nothing to migrate.
const STORAGE_KEY = 'sh.boxes.sample-created.v1';
const MAX_BOXES = 20;
/** A cover thumbnail as a data URL: about 60 kB of picture. */
export const MAX_COVER_URL_CHARS = 90_000;
/** These boxes are the Demo's: checked with its rules (F74 U1). */
const NETWORK = 'demo' as const;
/** One item thumbnail: about 15 kB. */
export const MAX_THUMB_URL_CHARS = 24_000;
export const MAX_THUMBS = 8;
/** The collection page's banner, wide: about 60 kB of picture. */
export const MAX_BANNER_URL_CHARS = 90_000;
/** At most 4 teasers (add-on 6), each like an item thumbnail. */
export const MAX_TEASERS = 4;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** An encoded spec (the largest metadata table is 24,575 bytes; hex doubles it). */
const MAX_ENCODED_CHARS = 120_000;
const IMAGE_URL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * The rights confirmation (F70 step 5; box creation flow § 4.2): made by the Create press, kept with the site record,
 * never in the spec. `statement` names the wording version the creator ticked.
 */
export interface RightsRecord {
  readonly specHash: `0x${string}`;
  readonly creator: Address;
  readonly statement: string;
  readonly confirmedAt: string;
}

export interface CreatedBoxEntry {
  readonly spec: BoxSpecV1;
  readonly specHash: `0x${string}`;
  readonly createdAtMs: number;
  readonly coverUrl: string | null;
  /** A new collection's own cover (field 28), as a thumbnail; null for "Token" or when not kept. */
  readonly collectionCoverUrl: string | null;
  readonly thumbs: readonly string[];
  readonly bannerUrl: string | null;
  readonly teaserUrls: readonly string[];
  readonly links: SiteLinks;
  readonly rights: RightsRecord | null;
}

interface StoredEntry {
  readonly encoded: string;
  readonly createdAtMs: number;
  readonly coverUrl: string | null;
  readonly collectionCoverUrl: string | null;
  readonly thumbs: readonly string[];
  readonly bannerUrl: string | null;
  readonly teaserUrls: readonly string[];
  readonly links: SiteLinks;
  readonly rights: RightsRecord | null;
}

let cache: readonly CreatedBoxEntry[] | null = null;
const listeners = new Set<() => void>();

const imageUrl = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && IMAGE_URL.test(value);

/** Links as stored: each one kept only when it passes the site's link check (site-links.ts); never the box dropped. */
export function readLinks(value: unknown): SiteLinks {
  if (typeof value !== 'object' || value === null) return NO_LINKS;
  const v = value as Record<string, unknown>;
  const text = (key: string) => (typeof v[key] === 'string' && (v[key] as string).length <= 400 ? (v[key] as string) : '');
  return cleanLinks({ website: text('website'), x: text('x'), telegram: text('telegram') });
}

/** A rights record as stored: for this spec, a creator address, a statement version and a time; else none. */
function readRights(value: unknown, hash: `0x${string}`): RightsRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  if (r.specHash !== hash || typeof r.creator !== 'string' || !ADDRESS.test(r.creator)) return null;
  if (typeof r.statement !== 'string' || r.statement.length > 40 || typeof r.confirmedAt !== 'string' || Number.isNaN(Date.parse(r.confirmedAt))) return null;
  return Object.freeze({ specHash: hash, creator: r.creator as Address, statement: r.statement, confirmedAt: r.confirmedAt });
}

/** A stored entry, decoded and validated again; null when anything about it is off. */
function readEntry(value: unknown): CreatedBoxEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.encoded !== 'string' || entry.encoded.length > MAX_ENCODED_CHARS || !/^0x(?:[0-9a-f]{2})+$/.test(entry.encoded)) return null;
  if (typeof entry.createdAtMs !== 'number' || !Number.isSafeInteger(entry.createdAtMs) || entry.createdAtMs < 0) return null;
  const coverUrl = entry.coverUrl === null ? null : imageUrl(entry.coverUrl, MAX_COVER_URL_CHARS) ? entry.coverUrl : undefined;
  if (coverUrl === undefined) return null;
  // Entries stored before F74 U3 have no collection cover thumbnail.
  const collectionCoverUrl = entry.collectionCoverUrl === undefined || entry.collectionCoverUrl === null ? null : imageUrl(entry.collectionCoverUrl, MAX_COVER_URL_CHARS) ? entry.collectionCoverUrl : undefined;
  if (collectionCoverUrl === undefined) return null;
  if (!Array.isArray(entry.thumbs) || entry.thumbs.length > MAX_THUMBS || !entry.thumbs.every((thumb) => imageUrl(thumb, MAX_THUMB_URL_CHARS))) return null;
  const bannerUrl = entry.bannerUrl === undefined || entry.bannerUrl === null ? null : imageUrl(entry.bannerUrl, MAX_BANNER_URL_CHARS) ? entry.bannerUrl : undefined;
  if (bannerUrl === undefined) return null;
  const teasers = entry.teaserUrls ?? [];
  if (!Array.isArray(teasers) || teasers.length > MAX_TEASERS || !teasers.every((url) => imageUrl(url, MAX_THUMB_URL_CHARS))) return null;
  try {
    const spec = decodeBoxSpecV1(entry.encoded as `0x${string}`);
    if (validateBoxSpecV1(spec, CONTEXT_V2, NETWORK).reason !== Reason.OK) return null;
    const hash = specHash(spec);
    return Object.freeze({
      spec,
      specHash: hash,
      createdAtMs: entry.createdAtMs,
      coverUrl,
      collectionCoverUrl,
      thumbs: Object.freeze([...(entry.thumbs as string[])]),
      bannerUrl,
      teaserUrls: Object.freeze([...(teasers as string[])]),
      links: readLinks(entry.links),
      rights: readRights(entry.rights, hash),
    });
  } catch {
    return null;
  }
}

function load(): readonly CreatedBoxEntry[] {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed.slice(-MAX_BOXES).flatMap((value) => {
      const entry = readEntry(value);
      if (!entry || seen.has(entry.specHash)) return [];
      seen.add(entry.specHash);
      return [entry];
    });
  } catch {
    return [];
  }
}

/** True when the list was stored; false when storage is blocked or full (the boxes stay in memory for this page load). */
function save(entries: readonly CreatedBoxEntry[]): boolean {
  const stored: StoredEntry[] = entries.map((entry) => ({
    encoded: encodeBoxSpecV1(entry.spec),
    createdAtMs: entry.createdAtMs,
    coverUrl: entry.coverUrl,
    collectionCoverUrl: entry.collectionCoverUrl,
    thumbs: entry.thumbs,
    bannerUrl: entry.bannerUrl,
    teaserUrls: entry.teaserUrls,
    links: entry.links,
    rights: entry.rights,
  }));
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    return true;
  } catch {
    return false;
  }
}

/** The created boxes of this tab, oldest first. */
export function createdBoxEntries(): readonly CreatedBoxEntry[] {
  if (cache === null) cache = load();
  return cache;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCreatedBoxes(): readonly CreatedBoxEntry[] {
  return useSyncExternalStore(subscribe, createdBoxEntries, createdBoxEntries);
}

/** The Demo box id of a spec: its deterministic Demo token on the demo chain. */
export function demoBoxIdFor(hash: `0x${string}`): string {
  return formatBoxId(DEMO_CHAIN_ID, demoTokenFor(hash));
}

/** `kept`: the box list was stored for a reload (false: storage full or blocked; the box is gone after a reload). */
export type AddResult = { readonly status: 'created' | 'duplicate'; readonly id: string; readonly token: Address; readonly kept: boolean };

export interface CreatedBoxMeta {
  readonly createdAtMs: number;
  readonly coverUrl: string | null;
  readonly collectionCoverUrl?: string | null;
  readonly thumbs: readonly string[];
  readonly bannerUrl?: string | null;
  readonly teaserUrls?: readonly string[];
  readonly links?: SiteLinks;
  /** The rights confirmation the Create press made; its specHash must be this spec's. */
  readonly rights?: RightsRecord | null;
}

/**
 * Adds a validated spec as a Demo box (newest last; the 20 newest are kept). The same spec twice is the same box: the
 * second time nothing is added and its id comes back as a duplicate. Throws when the spec does not validate.
 */
export function addCreatedBox(spec: BoxSpecV1, meta: CreatedBoxMeta): AddResult {
  const verdict = validateBoxSpecV1(spec, CONTEXT_V2, NETWORK);
  if (verdict.reason !== Reason.OK) throw new Error(`The spec does not validate (reason ${verdict.reason}, field ${verdict.field})`);
  const hash = specHash(spec);
  const token = demoTokenFor(hash);
  const id = formatBoxId(DEMO_CHAIN_ID, token);
  const current = createdBoxEntries();
  if (current.some((entry) => entry.specHash === hash)) return { status: 'duplicate', id, token, kept: true };
  const coverUrl = meta.coverUrl !== null && imageUrl(meta.coverUrl, MAX_COVER_URL_CHARS) ? meta.coverUrl : null;
  const collection = spec.boxType !== BoxType.TOKEN_ONLY;
  const collectionCoverUrl = collection && meta.collectionCoverUrl !== undefined && meta.collectionCoverUrl !== null && imageUrl(meta.collectionCoverUrl, MAX_COVER_URL_CHARS) ? meta.collectionCoverUrl : null;
  const thumbs = meta.thumbs.filter((thumb) => imageUrl(thumb, MAX_THUMB_URL_CHARS)).slice(0, MAX_THUMBS);
  const bannerUrl = meta.bannerUrl !== undefined && meta.bannerUrl !== null && imageUrl(meta.bannerUrl, MAX_BANNER_URL_CHARS) ? meta.bannerUrl : null;
  const teaserUrls = (meta.teaserUrls ?? []).filter((url) => imageUrl(url, MAX_THUMB_URL_CHARS)).slice(0, MAX_TEASERS);
  const entry: CreatedBoxEntry = Object.freeze({
    spec,
    specHash: hash,
    createdAtMs: meta.createdAtMs,
    coverUrl,
    collectionCoverUrl,
    thumbs: Object.freeze(thumbs),
    bannerUrl,
    teaserUrls: Object.freeze(teaserUrls),
    links: readLinks(meta.links ?? NO_LINKS),
    rights: meta.rights ? readRights(meta.rights, hash) : null,
  });
  cache = Object.freeze([...current, entry].slice(-MAX_BOXES));
  const kept = save(cache);
  listeners.forEach((listener) => listener());
  return { status: 'created', id, token, kept };
}

/** The created boxes as box records, newest first in the feed's "New" order (above the five Demo boxes). */
export function createdBoxRecords(entries: readonly CreatedBoxEntry[], nowMs: number): BoxRecord[] {
  return entries.map((entry, index) =>
    recordFromSpec(entry.spec, entry.specHash, {
      chainId: DEMO_CHAIN_ID,
      networkLabel: 'Local chain 31337',
      token: demoTokenFor(entry.specHash),
      demo: true,
      order: 100 + index,
      coverUrl: entry.coverUrl,
      collectionCoverUrl: entry.collectionCoverUrl,
      thumbs: entry.thumbs,
      createdAtMs: entry.createdAtMs,
      nowMs,
      bannerUrl: entry.bannerUrl,
      teaserUrls: entry.teaserUrls,
      links: entry.links,
      creator: entry.rights?.creator ?? null,
    }),
  );
}

/** Test seam: forget the cached list (the next read loads storage again). */
export function resetCreatedBoxesForTests(): void {
  cache = null;
  listeners.forEach((listener) => listener());
}
