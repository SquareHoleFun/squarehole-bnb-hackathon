/**
 * The draft being built (box creation flow § 6 "Draft restored"): one per tab, kept in memory across the steps and in
 * sessionStorage so a reload keeps it (best effort: every access in try/catch). Five keys, each written only when its
 * part changes: the choices (typing is saved 300 ms after the last change, and at once when the page is hidden), the
 * art (up to 10,000 items' hashes, salts and traits; R74-ART: each item's model hash and size, never the model's
 * bytes, so a reload asks for the files again before a BoxSpec file), the processed logo and collection cover (the bytes the spec
 * commits to) and the collection page's banner and teasers. Only derived data is kept (hashes, traits, salts, small
 * thumbnails, re-encoded pictures), never the files as chosen. Storage is untrusted: a stored draft is checked field by
 * field and dropped whole when anything is off.
 *
 * SH-256: a fresh document gets back the whole draft or a clean start, never a mix. The choices' key also holds the v2
 * flow's own part (v2/v2-stored.ts: the price coin, both fee sides, the pick fee, the pile, the shop, the deadline, the
 * template and whether a setup was loaded), written at once when it changes, and a print of each companion part (the
 * art, the logo, the collection cover, the page's pictures: counts and hashes, `partsOf`); a part that is missing (it
 * did not fit, say) or is not the one printed gives a clean start, as do a draft without a v2 part (saved by the
 * version before), a loaded setup and a v1 draft (`sh.create.*.v1`, whose keys and the five go at once). A draft that
 * did not come back keeps its keys (a lost tab's salts are in the art key) until the first change, which removes them
 * all before it is written. A document back from the back/forward cache reads storage again (`pageshow`).
 */
import { MAX_RAW_BLOCK_BYTES, sha256Hex } from '@squarehole/artwork';
import { CONTEXT_V2, NETWORKS } from '@squarehole/box-spec';
import { useSyncExternalStore } from 'react';
import { MAX_BANNER_URL_CHARS, MAX_COVER_URL_CHARS, MAX_THUMBS, MAX_THUMB_URL_CHARS } from '../boxes/created-boxes';
import { pairAllowed } from '../boxes/fee-kinds';
import { offeredSomewhere } from '../boxes/spec-network';
import { MAX_PROBLEM_LINES, artBytes, fromBase64 } from './art-files';
import {
  CAP_EXCESS_KEY,
  CAP_PRESETS,
  DEFAULT_FORM,
  DEADLINE_DAYS,
  EMPTY_PAGE,
  MAX_TEASERS,
  OPEN_PRESETS,
  Q_ASSETS,
  ROYALTY_BPS,
  utcFieldValue,
  type ArtItem,
  type ArtState,
  type CoverState,
  type CreateForm,
  type Hex,
  type PageState,
  type RevealAck,
} from './create-model';
import { lockedDraft } from './v2/load-settings';
import { EMPTY_MONEY, moneyJson, readMoney, type DraftMoney } from './v2/v2-stored';
import { TESTNET } from '../data-source/testnet';

const STORAGE_KEY = 'sh.create.draft.v2';
const ART_KEY = 'sh.create.art.v2';
const COVER_KEY = 'sh.create.cover.v2';
const COLLECTION_COVER_KEY = 'sh.create.collection-cover.v2';
const PAGE_KEY = 'sh.create.page.v2';
const DRAFT_KEYS = [STORAGE_KEY, ART_KEY, COVER_KEY, COLLECTION_COVER_KEY, PAGE_KEY] as const;
/** v1's keys: when one is found, it and the five v2 keys are removed and the page starts clean (SH-256). */
const V1_KEYS = Object.freeze({ draft: 'sh.create.draft.v1', art: 'sh.create.art.v1', cover: 'sh.create.cover.v1' });
/** Typing is saved this long after the last change (the whole draft is never re-serialised per keystroke). */
export const SAVE_DELAY_MS = 300;
/** One raw block (1 MiB) as base64. */
const MAX_COVER_DATA_CHARS = Math.ceil(MAX_RAW_BLOCK_BYTES / 3) * 4;

export interface Draft {
  readonly form: CreateForm;
  readonly art: ArtState | null;
  /** The logo (field 23): the token's and the card's picture. */
  readonly cover: CoverState | null;
  /** A new collection's own cover (field 28, F74 U3), its own upload; kept while "Token" is picked, not used then. */
  readonly collectionCover: CoverState | null;
  /** The collection page's banner and teasers (add-on 6). */
  readonly page: PageState;
  /**
   * Hidden art: the reveal file was saved for this commitment (its format and root, create-model `revealAckFor`); the
   * pages count it only while it is the current commitment's (`revealSavedFor`), and a new art voids it. SH-AI-PLAN fix
   * round 2: a draft stored with the earlier bare `revealSaved: true` restores with none.
   */
  readonly revealSavedFor: RevealAck | null;
  /** This draft came back from storage (the page says "Draft restored"). */
  readonly restored: boolean;
  /** It came back with its fee cap off: it was saved with a share of the raise (before F74 U2); said with "Draft restored". */
  readonly capReset: boolean;
}

export const EMPTY_DRAFT: Draft = Object.freeze({ form: DEFAULT_FORM, art: null, cover: null, collectionCover: null, page: EMPTY_PAGE, revealSavedFor: null, restored: false, capReset: false });

/** A stored form with a share-of-the-raise cap that was on (F74 U2 replaced it with fixed amounts): restored with the cap off. */
const hadShareCap = (value: unknown): boolean => {
  const f = value as Record<string, unknown> | null;
  return typeof f === 'object' && f !== null && f.capPerEpoch === undefined && typeof f.capBps === 'number' && f.capBps > 0;
};

let current: Draft | null = null;
/** SH-256: the v2 flow's part, read and written with `current` (v2/v2-draft.ts reads it through `currentMoney`). */
let money: DraftMoney = EMPTY_MONEY;
/** The stored draft did not come back whole: its keys are removed before the first change is written. */
let stale = false;
const listeners = new Set<() => void>();

const HEX32 = /^0x[0-9a-f]{64}$/;

/** A stored reveal acknowledgement (a format and a root), or null for anything else: a bare yes counts as not saved. */
function readAck(value: unknown): RevealAck | null {
  const ack = value as Record<string, unknown> | null;
  if (typeof ack !== 'object' || ack === null || !Number.isSafeInteger(ack.format) || typeof ack.root !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(ack.root)) return null;
  return { format: ack.format as number, root: ack.root as Hex };
}
const IMAGE_URL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const isString = (value: unknown, max = 2_048): value is string => typeof value === 'string' && value.length <= max;
const imageUrl = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && IMAGE_URL.test(value);

/** A draft saved before the opening became a clock time (F80) named its preset by a delay in blocks. */
const PRESET_OF_BLOCKS: Readonly<Record<number, string>> = Object.freeze({ 1: 'now', 25: '5m', 300: '1h', 7_200: '24h' });

function readOpen(value: unknown): CreateForm['open'] | null {
  const open = value as Record<string, unknown> | null;
  if (!open) return null;
  if (open.kind === 'preset' && OPEN_PRESETS.some((preset) => preset.id === open.id)) return { kind: 'preset', id: open.id as string };
  if (open.kind === 'preset' && typeof open.blocks === 'number' && PRESET_OF_BLOCKS[open.blocks]) return { kind: 'preset', id: PRESET_OF_BLOCKS[open.blocks] as string };
  if (open.kind === 'time' && isString(open.utc, 40)) return { kind: 'time', utc: open.utc };
  // Before F80 the time field was this browser's local time: the same moment, written in UTC (unreadable text is kept).
  if (open.kind === 'time' && isString(open.at, 40)) {
    const ms = Date.parse(open.at);
    return { kind: 'time', utc: Number.isFinite(ms) ? utcFieldValue(ms) : open.at };
  }
  return null;
}

function readSpecials(value: unknown): CreateForm['specials'] | null {
  if (!Array.isArray(value) || value.length > 12) return null;
  const rows = value.map((row: unknown) => row as Record<string, unknown>);
  if (!rows.every((row) => row && isString(row.label, 64) && isString(row.count, 12))) return null;
  return rows.map((row) => ({ label: row.label as string, count: row.count as string }));
}

function readForm(value: unknown): CreateForm | null {
  if (typeof value !== 'object' || value === null) return null;
  const f = value as Record<string, unknown>;
  const strings = ['name', 'ticker', 'collectionName', 'collectionSymbol', 'description', 'ticketLine', 'hiddenLine', 'firstIn', 'ownerText', 'pageLink'] as const;
  if (!strings.every((key) => isString(f[key]))) return null;
  const booleans = ['separateCollection', 'storeAll', 'pageLinkEdited', 'rights'] as const;
  if (!booleans.every((key) => typeof f[key] === 'boolean')) return null;
  const links = f.links as Record<string, unknown> | null;
  if (typeof links !== 'object' || links === null || !isString(links.website, 400) || !isString(links.x, 400) || !isString(links.telegram, 400)) return null;
  if (f.contents !== null && f.contents !== 'token' && f.contents !== 'collection') return null;
  if (f.artMode !== 'open' && f.artMode !== 'hidden') return null;
  if (typeof f.qIndex !== 'number' || !Number.isInteger(f.qIndex) || Q_ASSETS[f.qIndex] === undefined) return null;
  // F74 U5: the raise is the version's (`raiseOf`), never stored; a draft saved with a chosen one ignores it.
  if (typeof f.deadlineDays !== 'number' || !DEADLINE_DAYS.includes(f.deadlineDays)) return null;
  // F74 U1: a value some network offers is kept (holder payouts: the Demo); where it is not offered the gate names it.
  if (typeof f.qStream !== 'number' || !offeredSomewhere('qStream', f.qStream) || typeof f.tStream !== 'number' || !offeredSomewhere('tStream', f.tStream)) return null;
  // A pair the factory refuses everywhere (BP-13, Burn ETH without a real burn) is not a draft this page made.
  const { qStream, tStream } = f;
  if (!NETWORKS.some((network) => pairAllowed(qStream, tStream, Q_ASSETS[f.qIndex as number], CONTEXT_V2, network))) return null;
  // F74 U2: a fixed amount per 30 days (decimal string); a draft saved with a share of the raise (capBps) has its cap off.
  const capText = typeof f.capPerEpoch === 'string' ? f.capPerEpoch : f.capPerEpoch === undefined && typeof f.capBps === 'number' ? '0' : null;
  if (capText === null || !/^[0-9]{1,40}$/.test(capText) || !CAP_PRESETS.includes(BigInt(capText))) return null;
  if (typeof f.capExcess !== 'number' || !offeredSomewhere(CAP_EXCESS_KEY, f.capExcess)) return null;
  if (typeof f.royaltyBps !== 'number' || !ROYALTY_BPS.includes(f.royaltyBps)) return null;
  if (f.royaltyTo !== 'fees' && f.royaltyTo !== 'creator' && f.royaltyTo !== 'pool') return null;
  const open = readOpen(f.open);
  const specials = readSpecials(f.specials);
  if (!open || !specials) return null;
  // SH-EX-O1: a loaded setup's own hidden picture (at most the add-on's 4,096 characters); a draft saved before has none.
  const hiddenSvg = f.hiddenSvg === undefined ? DEFAULT_FORM.hiddenSvg : isString(f.hiddenSvg, 4_096) ? f.hiddenSvg : null;
  if (hiddenSvg === null) return null;
  return {
    qIndex: f.qIndex,
    name: f.name as string,
    ticker: f.ticker as string,
    description: f.description as string,
    links: { website: links.website as string, x: links.x as string, telegram: links.telegram as string },
    contents: f.contents,
    separateCollection: f.separateCollection as boolean,
    collectionName: f.collectionName as string,
    collectionSymbol: f.collectionSymbol as string,
    // SH-258: a draft restored where the test network has no hidden draws (or no permanent storage) is open, unstored.
    artMode: TESTNET.switches.draws ? f.artMode : 'open',
    specials,
    ticketLine: f.ticketLine as string,
    hiddenLine: f.hiddenLine as string,
    hiddenSvg,
    royaltyBps: f.royaltyBps,
    royaltyTo: f.royaltyTo,
    storeAll: TESTNET.switches.arweavePictures ? f.storeAll as boolean : false,
    pageLink: f.pageLink as string,
    pageLinkEdited: f.pageLinkEdited as boolean,
    qStream: f.qStream,
    tStream: f.tStream,
    capPerEpoch: BigInt(capText),
    capExcess: f.capExcess,
    deadlineDays: f.deadlineDays,
    open,
    firstIn: f.firstIn as string,
    rights: f.rights as boolean,
    ownerText: f.ownerText as string,
  };
}

/** A stored item's model: both fields (a non-zero sha256 and a size within one raw block), neither ({}), or undefined. */
function readModel(sha256: unknown, bytes: unknown): Pick<ArtItem, 'modelSha256' | 'modelBytes'> | undefined {
  if (sha256 === undefined && bytes === undefined) return {};
  if (typeof sha256 !== 'string' || !HEX32.test(sha256) || /^0x0{64}$/.test(sha256)) return undefined;
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_RAW_BLOCK_BYTES) return undefined;
  return { modelSha256: sha256 as Hex, modelBytes: bytes };
}

function readArt(value: unknown): ArtState | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'object') return undefined;
  const a = value as Record<string, unknown>;
  if (!Array.isArray(a.items) || a.items.length > 10_000 || !Array.isArray(a.salts) || a.salts.length !== a.items.length) return undefined;
  if (!Array.isArray(a.problems) || !a.problems.every((p) => isString(p, 400)) || a.problems.length > MAX_PROBLEM_LINES) return undefined;
  if (!Array.isArray(a.thumbs) || a.thumbs.length > MAX_THUMBS || !a.thumbs.every((t) => imageUrl(t, MAX_THUMB_URL_CHARS))) return undefined;
  if (!a.salts.every((salt) => typeof salt === 'string' && HEX32.test(salt))) return undefined;
  const items = a.items.map((raw: unknown) => {
    const item = raw as Record<string, unknown>;
    if (!item || typeof item.id !== 'number' || !Number.isInteger(item.id) || typeof item.imageSha256 !== 'string' || !HEX32.test(item.imageSha256)) return null;
    if (typeof item.bytes !== 'number' || !Number.isSafeInteger(item.bytes) || !Array.isArray(item.traits) || item.traits.length > 32) return null;
    const traits = item.traits.map((t: unknown) => t as Record<string, unknown>);
    if (!traits.every((t) => t && isString(t.trait, 255) && isString(t.value, 255))) return null;
    // R74-ART: an item's model, its hash and size together (one raw block at most), or neither (no model: a 2D item).
    const model = readModel(item.modelSha256, item.modelBytes);
    if (model === undefined) return null;
    const read: ArtItem = { id: item.id, imageSha256: item.imageSha256 as Hex, bytes: item.bytes, traits: traits.map((t) => ({ trait: t.trait as string, value: t.value as string })), ...model };
    return read;
  });
  if (items.some((item) => item === null)) return undefined;
  const valid = items as NonNullable<(typeof items)[number]>[];
  if (a.planned !== undefined && a.planned !== true) return undefined;
  // Usable art has a model for every item or for none (art-files `readArt`): a stored mix without problems is not one this page made.
  if (a.problems.length === 0 && valid.some((item) => item.modelSha256 !== undefined) && !valid.every((item) => item.modelSha256 !== undefined)) return undefined;
  return {
    items: valid,
    salts: a.salts as Hex[],
    thumbs: a.thumbs as string[],
    totalBytes: artBytes(valid),
    problems: a.problems as string[],
    // SH-AI-PLAN: numbers this page dealt from a plan (art-plan.ts).
    ...(a.planned === true ? { planned: true } : {}),
  };
}

/**
 * A picture (the logo, the banner, a teaser) from its stored description and its stored bytes: the bytes must be plain
 * base64 of the size given whose sha256 is the one given. Missing bytes (storage was full) give no picture; bytes that
 * do not match drop the draft.
 */
function readPicture(value: unknown, data: string | null, maxUrl = MAX_COVER_URL_CHARS): CoverState | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'object') return undefined;
  const c = value as Record<string, unknown>;
  if (typeof c.sha256 !== 'string' || !HEX32.test(c.sha256) || typeof c.bytes !== 'number' || !Number.isSafeInteger(c.bytes)) return undefined;
  if (c.url !== null && !imageUrl(c.url, maxUrl)) return undefined;
  if (data === null) return null;
  const bytes = data.length <= MAX_COVER_DATA_CHARS ? fromBase64(data) : null;
  if (!bytes || bytes.length !== c.bytes || sha256Hex(bytes) !== c.sha256) return undefined;
  return { sha256: c.sha256 as Hex, url: c.url as string | null, bytes: c.bytes, data };
}

/** The collection page's pictures as stored (each with its bytes inline); undefined when anything is off. */
function readPage(raw: string | null): PageState | undefined {
  if (raw === null) return EMPTY_PAGE;
  const value = JSON.parse(raw) as Record<string, unknown> | null;
  if (typeof value !== 'object' || value === null || !Array.isArray(value.teasers) || value.teasers.length > MAX_TEASERS) return undefined;
  const one = (entry: unknown, maxUrl: number) => (entry === null ? null : readPicture(entry, typeof (entry as { data?: unknown }).data === 'string' ? ((entry as { data: string }).data) : null, maxUrl));
  const banner = one(value.banner ?? null, MAX_BANNER_URL_CHARS);
  const teasers = value.teasers.map((entry) => one(entry, MAX_THUMB_URL_CHARS));
  if (banner === undefined || teasers.some((teaser) => teaser === undefined || teaser === null)) return undefined;
  return { banner, teasers: teasers as CoverState[] };
}

/** The draft's other parts as stored under their own keys (null when not stored). */
export interface StoredParts {
  readonly art?: string | null;
  readonly coverData?: string | null;
  readonly collectionCoverData?: string | null;
  readonly page?: string | null;
}

/** A stored draft, checked; null when nothing usable is stored. */
export function parseStoredDraft(raw: string | null, { art: artRaw = null, coverData = null, collectionCoverData = null, page: pageRaw = null }: StoredParts = {}): Draft | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const form = readForm(value.form);
    const art = artRaw === null ? null : readArt(JSON.parse(artRaw));
    const cover = readPicture(value.cover, coverData);
    // A draft saved before F74 U3 has no collection cover: the page asks for it.
    const collectionCover = value.collectionCover === undefined ? null : readPicture(value.collectionCover, collectionCoverData);
    const page = readPage(pageRaw);
    if (!form || art === undefined || cover === undefined || collectionCover === undefined || page === undefined) return null;
    return { form, art, cover, collectionCover, page, revealSavedFor: art !== null ? readAck(value.revealSavedFor) : null, restored: true, capReset: hadShareCap(value.form) };
  } catch {
    return null;
  }
}

const formJson = (form: CreateForm) => ({ ...form, capPerEpoch: form.capPerEpoch.toString() });

/** Writes one key, or removes it when there is nothing to keep or it does not fit; true when it was kept. */
function put(key: string, value: string | null): boolean {
  try {
    if (value === null) {
      window.sessionStorage.removeItem(key);
      return true;
    }
    window.sessionStorage.setItem(key, value);
    return true;
  } catch {
    try {
      // Too large (a big edition's hashes, a large cover): leave it out; the page asks for it again after a reload.
      window.sessionStorage.removeItem(key);
    } catch {
      // Storage blocked: the draft lives in memory for this page load.
    }
    return false;
  }
}

const pictureJson = (picture: CoverState | null) => (picture ? { sha256: picture.sha256, url: picture.url, bytes: picture.bytes } : null);

/** SH-256 (E3): the art's print, its item count and the sha256 of its stored text, kept per art as it was written or read. */
const artPrints = new WeakMap<ArtState, string>();
const artPrintOf = (items: number, text: string): string => `${items}:${sha256Hex(new TextEncoder().encode(text))}`;
function artPrint(art: ArtState, text?: string): string {
  // H2: the cached print first; the art (up to 10,000 items) is serialised only when it has none.
  const known = artPrints.get(art);
  if (known !== undefined) return known;
  const print = artPrintOf(art.items.length, text ?? JSON.stringify(art));
  artPrints.set(art, print);
  return print;
}

/** What the four companion keys hold for this draft: the art's print and the pictures' hashes (null for none). */
interface Parts { readonly art: string | null; readonly cover: string | null; readonly collectionCover: string | null; readonly page: string | null }
const partsOf = (draft: Draft): Parts => ({
  art: draft.art ? artPrint(draft.art) : null,
  cover: draft.cover?.sha256 ?? null,
  collectionCover: draft.collectionCover?.sha256 ?? null,
  page: draft.page.banner === null && draft.page.teasers.length === 0 ? null : JSON.stringify([draft.page.banner?.sha256 ?? null, draft.page.teasers.map((teaser) => teaser.sha256)]),
});
/** The stored print equals the parts read: four keys, each text or null, the same values. */
function sameParts(stored: unknown, read: Parts): boolean {
  const p = stored as Record<string, unknown> | null;
  if (typeof p !== 'object' || p === null || Object.keys(p).length !== 4) return false;
  const keys = ['art', 'cover', 'collectionCover', 'page'] as const;
  return keys.every((key) => (p[key] === null || typeof p[key] === 'string') && p[key] === read[key]);
}

function saveChoices(draft: Draft, part: DraftMoney = money): void {
  put(STORAGE_KEY, JSON.stringify({ form: formJson(draft.form), cover: pictureJson(draft.cover), collectionCover: pictureJson(draft.collectionCover), revealSavedFor: draft.revealSavedFor, v2: moneyJson(part), parts: partsOf(draft) }));
}

let pending: ReturnType<typeof setTimeout> | null = null;
let flushOnHide = false;

/** Saves typed changes now (a pending save is written at once when the page is hidden or left). */
export function flushDraft(): void {
  if (pending === null) return;
  clearTimeout(pending);
  pending = null;
  if (current !== null) saveChoices(current);
}

function scheduleSave(): void {
  if (pending !== null) clearTimeout(pending);
  pending = setTimeout(flushDraft, SAVE_DELAY_MS);
  if (!flushOnHide && typeof window !== 'undefined') {
    flushOnHide = true;
    window.addEventListener('pagehide', flushDraft);
  }
}

const pageJson = (page: PageState): string | null => (page.banner === null && page.teasers.length === 0 ? null : JSON.stringify(page));

/** Writes what changed: the art and the pictures only when they changed, the choices with them (typing: later). */
function save(before: Draft, next: Draft): void {
  const artChanged = next.art !== before.art;
  const coverChanged = next.cover !== before.cover;
  const collectionCoverChanged = next.collectionCover !== before.collectionCover;
  const pageChanged = next.page !== before.page;
  if (!artChanged && !coverChanged && !collectionCoverChanged && !pageChanged) {
    scheduleSave();
    return;
  }
  if (pending !== null) clearTimeout(pending);
  pending = null;
  if (artChanged) {
    const text = next.art ? JSON.stringify(next.art) : null;
    if (next.art && text !== null) artPrint(next.art, text);
    put(ART_KEY, text);
  }
  if (coverChanged) put(COVER_KEY, next.cover?.data ?? null);
  if (collectionCoverChanged) put(COLLECTION_COVER_KEY, next.collectionCover?.data ?? null);
  if (pageChanged) put(PAGE_KEY, pageJson(next.page));
  // SH-256 (E3): the print names every part as it is in memory; a part that did not fit is missing after a reload, and
  // the draft then starts clean instead of coming back without it.
  saveChoices(next);
}

function read(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * SH-256: the stored draft with its v2 part and every companion part as printed, or a clean start. A v1 draft found
 * starts clean at once: its keys and the five v2 keys are removed (nothing writes a v1 key since 3 October 2026).
 */
function load(): { readonly draft: Draft; readonly part: DraftMoney } {
  if (Object.values(V1_KEYS).some((key) => read(key) !== null)) {
    for (const key of [...Object.values(V1_KEYS), ...DRAFT_KEYS]) put(key, null);
    return { draft: EMPTY_DRAFT, part: EMPTY_MONEY };
  }
  const raw = read(STORAGE_KEY);
  if (raw !== null) {
    const artRaw = read(ART_KEY);
    const draft = parseStoredDraft(raw, { art: artRaw, coverData: read(COVER_KEY), collectionCoverData: read(COLLECTION_COVER_KEY), page: read(PAGE_KEY) });
    if (draft !== null) {
      if (draft.art && artRaw !== null) artPrints.set(draft.art, artPrintOf(draft.art.items.length, artRaw));
      try {
        const value = JSON.parse(raw) as Record<string, unknown>;
        const part = readMoney(value.v2);
        if (part !== null && sameParts(value.parts, partsOf(draft))) return { draft, part };
      } catch {
        // Not a draft this page wrote: a clean start below.
      }
    }
  }
  stale = true;
  return { draft: EMPTY_DRAFT, part: EMPTY_MONEY };
}

/** A loaded setup locks the shared draft (load-settings.ts `lockedDraft`) while its marker is set, in its own document. */
function keepMoney(next: DraftMoney): void {
  money = next;
  guard = next.loaded ? lockedDraft : null;
}

export function currentDraft(): Draft {
  if (current === null) {
    const loaded = load();
    current = loaded.draft;
    keepMoney(loaded.part);
  }
  return current;
}

/** The first write after a draft that did not come back whole removes its keys, so no part of it is restored with the new one. */
function dropStale(): void {
  if (!stale) return;
  stale = false;
  for (const key of DRAFT_KEYS) put(key, null);
}

/** SH-256: the v2 flow's part of this draft (v2/v2-draft.ts). */
export function currentMoney(): DraftMoney {
  currentDraft();
  return money;
}

/**
 * Changes the v2 part and writes it at once with the draft's choices (a click, not typing). An empty draft with the
 * defaults is stored as nothing, as after Start over. A marker set or cleared here locks or unlocks the shared draft.
 */
export function updateMoney(change: (part: DraftMoney) => DraftMoney): void {
  const draft = currentDraft();
  const next = change(money);
  if (next === money) return;
  dropStale();
  keepMoney(next);
  if (pending !== null) clearTimeout(pending);
  pending = null;
  if (draft === EMPTY_DRAFT && next === EMPTY_MONEY) put(STORAGE_KEY, null);
  else saveChoices(draft);
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDraft(): Draft {
  return useSyncExternalStore(subscribe, currentDraft, currentDraft);
}

/** SH-256: the v2 part's listeners are the draft's (one store, one restore). */
export const subscribeDraft = subscribe;

/**
 * What may change the draft (TA-27: a loaded setup keeps its parts, create/v2/load-settings.ts `lockedDraft`): every
 * change passes through it, a late picture read included. Null: every change applies. SH-256: set with the v2 part's
 * loaded marker (`keepMoney`); a fresh document never restores a loaded setup, so it starts unlocked.
 */
export type DraftGuard = (before: Draft, next: Draft) => Draft;
let guard: DraftGuard | null = null;

/** Which draft this is: Start over (and a loaded setup, which starts over first) begins a new one. */
let generation = 0;
export const draftGeneration = (): number => generation;

/** Applies a change, as the guard allows it; a new art voids a saved reveal file's acknowledgement. */
export function updateDraft(change: (draft: Draft) => Draft): void {
  const before = currentDraft();
  const proposed = change(before);
  const next = guard && proposed !== before ? guard(before, proposed) : proposed;
  if (next === before) return;
  current = Object.freeze({ ...next, revealSavedFor: next.art === before.art ? next.revealSavedFor : null });
  // After a draft that did not come back whole, `before` is the empty draft: its keys go, then every part of this one is written.
  dropStale();
  save(before, current);
  listeners.forEach((listener) => listener());
}

function cancelPending(): void {
  if (pending !== null) clearTimeout(pending);
  pending = null;
}

/**
 * Start over: an empty draft with the v2 defaults (no template, no loaded setup, nothing locked), stored as nothing; a
 * read started for the draft before it no longer lands (`draftGeneration`).
 */
export function clearDraft(): void {
  cancelPending();
  generation += 1;
  current = EMPTY_DRAFT;
  stale = false;
  keepMoney(EMPTY_MONEY);
  for (const key of DRAFT_KEYS) put(key, null);
  listeners.forEach((listener) => listener());
}

/** Forget the in-memory draft, its v2 part and any pending save: the next read loads storage again. */
function forgetMemory(): void {
  cancelPending();
  generation += 1;
  current = null;
  stale = false;
  keepMoney(EMPTY_MONEY);
  listeners.forEach((listener) => listener());
}

/**
 * SH-256 (E6): a document the browser kept in its back/forward cache may hold an older draft than the one another
 * document of this tab stored meanwhile; when it comes back it reads storage again, so it never writes its old draft
 * (or part of it) beside the newer one. Its pending typing was saved when it was hidden (`pagehide`).
 */
if (typeof window !== 'undefined') window.addEventListener('pageshow', (event) => { if ((event as PageTransitionEvent).persisted) forgetMemory(); });

/** Test seam: as a fresh document (the next read loads storage again). */
export const resetDraftForTests = forgetMemory;
