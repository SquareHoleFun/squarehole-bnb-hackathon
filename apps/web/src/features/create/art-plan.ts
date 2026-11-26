/**
 * SH-AI-PLAN: a collection's plan (docs/guides/hidden-collection-plan.md). One CSV, one row per picture, keyed by the
 * picture's file name:
 *
 *   file,count,Glaze,Crack
 *   bisque.png,44,Bisque,
 *   gold-seam.png,8,Celadon,Gold seam
 *
 * The page reads the pictures and the plan, deals the numbers 1..N with this browser's own cryptographic randomness
 * (`dealItems`) and makes the salts (art-files.ts); the map is kept only in this tab's draft and in the reveal file.
 * The plan never decides a number: a column that would set one, or a secret, is refused, and the deck is put in the
 * order of the pictures' sha256 before it is shuffled, so neither the rows' order nor the file names change who gets
 * what. An AI (or anyone) who wrote the plan and made the pictures still cannot tell which number is which.
 *
 * The shuffle is the Misfits edition's (scripts/nft/edition/lib/assign.mjs `shuffleIds`): a descending Fisher-Yates
 * pass over uniform unsigned 32-bit words, each index drawn by rejection (`uniformIndex`), so no order is likelier than
 * another, never a float. Unlike the edition's ceremony there is no seed to keep: the words come straight from
 * `crypto.getRandomValues`, and the reveal file is the record. Problems name the row (the header is row 1, as in a
 * spreadsheet) and the column; the words are drafts for the founder's edit (docs/evidence/SH-AI-PLAN.md).
 */
import type { Attribute } from '@squarehole/artwork';
import { MAX_N, MIN_N } from '@squarehole/box-spec';
import type { ArtItem, Hex } from './create-model';

/** A plan larger than this is not read (10,000 rows of 16 traits fit easily). */
export const MAX_PLAN_BYTES = 8 * 1024 * 1024;
/** What a box's trait table holds (art-files.ts `tableProblems`, packages/artwork ATTRIBUTE_LIMITS). */
export const PLAN_LIMITS = Object.freeze({ traits: 16, values: 255, nameChars: 64, valueChars: 128, fileChars: 128 });
/** A picture's file name in a plan: letters, digits, - and _, then .png, .jpg (.jpeg) or .webp. */
const FILE_NAME = /^[A-Za-z0-9_-]+\.(?:png|jpe?g|webp)$/i;
const COUNT = /^[1-9][0-9]{0,4}$/;
/** The box's table characters: printable ASCII but " and \ (art-files.ts TABLE_TEXT). */
const TABLE_CHARS = /^[\x20-\x21\x23-\x5b\x5d-\x7e]+$/;
const WORD_RANGE = 2 ** 32;
const count = (n: number): string => n.toLocaleString('en-US');

/**
 * The plan's lines, for the founder's edit (minimal words: what is wrong and where, never how the page works inside).
 * `Row 4, Glaze` points at a cell; the header is row 1.
 */
export const PLAN_WORDS = Object.freeze({
  header: 'Row 1: start with file,count.',
  numbers: 'Leave the numbers out. The page picks them.',
  secret: 'This file tries to set a secret. The page makes its own.',
  character: (at: string, text: string) => `${at}: "${text.slice(0, 24)}" has a character the box cannot store.`,
  tooLong: (at: string, max: number) => `${at}: up to ${max} characters.`,
  noName: (at: string) => `${at}: name this trait.`,
  repeatedTrait: (at: string, name: string, column: number) => `${at}: ${name} is already column ${column}.`,
  tooManyTraits: (n: number) => `${n} traits. A box holds ${PLAN_LIMITS.traits}.`,
  tooManyValues: (name: string, n: number) => `${name} has ${count(n)} values. A box holds ${PLAN_LIMITS.values}.`,
  cells: (row: number, found: number, header: number) => `Row ${row} has ${found} cells. Row 1 has ${header}.`,
  fileName: (row: number) => `Row ${row}, file: use letters, digits, - and _, then .png, .jpg or .webp.`,
  repeatedFile: (row: number, file: string, first: number) => `Row ${row}: ${file} is already in row ${first}.`,
  count: (row: number) => `Row ${row}, count: a whole number from 1 to ${count(MAX_N)}.`,
  total: (n: number) => `${count(n)} ${n === 1 ? 'item' : 'items'}. A collection needs ${MIN_N} to ${count(MAX_N)}.`,
  noRows: 'The plan has no rows.',
  openQuote: (row: number) => `Row ${row}: a quote is not closed.`,
  noPicture: (row: number, file: string) => `Row ${row}: no picture named ${file}.`,
  notInPlan: (file: string) => `${file} is not in the plan.`,
  sameName: (n: number, file: string) => `${n} pictures named ${file}.`,
  planAndTraits: 'Use the plan or a traits file, not both.',
  twoPlans: (n: number) => `${n} plans. Add one.`,
  tooLarge: (file: string) => `${file} is larger than 8 MB.`,
  noRandom: 'This browser cannot pick random numbers.',
});

/** One row of a plan: the row it is on (the header is row 1), the picture's file name, its count and its traits. */
export interface PlanRow {
  readonly row: number;
  readonly file: string;
  readonly count: number;
  readonly traits: readonly Attribute[];
}

/** A problem: one cell or row (`row`, grouped when there are many), or the plan as a whole (`plan`, one line each). */
export interface PlanIssue {
  readonly kind: 'row' | 'plan';
  readonly text: string;
}

export interface Plan {
  /** The rows without a problem, in the plan's order. */
  readonly rows: readonly PlanRow[];
  /** Every file name the plan gives in a well-formed way, lower-cased (to tell "not in the plan" from a bad row). */
  readonly named: ReadonlySet<string>;
  /** Whether the rows were read at all (a bad header or an open quote stops before them). */
  readonly readRows: boolean;
  /** The sum of the counts (meaningful only without issues). */
  readonly total: number;
  readonly issues: readonly PlanIssue[];
}

interface CsvRecord {
  /** The line the record starts on (1 = the first line). */
  readonly line: number;
  readonly cells: readonly string[];
}

/**
 * RFC 4180 records with the line each starts on: commas, "quoted" fields with "" escapes, CRLF, LF or CR line ends.
 * Each cell is trimmed (an AI often writes "a, b"); spaces before a quoted field are dropped. Blank lines are skipped.
 * `max` stops after that many records, each ended by its line end (`cut`): how a plan is told from a traits file
 * (`planHeaderVerdict`) with the parser's own rules, from the start of a file.
 */
export function csvRecords(text: string, max = Number.POSITIVE_INFINITY): { readonly records: readonly CsvRecord[]; readonly openQuote: number | null; readonly cut: boolean } {
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let field = '';
  let quoted = false;
  let atStart = true;
  let line = 1;
  let start = 1;
  const endField = () => {
    cells.push(field.trim());
    field = '';
    atStart = true;
  };
  const endRecord = () => {
    endField();
    if (!(cells.length === 1 && cells[0] === '')) records.push({ line: start, cells });
    cells = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        if (ch === '\n' || (ch === '\r' && text[i + 1] !== '\n')) line += 1;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && atStart) {
      quoted = true;
      atStart = false;
    } else if (ch === ',') {
      endField();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      endRecord();
      line += 1;
      start = line;
      if (records.length >= max) return { records, openQuote: null, cut: true };
    } else if (atStart && (ch === ' ' || ch === '\t')) {
      // Blanks before a field (or before its opening quote) are not part of it.
    } else {
      field += ch;
      atStart = false;
    }
  }
  if (quoted) return { records, openQuote: start, cut: false };
  if (field !== '' || cells.length > 0) endRecord();
  return { records, openQuote: null, cut: false };
}

/**
 * Whether a CSV is a plan, from the start of its text (`head`; `whole` when it is all of it): its first non-blank
 * record, read as `parsePlan` reads it (a BOM, blank lines and blanks around a cell skipped), starts with `file`; a
 * traits file starts with `id`. Null when `head` may end inside that record: read more of the file.
 */
export function planHeaderVerdict(head: string, whole: boolean): boolean | null {
  const { records, cut } = csvRecords(head.replace(/^\uFEFF/, ''), 1);
  if (!cut && !whole) return null;
  return records[0]?.cells[0]?.toLowerCase() === 'file';
}

/** Whether a CSV's whole text is a plan (`planHeaderVerdict`). */
export const isPlanHeader = (text: string): boolean => planHeaderVerdict(text, true) === true;

const squash = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');
/** A column that would set the numbers: the page picks them. */
const NUMBER_COLUMNS: ReadonlySet<string> = new Set(['id', 'ids', 'tokenid', 'itemid', 'nftid', 'number', 'tokennumber', 'itemnumber']);
/** A column that would set a secret: the page makes the salts, and there is no seed. */
const SECRET_COLUMNS: ReadonlySet<string> = new Set(['salt', 'salts', 'seed', 'seeds', 'secret', 'nonce']);
const isNumberColumn = (name: string): boolean => name === '#' || NUMBER_COLUMNS.has(squash(name));
const isSecretColumn = (name: string): boolean => SECRET_COLUMNS.has(squash(name));

/** Why a trait name or value cannot go in the box's table, or null. */
function cellProblem(at: string, text: string, max: number): string | null {
  if (!TABLE_CHARS.test(text)) return PLAN_WORDS.character(at, text);
  if (text.length > max) return PLAN_WORDS.tooLong(at, max);
  return null;
}

/**
 * Reads a plan's text: the header (`file,count`, then one column per trait), then one row per picture. Never throws;
 * every problem names its row and column. Rows with a problem are left out of `rows`.
 */
export function parsePlan(text: string): Plan {
  const issues: PlanIssue[] = [];
  const named = new Set<string>();
  const plan = (message: string) => issues.push({ kind: 'plan', text: message });
  const row = (message: string) => issues.push({ kind: 'row', text: message });
  const none = (): Plan => ({ rows: [], named, readRows: false, total: 0, issues });
  const { records, openQuote } = csvRecords(text.replace(/^\uFEFF/, ''));
  if (openQuote !== null) {
    plan(PLAN_WORDS.openQuote(openQuote));
    return none();
  }
  const [header, ...body] = records;
  if (!header || header.cells[0]?.toLowerCase() !== 'file' || header.cells[1]?.toLowerCase() !== 'count') {
    plan(PLAN_WORDS.header);
    return none();
  }
  const names = header.cells.slice(2);
  if (names.some(isNumberColumn)) plan(PLAN_WORDS.numbers);
  if (names.some(isSecretColumn)) plan(PLAN_WORDS.secret);
  if (names.length > PLAN_LIMITS.traits) plan(PLAN_WORDS.tooManyTraits(names.length));
  const columns = new Map<string, number>();
  names.forEach((name, i) => {
    if (isNumberColumn(name) || isSecretColumn(name)) return;
    const at = `Row ${header.line}, column ${i + 3}`;
    const problem = name === '' ? PLAN_WORDS.noName(at) : cellProblem(at, name, PLAN_LIMITS.nameChars);
    const first = columns.get(name);
    if (problem) row(problem);
    else if (first !== undefined) row(PLAN_WORDS.repeatedTrait(at, name, first));
    else columns.set(name, i + 3);
  });
  // A header with a problem: its rows cannot be read against it.
  if (issues.length > 0) return none();
  if (body.length === 0) {
    plan(PLAN_WORDS.noRows);
    return none();
  }
  const rows: PlanRow[] = [];
  const files = new Map<string, number>();
  const values = names.map(() => new Set<string>());
  let total = 0;
  for (const record of body) {
    const at = record.line;
    if (record.cells.length !== header.cells.length) {
      row(PLAN_WORDS.cells(at, record.cells.length, header.cells.length));
      continue;
    }
    const [file = '', countText = '', ...cells] = record.cells;
    let ok = true;
    if (file.length > PLAN_LIMITS.fileChars || !FILE_NAME.test(file)) {
      row(PLAN_WORDS.fileName(at));
      ok = false;
    } else {
      const key = file.toLowerCase();
      const first = files.get(key);
      named.add(key);
      if (first !== undefined) {
        row(PLAN_WORDS.repeatedFile(at, file, first));
        ok = false;
      } else {
        files.set(key, at);
      }
    }
    // A count is a small whole number (at most 10,000), never an amount: Number is exact here.
    const n = COUNT.test(countText) ? Number.parseInt(countText, 10) : 0;
    if (n < 1 || n > MAX_N) {
      row(PLAN_WORDS.count(at));
      ok = false;
    }
    const traits: Attribute[] = [];
    cells.forEach((value, i) => {
      const name = names[i] as string;
      if (value === '') return;
      const problem = cellProblem(`Row ${at}, ${name}`, value, PLAN_LIMITS.valueChars);
      if (problem) {
        row(problem);
        ok = false;
        return;
      }
      traits.push({ trait: name, value });
      values[i]?.add(value);
    });
    if (ok) {
      rows.push({ row: at, file, count: n, traits });
      total += n;
    }
  }
  values.forEach((set, i) => {
    if (set.size > PLAN_LIMITS.values) plan(PLAN_WORDS.tooManyValues(names[i] as string, set.size));
  });
  if (issues.length === 0 && (total < MIN_N || total > MAX_N)) plan(PLAN_WORDS.total(total));
  return { rows, named, readRows: true, total, issues };
}

/** One picture of a plan, read: its row, the sha256 of its file as uploaded and its size. */
export interface PlannedPicture {
  readonly row: PlanRow;
  readonly sha256: Hex;
  readonly bytes: number;
}

/**
 * A uniform index in [0, bound) from uniform unsigned 32-bit words: a word at or above the largest multiple of `bound`
 * below 2^32 is drawn again (no modulo bias). Indices are array positions (at most 10,000), never amounts.
 */
export function uniformIndex(bound: number, nextWord: () => number): number {
  if (!Number.isSafeInteger(bound) || bound < 1 || bound > WORD_RANGE) throw new RangeError('uniformIndex: bound out of range');
  const limit = WORD_RANGE - (WORD_RANGE % bound);
  for (;;) {
    const word = nextWord();
    if (!Number.isSafeInteger(word) || word < 0 || word >= WORD_RANGE) throw new RangeError('uniformIndex: not a 32-bit word');
    if (word < limit) return word % bound;
  }
}

/** Uniform 32-bit words from `fill` (this browser's `crypto.getRandomValues`), a block at a time. */
export function wordStream(fill: (words: Uint32Array<ArrayBuffer>) => void, block = 1024): () => number {
  const words = new Uint32Array(block);
  let at = block;
  return () => {
    if (at === block) {
      fill(words);
      at = 0;
    }
    const word = words[at] as number;
    at += 1;
    return word;
  };
}

/** The deck's order before the shuffle: by picture sha256, then file name, then row (never the plan's own order). */
function byPicture(a: PlannedPicture, b: PlannedPicture): number {
  const left = [a.sha256.toLowerCase(), a.row.file.toLowerCase()];
  const right = [b.sha256.toLowerCase(), b.row.file.toLowerCase()];
  for (let i = 0; i < left.length; i += 1) {
    if ((left[i] as string) < (right[i] as string)) return -1;
    if ((left[i] as string) > (right[i] as string)) return 1;
  }
  return a.row.row - b.row.row;
}

/**
 * Deals the numbers: each picture `count` times, ids 1..N in a uniformly random order drawn from `nextWord` (descending
 * Fisher-Yates, as the Misfits edition's `shuffleIds`; position i becomes id i + 1). Throws when the words run out or
 * are not words (art-files.ts reports it; no other randomness is ever used).
 */
export function dealItems(pictures: readonly PlannedPicture[], nextWord: () => number): ArtItem[] {
  const ordered = [...pictures].sort(byPicture);
  const deck: number[] = [];
  ordered.forEach((picture, index) => {
    for (let k = 0; k < picture.row.count; k += 1) deck.push(index);
  });
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = uniformIndex(i + 1, nextWord);
    const swap = deck[i] as number;
    deck[i] = deck[j] as number;
    deck[j] = swap;
  }
  return deck.map((index, i) => {
    const picture = ordered[index] as PlannedPicture;
    return { id: i + 1, imageSha256: picture.sha256, traits: picture.row.traits, bytes: picture.bytes };
  });
}
