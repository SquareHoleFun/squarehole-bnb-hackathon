import { keccak256, stringToHex, type Hex } from 'viem';
import { requireThat } from './schema';

export type Wire = null | boolean | string | Wire[] | { [key: string]: Wire };
const ZERO_HASH = `0x${'0'.repeat(64)}` as Hex;
const forbidden = /signature|private.?key|secret|password|credential|rpc.?url|mnemonic/i;
const monetary = /(?:Raw|amount|amountIn|amountOut|value|balance|supply|fee|gas|nonce|chainId|sequence|blockNumber|timestamp|deadline|minimumOut|quotedOut)$/i;

/** Internal canonicalization converts bigint and discrete ABI numbers to decimal strings; public append is stricter. */
export function toWire(input: unknown, internal = true, field = ''): Wire {
  if (input === null || typeof input === 'boolean') return input;
  if (typeof input === 'bigint') { requireThat(internal && input >= 0n, 'unsigned decimal wire value required'); return input.toString(); }
  if (typeof input === 'number') {
    requireThat(internal && globalThis.Number.isSafeInteger(input) && input >= 0, 'JSON numbers forbidden in public journal');
    return input.toString();
  }
  if (typeof input === 'string') {
    if (monetary.test(field)) requireThat(/^(0|[1-9][0-9]*)$/.test(input), 'canonical decimal string required');
    requireThat(!/https?:\/\/|bearer\s/i.test(input), 'credentials/URLs do not belong in public records');
    return input;
  }
  if (Array.isArray(input)) return input.map(x => toWire(x, internal));
  requireThat(typeof input === 'object' && Object.getPrototypeOf(input) === Object.prototype, 'plain JSON record required');
  const out: Record<string, Wire> = {};
  for (const key of Object.keys(input).sort()) {
    requireThat(!forbidden.test(key), 'secret or executable signature forbidden in journal');
    out[key] = toWire((input as Record<string, unknown>)[key], internal, key);
  }
  return out;
}
export const canonicalJson = (input: unknown) => JSON.stringify(toWire(input));
export const contentHash = (input: unknown) => keccak256(stringToHex(canonicalJson(input)));

/** Durable adapters MUST compare and append atomically, fsync before success, and provide exclusive-writer semantics. */
export interface AppendStore { read(): string; append(expected: string, line: string): void }
/** Deterministic fake; never presented as durable production storage. */
export class MemoryAppendStore implements AppendStore {
  constructor(private text = '') {}
  read() { return this.text; }
  append(expected: string, line: string) { requireThat(this.text === expected, 'stale journal writer'); this.text += line; }
}
export interface JournalEntry { sequence: string; previousHash: Hex; entryHash: Hex; record: Wire }
export class Journal {
  private text: string;
  private records: JournalEntry[] = [];
  constructor(private store: AppendStore, checkpoint?: Hex) {
    this.text = store.read();
    requireThat(this.text === '' || this.text.endsWith('\n'), 'incomplete journal append; reconcile before restart');
    for (const line of this.text.split('\n').filter(Boolean)) {
      const raw: unknown = JSON.parse(line);
      requireThat(raw !== null && typeof raw === 'object' && !Array.isArray(raw), 'invalid journal entry');
      const entry = raw as JournalEntry;
      requireThat(Object.keys(entry).sort().join(',') === 'entryHash,previousHash,record,sequence', 'invalid entry fields');
      toWire(entry.record, false);
      requireThat(entry.sequence === (BigInt(this.records.length) + 1n).toString() && entry.previousHash === this.head, 'broken journal chain');
      requireThat(entry.entryHash === contentHash({ sequence: entry.sequence, previousHash: entry.previousHash, record: entry.record }), 'journal content changed');
      requireThat(canonicalJson(entry) === line, 'noncanonical journal line'); this.records.push(entry);
    }
    if (checkpoint) requireThat(this.head === checkpoint, 'journal/checkpoint mismatch (including truncation)');
  }
  get head(): Hex { return this.records.at(-1)?.entryHash ?? ZERO_HASH; }
  get entries(): JournalEntry[] { return structuredClone(this.records); }
  append(input: unknown): JournalEntry {
    const record = toWire(input, false);
    const body = { sequence: (BigInt(this.records.length) + 1n).toString(), previousHash: this.head, record };
    const entry = { ...body, entryHash: contentHash(body) };
    const line = `${canonicalJson(entry)}\n`;
    this.store.append(this.text, line); this.text += line; this.records.push(entry);
    return structuredClone(entry);
  }
}
