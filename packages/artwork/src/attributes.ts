/**
 * Attribute files for NFT collections (SH-010; ART-02, ART-03). Untrusted text in, plain `{ trait, value }` strings out.
 *
 * JSON: an array of `{ "id": 1, "attributes": [{ "trait_type": "Background", "value": "Blue" }] }` (or
 * `"attributes": { "Background": "Blue" }`), or an object keyed by id: `{ "1": { "Background": "Blue" } }`.
 * CSV: a header row whose first column is `id`, then one column per trait; an empty cell means "no such trait".
 *
 * The shape is strict: any other field is refused by name. Metadata has no way to express launch terms (reward side,
 * fees, quote asset, supply), so it cannot change them (ART-03), and no URL field exists to fetch or open (ART-06).
 * Every key and value passes the domain text rules (no control or bidi-override characters, bounded length).
 */
import { textIssue } from '@squarehole/domain';
import { normaliseItemId } from './collection';
import { ATTRIBUTE_LIMITS, DEMO_MAX_ITEMS } from './limits';

export interface Attribute {
  readonly trait: string;
  readonly value: string;
}

export type AttributesResult =
  | { readonly ok: true; readonly format: 'json' | 'csv'; readonly items: ReadonlyMap<string, readonly Attribute[]> }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * The caller's limits (SH-AI-PLAN): the demo's 2,000 items and 4 MiB of text by default; the box flow passes its own
 * (10,000 items, as boxes hold), so a traits file is never refused below the collection size a box allows.
 */
export interface AttributesOptions {
  readonly maxItems?: number;
  readonly maxFileChars?: number;
}

class Collector {
  readonly errors: string[] = [];
  add(message: string): void {
    this.errors.push(message);
  }
  result(format: 'json' | 'csv', items: Map<string, Attribute[]>): AttributesResult {
    if (this.errors.length === 0) return { ok: true, format, items };
    const max = ATTRIBUTE_LIMITS.maxReportedErrors;
    if (this.errors.length <= max) return { ok: false, errors: [...this.errors] };
    return { ok: false, errors: [...this.errors.slice(0, max), `…and ${this.errors.length - max} more problems.`] };
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function valueText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  // Trait numbers are display text (e.g. "Level 3"), never amounts; only finite numbers are accepted.
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** Validates one item's traits; returns them in file order. */
function checkTraits(where: string, pairs: readonly (readonly [unknown, unknown])[], errors: Collector): Attribute[] {
  const traits: Attribute[] = [];
  const seen = new Set<string>();
  if (pairs.length > ATTRIBUTE_LIMITS.maxPerItem) {
    errors.add(`${where}: at most ${ATTRIBUTE_LIMITS.maxPerItem} traits per item (found ${pairs.length}).`);
    return traits;
  }
  for (const [rawKey, rawValue] of pairs) {
    const keyIssue = textIssue(rawKey, ATTRIBUTE_LIMITS.key);
    if (keyIssue !== null || typeof rawKey !== 'string') {
      errors.add(`${where}: trait name ${keyIssue ?? 'must be text'}.`);
      continue;
    }
    const value = valueText(rawValue);
    if (value === null) {
      errors.add(`${where}: trait "${rawKey}" value must be text, a number or true/false.`);
      continue;
    }
    const valueIssue = textIssue(value, ATTRIBUTE_LIMITS.value);
    if (valueIssue !== null) {
      errors.add(`${where}: trait "${rawKey}" value ${valueIssue}.`);
      continue;
    }
    if (seen.has(rawKey)) {
      errors.add(`${where}: duplicate trait "${rawKey}".`);
      continue;
    }
    seen.add(rawKey);
    traits.push({ trait: rawKey, value });
  }
  return traits;
}

const ITEM_FIELDS = new Set(['id', 'attributes']);
const TRAIT_FIELDS = new Set(['trait_type', 'value']);

function traitPairs(where: string, attributes: unknown, errors: Collector): (readonly [unknown, unknown])[] | null {
  if (Array.isArray(attributes)) {
    const pairs: (readonly [unknown, unknown])[] = [];
    attributes.forEach((entry, index) => {
      if (!isPlainObject(entry)) {
        errors.add(`${where}: trait ${index + 1} must be an object with "trait_type" and "value".`);
        return;
      }
      const unknown = Object.keys(entry).find((key) => !TRAIT_FIELDS.has(key));
      if (unknown !== undefined) {
        errors.add(`${where}: unknown field "${unknown}" in trait ${index + 1} (allowed: trait_type, value).`);
        return;
      }
      pairs.push([entry.trait_type, entry.value]);
    });
    return pairs;
  }
  if (isPlainObject(attributes)) return Object.entries(attributes);
  errors.add(`${where}: "attributes" must be a list of traits or an object of trait names to values.`);
  return null;
}

function addItem(items: Map<string, Attribute[]>, firstSeen: Map<string, string>, where: string, rawId: unknown, attributes: unknown, errors: Collector): void {
  const id = normaliseItemId(rawId);
  if (!id.ok) {
    errors.add(`${where}: ${id.message}.`);
    return;
  }
  const previous = firstSeen.get(id.id);
  if (previous !== undefined) {
    errors.add(`${where}: duplicate id ${id.id} (also ${previous.toLowerCase()}).`);
    return;
  }
  firstSeen.set(id.id, where);
  const pairs = traitPairs(where, attributes, errors);
  if (pairs !== null) items.set(id.id, checkTraits(where, pairs, errors));
}

function parseJson(text: string, maxItems: number): AttributesResult {
  const errors = new Collector();
  const items = new Map<string, Attribute[]>();
  const firstSeen = new Map<string, string>();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    errors.add('The JSON could not be read (syntax error).');
    return errors.result('json', items);
  }
  if (Array.isArray(data)) {
    if (data.length > maxItems) {
      errors.add(`This demo accepts at most ${maxItems.toLocaleString('en-US')} items (found ${data.length.toLocaleString('en-US')}).`);
      return errors.result('json', items);
    }
    data.forEach((entry, index) => {
      const where = `Item ${index + 1}`;
      if (!isPlainObject(entry)) {
        errors.add(`${where}: must be an object with "id" and "attributes".`);
        return;
      }
      const unknown = Object.keys(entry).find((key) => !ITEM_FIELDS.has(key));
      if (unknown !== undefined) {
        errors.add(`${where}: unknown field "${unknown}". Attribute files hold only id and attributes; metadata never sets launch terms.`);
        return;
      }
      if (!('id' in entry)) {
        errors.add(`${where}: missing its id.`);
        return;
      }
      addItem(items, firstSeen, where, entry.id, entry.attributes ?? [], errors);
    });
  } else if (isPlainObject(data)) {
    const entries = Object.entries(data);
    if (entries.length > maxItems) {
      errors.add(`This demo accepts at most ${maxItems.toLocaleString('en-US')} items (found ${entries.length.toLocaleString('en-US')}).`);
      return errors.result('json', items);
    }
    for (const [key, attributes] of entries) {
      if (!normaliseItemId(key).ok) {
        errors.add(`"${key.slice(0, 40)}" is not an item id: the keys of an attributes object must be NFT ids (1, 2, 3 …).`);
        continue;
      }
      addItem(items, firstSeen, `Item ${key}`, key, attributes, errors);
    }
  } else {
    errors.add('The JSON must be a list of items or an object keyed by NFT id.');
  }
  if (errors.errors.length === 0 && items.size === 0) errors.add('The file has no items.');
  return errors.result('json', items);
}

/** RFC 4180 fields: commas, "quoted" fields with "" escapes, CRLF or LF rows. */
function csvRows(text: string): { rows: string[][]; error: string | null } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let atFieldStart = true;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && atFieldStart) {
      quoted = true;
      atFieldStart = false;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      atFieldStart = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      atFieldStart = true;
    } else {
      field += ch;
      atFieldStart = false;
    }
  }
  if (quoted) return { rows, error: 'The CSV has an unterminated quote.' };
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return { rows: rows.filter((r) => !(r.length === 1 && r[0] === '')), error: null };
}

function parseCsv(text: string, maxItems: number): AttributesResult {
  const errors = new Collector();
  const items = new Map<string, Attribute[]>();
  const firstSeen = new Map<string, string>();
  const { rows, error } = csvRows(text.startsWith('\uFEFF') ? text.slice(1) : text);
  if (error) {
    errors.add(error);
    return errors.result('csv', items);
  }
  const [header, ...body] = rows;
  if (!header || header[0]?.trim().toLowerCase() !== 'id') {
    errors.add('The first column must be "id" (one row per NFT, one column per trait).');
    return errors.result('csv', items);
  }
  const traits = header.slice(1);
  const seenColumns = new Set<string>();
  for (const name of traits) {
    const issue = textIssue(name, ATTRIBUTE_LIMITS.key);
    if (issue !== null) errors.add(`Header: trait column name ${issue}.`);
    else if (seenColumns.has(name)) errors.add(`Header: duplicate trait column "${name}".`);
    seenColumns.add(name);
  }
  if (traits.length > ATTRIBUTE_LIMITS.maxPerItem) errors.add(`Header: at most ${ATTRIBUTE_LIMITS.maxPerItem} trait columns (found ${traits.length}).`);
  if (errors.errors.length > 0) return errors.result('csv', items);
  if (body.length === 0) {
    errors.add('The file has no items.');
    return errors.result('csv', items);
  }
  if (body.length > maxItems) {
    errors.add(`This demo accepts at most ${maxItems.toLocaleString('en-US')} items (found ${body.length.toLocaleString('en-US')}).`);
    return errors.result('csv', items);
  }
  body.forEach((cells, index) => {
    const line = index + 2;
    if (cells.length !== header.length) {
      errors.add(`CSV line ${line} has ${cells.length} fields; the header has ${header.length}.`);
      return;
    }
    const pairs = traits.flatMap((name, column) => {
      const value = cells[column + 1] ?? '';
      return value === '' ? [] : [[name, value] as const];
    });
    addItem(items, firstSeen, `Line ${line}`, (cells[0] ?? '').trim(), Object.fromEntries(pairs), errors);
  });
  return errors.result('csv', items);
}

/**
 * Parses an attributes file. The format follows the extension, else the first non-blank character. `options` sets the
 * item and text limits (default: the demo's, `DEMO_MAX_ITEMS` and `ATTRIBUTE_LIMITS.maxFileChars`).
 */
export function parseAttributes(fileName: string, text: string, options: AttributesOptions = {}): AttributesResult {
  const maxItems = options.maxItems ?? DEMO_MAX_ITEMS;
  const maxFileChars = options.maxFileChars ?? ATTRIBUTE_LIMITS.maxFileChars;
  if (text.length > maxFileChars) {
    return { ok: false, errors: [`The attributes file is too large (more than ${maxFileChars / (1024 * 1024)} MB of text).`] };
  }
  if (text.trim() === '') return { ok: false, errors: ['The attributes file is empty.'] };
  const lower = fileName.toLowerCase();
  const first = text.trimStart().replace(/^\uFEFF/, '')[0];
  const json = lower.endsWith('.json') || (!lower.endsWith('.csv') && (first === '[' || first === '{'));
  return json ? parseJson(text, maxItems) : parseCsv(text, maxItems);
}
