/**
 * Secret-shaped input (F73 launch skill) is never repeated. `secretKind` tells one text:
 *   - a private key: 64 hex characters, with or without 0x, also one character short (63 digits and letters: the
 *     missing one is guessed in seconds), and also written in groups ("4c08 83a6 ...", "4c:08:83:...", one per line);
 *   - a recovery phrase: 12 BIP-39 words in a row (so 24 too) with at most one typo, or 11 of them (the twelfth is
 *     guessed in seconds), in any case and joined by anything that is not a letter or digit (spaces, commas, ".", "-",
 *     "/", "_", line breaks); numbering such as "1.", "1)", "1-" or "1legal" is skipped.
 * `secretPaths` finds them anywhere in a JSON document: each value and field name, each list of texts read as one
 * text (a phrase stored one word per item), and the document's texts read together (a phrase split over fields).
 * Fingerprints where the format puts one are not secrets (the spec's bytes32 fields and settings, a download's
 * hashes, salts and its rights record's spec hash). A trait table's values are each a word of their own, so they count
 * as a phrase together only when they are a complete phrase with a valid BIP-39 checksum. The checker then stops with
 * SECRET_MESSAGE and the paths only, never the value. Part of scripts/check-spec.mjs.
 */
import { createHash } from 'node:crypto';
import { english } from 'viem/accounts';
import { FILE_FORMAT, addOnValues } from './spec-input.mjs';

export const SECRET_MESSAGE = 'This looks like a private key or recovery phrase. Never paste it anywhere. Remove it now.';
export const SECRET_ADVICE = 'If it is a real key or phrase, treat that wallet as exposed and move its funds to a new wallet. A box needs only public 0x addresses.';

const INDEX = new Map(english.map((word, i) => [word, i]));
/** 63 or 64 hex characters in a row, not part of a longer hex run (an ABI encoding, a byte string). */
const KEY = /(?<![0-9a-fA-F])(?:0x)?([0-9a-fA-F]{63,64})(?![0-9a-fA-F])/g;
/** A whole token of hex characters (a group of a key written in groups). */
const HEX_GROUP = /(?<![0-9A-Za-z])(?:0x)?([0-9a-fA-F]+)(?![0-9A-Za-z])/g;
const FULL32 = /^0x[0-9a-fA-F]{64}$/;
const WINDOW = 12;
/** Words in a 12-word window that may be outside the BIP-39 list (a typo in a pasted phrase). */
const SLACK = 1;
/** A phrase one word short, every word on the list. */
const PARTIAL = 11;
const KEY_LENGTH = [63, 64];

const nonZero = (hex) => !/^0+$/.test(hex);
/** A key written in groups mixes digits and letters (a run of either alone is a number or ordinary words). */
const keyLike = (hex) => KEY_LENGTH.includes(hex.length) && /\d/.test(hex) && /[a-f]/i.test(hex) && nonZero(hex);

/** A key in one run, or in groups split only by spaces, line breaks or colons. */
function hasKey(text) {
  // 64 in a row: any but zero (a fingerprint of zeros means none). 63: only mixed, as a number can be 63 digits long.
  for (const m of text.matchAll(KEY)) if (m[1].length === 64 ? nonZero(m[1]) : keyLike(m[1])) return true;
  const groups = [...text.matchAll(HEX_GROUP)].map((m) => ({ hex: m[1], start: m.index, end: m.index + m[0].length }));
  for (let i = 0; i < groups.length; i++) {
    let hex = groups[i].hex;
    for (let j = i + 1; j < groups.length && hex.length < KEY_LENGTH[0]; j++) {
      if (!/^[\s:]+$/.test(text.slice(groups[j - 1].end, groups[j].start))) break;
      hex += groups[j].hex;
      if (keyLike(hex)) return true;
    }
  }
  return false;
}

/**
 * The words of a text for the phrase check: split on everything that is not a letter or digit, numbering fused to a
 * word dropped ("1legal", "legal1"), plain numbers left out (so "1. legal 2. winner" reads as "legal winner").
 */
export function wordsOf(text) {
  return String(text)
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.replace(/^\d+(?=[A-Za-z])/, '').replace(/(?<=[A-Za-z])\d+$/, ''))
    .filter((w) => w !== '' && !/^\d+$/.test(w));
}

const isWord = (w) => typeof w === 'string' && /^[a-z]{3,8}$/i.test(w);
const onList = (w) => INDEX.has(w.toLowerCase());

/**
 * The phrase starting at word `i` ([start, end)), or null: 12 words of 3-8 letters with at most SLACK off the BIP-39
 * list, or 11 all on it. A null entry breaks a window (a fingerprint, a list of trait values).
 */
function windowAt(words, i) {
  const twelve = words.slice(i, i + WINDOW);
  if (twelve.length === WINDOW && twelve.every(isWord) && twelve.filter((w) => !onList(w)).length <= SLACK) return [i, i + WINDOW];
  const eleven = words.slice(i, i + PARTIAL);
  return eleven.length === PARTIAL && eleven.every(isWord) && eleven.every(onList) ? [i, i + PARTIAL] : null;
}

/** The first phrase from word `from` on, or null. */
function phraseWindow(words, from = 0) {
  for (let i = from; i + PARTIAL <= words.length; i++) {
    const hit = windowAt(words, i);
    if (hit) return hit;
  }
  return null;
}

/** A complete BIP-39 phrase (12 to 24 words, all on the list) whose checksum is right. */
function isMnemonic(words) {
  const n = words.length;
  if (![12, 15, 18, 21, 24].includes(n) || !words.every((w) => isWord(w) && onList(w))) return false;
  const bits = words.reduce((acc, w) => (acc << 11n) | BigInt(INDEX.get(w.toLowerCase())), 0n);
  const cs = BigInt(n / 3);
  const entropy = (bits >> cs).toString(16).padStart(((n * 11 - n / 3) / 4) | 0, '0');
  const first = createHash('sha256').update(Buffer.from(entropy, 'hex')).digest()[0];
  return BigInt(first) >> (8n - cs) === (bits & ((1n << cs) - 1n));
}

/** 'key', 'phrase' or null for one text. */
export function secretKind(text) {
  if (typeof text !== 'string') return null;
  if (hasKey(text)) return 'key';
  if (phraseWindow(wordsOf(text))) return 'phrase';
  return null;
}

/** A metadata table v1 read to its last byte (so a raw table is not mistaken for a key). */
export function isTableV1(hex) {
  if (!/^0x01(?:[0-9a-fA-F]{2})+$/.test(hex)) return false;
  const b = Buffer.from(hex.slice(2), 'hex');
  let i = 3 + ((b[1] << 8) | b[2]);
  if (i >= b.length) return false;
  for (let t = 0, types = b[i++]; t < types; t++) {
    if (i >= b.length) return false;
    i += 1 + b[i];
    if (i >= b.length) return false;
    for (let v = 0, values = b[i++]; v < values; v++) {
      if (i >= b.length) return false;
      i += 1 + b[i];
    }
  }
  return i === b.length;
}

const DOWNLOAD_HASHES = new Set(['imageSha256', 'avatarSha256', 'modelSha256', 'salt']);

/**
 * The fingerprints a launch-flow download carries besides the spec (apps/web create-model `boxSpecFile`): its spec
 * hash, the logo's, the collection cover's (F74 U3), banner's and teasers' sha256, the rights record's spec hash and open
 * art's reveal list.
 */
function downloadFingerprint(path) {
  const top = path.join('.');
  if (['specHash', 'cover.sha256', 'collectionCover.sha256', 'banner.sha256', 'site.rights.specHash'].includes(top)) return true;
  if (path[0] === 'teasers' && typeof path[1] === 'number' && path[2] === 'sha256' && path.length === 3) return true;
  return path[0] === 'revealList' && path[1] === 'items' && typeof path[2] === 'number' && DOWNLOAD_HASHES.has(String(path[3])) && path.length === 4;
}

/** Whether the value at `path` (segments) is a fingerprint where the format puts one. */
function fingerprintAt(model, doc, specAt, path, value) {
  if (typeof value !== 'string') return false;
  const rest = path.slice(specAt.length);
  const inSpec = specAt.every((s, i) => path[i] === s);
  if (inSpec && rest.length === 1) {
    const f = model.fieldByName.get(rest[0]);
    if (f?.type === 'bytes32') return FULL32.test(value);
    if (f?.type === 'bytes') return isTableV1(value);
  }
  if (inSpec && rest[0] === 'addOns' && rest[2] === 'params') {
    const entry = doc && specAt.reduce((o, s) => o?.[s], doc)?.addOns?.[rest[1]];
    const a = typeof entry?.addOn === 'string' ? model.addOnByKey.get(entry.addOn) : model.addOnById.get(entry?.id);
    // A raw entry's params: ABI data that decodes for its add-on.
    if (rest.length === 3) return typeof entry?.id === 'number' && addOnValues(model, { id: entry.id, params: value }) !== null;
    const p = a?.params.find((x) => x.name === rest[3]);
    if (rest.length === 4) return p?.type === 'bytes32' && FULL32.test(value);
    if (rest.length === 5) return p?.type === 'bytes32[]' && FULL32.test(value);
  }
  // Only a download carries fingerprints beside the spec.
  return doc?.format === FILE_FORMAT && downloadFingerprint(path) && FULL32.test(value);
}

/** Whether `path` is a list of trait values in a draft's trait table (metadataTable.formatV1.traitTypes[i].values). */
function isTraitValues(specAt, path) {
  const rest = path.slice(specAt.length);
  return specAt.every((s, i) => path[i] === s) && rest.length === 5 && rest.join('.').startsWith('metadataTable.formatV1.traitTypes.') && rest[4] === 'values';
}

const pathText = (segments) => segments.reduce((s, x) => (typeof x === 'number' ? `${s}[${x}]` : s === '' ? x : `${s}.${x}`), '');
/** A path without its trailing list positions: the list a word belongs to ("brief[3]" -> "brief"). */
const ownerOf = (segments) => {
  let end = segments.length;
  while (end > 0 && typeof segments[end - 1] === 'number') end -= 1;
  return pathText(segments.slice(0, end)) || '(the whole file)';
};

/**
 * The paths (as text, a secret-shaped field name shown as "<hidden>") of every secret-shaped value, field name, list
 * of texts or run of texts in a parsed JSON document. `specAt` is where the spec sits: ['spec'] for drafts and
 * downloads, [] for a bare spec.
 */
export function secretPaths(model, doc, specAt = ['spec']) {
  const found = [];
  /**
   * Every word of the document in order: `at` the value it came from (a list's items count as the list, a field name
   * as its object's field names), `path` the exact place. A BREAK stops a phrase (a fingerprint, trait values).
   */
  const stream = [];
  const BREAK = { word: null, at: '', path: '' };
  const visit = (value, path, shown) => {
    if (typeof value === 'string') {
      if (fingerprintAt(model, doc, specAt, path, value)) return stream.push(BREAK);
      const exact = pathText(shown) || '(the whole file)';
      if (secretKind(value)) found.push(exact);
      for (const word of wordsOf(value)) stream.push({ word, at: ownerOf(shown), path: exact });
      return undefined;
    }
    if (Array.isArray(value)) {
      if (isTraitValues(specAt, path)) {
        // Trait values are single words by design: a phrase only when they are one, checksum and all.
        if (isMnemonic(value.flatMap((v) => (typeof v === 'string' ? wordsOf(v) : [null])))) found.push(pathText(shown));
        value.forEach((v, i) => typeof v === 'string' && secretKind(v) && found.push(pathText([...shown, i])));
        return stream.push(BREAK);
      }
      value.forEach((v, i) => visit(v, [...path, i], [...shown, i]));
      // The list's texts as one text: a key written one group per item.
      const texts = value.map((v, i) => (typeof v === 'string' && !fingerprintAt(model, doc, specAt, [...path, i], v) ? v : '|'));
      if (texts.length > 1 && hasKey(texts.join(' '))) found.push(pathText(shown) || '(the whole file)');
      return undefined;
    }
    // Numbers, true, false and null are left out, as plain numbers are inside a text.
    if (typeof value !== 'object' || value === null) return undefined;
    const names = `field names in ${pathText(shown) || 'the file'}`;
    for (const [k, v] of Object.entries(value)) {
      const hidden = secretKind(k) !== null;
      const at = [...shown, hidden ? '<hidden>' : k];
      if (hidden) found.push(`${pathText(at)} (a field name)`);
      for (const word of wordsOf(k)) stream.push({ word, at: names, path: `${pathText(at)} (a field name)` });
      visit(v, [...path, k], at);
    }
    return undefined;
  };
  visit(doc, [], []);
  // The document's words read together: a phrase split over list items, fields or field names. Of the windows that
  // overlap, the one drawn from the fewest places names where it is.
  const words = stream.map((s) => s.word);
  for (let hit = phraseWindow(words); hit; ) {
    const windows = [];
    for (let i = hit[0], w = hit; w; w = windowAt(words, ++i)) windows.push(w);
    // A field name between two halves is named only when the phrase is in field names alone.
    const placesOf = (w) => {
      const all = [...new Set(stream.slice(...w).map((s) => s.at))];
      const values = all.filter((p) => !p.startsWith('field names in '));
      return values.length > 0 ? values : all;
    };
    // Fewest places first; on a tie, the window with the fewest words from outside its places, so a phrase in field
    // names that a value's last words run into is named by the field names (sh-f74-spec: royalties lost their
    // recipient, so "POOL_DEPTH" now ends the spec).
    const outside = (w) => stream.slice(...w).filter((s) => !placesOf(w).includes(s.at)).length;
    const better = (a, b) => placesOf(b).length < placesOf(a).length || (placesOf(b).length === placesOf(a).length && outside(b) < outside(a));
    const best = windows.reduce((a, b) => (better(a, b) ? b : a));
    const places = placesOf(best);
    const already = stream.slice(...best).some((s) => found.includes(s.path));
    if (!already) found.push(places.length === 1 ? places[0] : `${places.join(', ')} (read together)`);
    hit = phraseWindow(words, windows.at(-1)[1]);
  }
  return [...new Set(found)];
}
