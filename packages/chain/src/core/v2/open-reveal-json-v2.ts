/** Bounded JSON projection: keep the BoxSpec frame/list, validate and discard embedded assets while reading. */
import { checkReveal } from './reveal-check';

export type OpenRevealSourceV2 = Blob | AsyncIterable<Uint8Array>;
export interface OpenRevealReadLimitsV2 { readonly maxFileBytes?: number }
const KEPT_KEYS = new Set(['format', 'demo', 'encoded', 'specHash', 'spec', 'revealList']);
const MAX_RETAINED_CHARS = 16 * 1024 * 1024;
const MAX_TOKEN_CHARS = 1024 * 1024;
type Phase = 'firstKey' | 'key' | 'colon' | 'value' | 'firstValue' | 'comma';
type Frame = { kind: 'object' | 'array'; keep: boolean; value: Record<string, unknown> | unknown[];
  phase: Phase; key: string; count: number; keys: Set<string> };

/** A small incremental JSON tokenizer/parser. No full-file string and no retained picture/model strings. */
class BoxJsonProjection {
  private stack: Frame[] = [];
  private root: unknown;
  private complete = false;
  private mode: 'idle' | 'string' | 'primitive' = 'idle';
  private token = '';
  private capture = false;
  private escape = false;
  private unicode = 0;
  private retained = 0;

  private top() { return this.stack.at(-1); }
  private isKey() { const frame = this.top(); return frame?.kind === 'object' && (frame.phase === 'key' || frame.phase === 'firstKey'); }
  private keepValue() {
    const parent = this.top();
    return !parent || parent.keep && (this.stack.length !== 1 || KEPT_KEYS.has(parent.key));
  }
  private append(text: string) {
    if (!this.capture) return;
    this.retained += text.length;
    checkReveal(this.token.length + text.length <= MAX_TOKEN_CHARS && this.retained <= MAX_RETAINED_CHARS, 'reveal JSON retained data limit');
    this.token += text;
  }
  private put(value: unknown) {
    const parent = this.top();
    if (!parent) {
      checkReveal(!this.complete, 'trailing JSON value');
      this.root = value;
      this.complete = true;
      return;
    }
    checkReveal(parent.phase === 'value' || parent.kind === 'array' && parent.phase === 'firstValue', 'expected JSON value');
    parent.count++;
    checkReveal(!parent.keep || parent.count <= 10_000, 'reveal JSON entry limit');
    if (this.keepValue()) {
      if (Array.isArray(parent.value)) parent.value.push(value);
      else Object.defineProperty(parent.value, parent.key, { value, enumerable: true, configurable: true, writable: true });
    }
    parent.phase = 'comma';
  }
  private string() {
    const value: unknown = this.capture ? JSON.parse(this.token) : undefined;
    if (this.isKey()) {
      const parent = this.top();
      checkReveal(parent && typeof value === 'string', 'expected JSON key');
      if (parent.keep) {
        checkReveal(!parent.keys.has(value), 'duplicate JSON key');
        parent.keys.add(value);
      }
      parent.key = value;
      parent.phase = 'colon';
    } else this.put(value);
    this.token = '';
    this.mode = 'idle';
  }
  private primitive() {
    checkReveal(/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)$/.test(this.token), 'invalid JSON primitive');
    this.put(this.keepValue() ? JSON.parse(this.token) : undefined);
    this.token = '';
    this.mode = 'idle';
  }
  push(text: string) {
    // JSON forbids literal control characters inside strings, including discarded asset strings.
    const special = /["\\\u0000-\u001f]/g; // eslint-disable-line no-control-regex
    for (let i = 0; i < text.length;) {
      const c = text[i] as string;
      if (this.mode === 'string') {
        if (this.unicode) {
          checkReveal(/^[0-9a-fA-F]$/.test(c), 'invalid JSON unicode escape');
          this.append(c); this.unicode--; i++; continue;
        }
        if (this.escape) {
          checkReveal('"\\/bfnrtu'.includes(c), 'invalid JSON escape');
          this.append(c); this.escape = false;
          if (c === 'u') this.unicode = 4;
          i++; continue;
        }
        special.lastIndex = i;
        const match = special.exec(text);
        const end = match?.index ?? text.length;
        this.append(text.slice(i, end));
        i = end;
        if (!match) continue;
        const marker = text[i] as string;
        checkReveal(marker === '"' || marker === '\\', 'control character in JSON string');
        this.append(marker); i++;
        if (marker === '"') this.string();
        else this.escape = true;
        continue;
      }
      if (this.mode === 'primitive') {
        if (/[\x20\t\r\n,\]}]/.test(c)) { this.primitive(); continue; }
        checkReveal(this.token.length < 128, 'JSON primitive limit');
        this.token += c; i++; continue;
      }
      if (/[\x20\t\r\n]/.test(c)) { i++; continue; }
      const parent = this.top();
      if (c === ':' || c === ',') {
        checkReveal(parent && (c === ':' ? parent.kind === 'object' && parent.phase === 'colon' : parent.phase === 'comma'), 'unexpected JSON separator');
        parent.phase = c === ':' ? 'value' : parent.kind === 'object' ? 'key' : 'value';
      } else if (c === '}' || c === ']') {
        checkReveal(parent && parent.kind === (c === '}' ? 'object' : 'array')
          && (parent.phase === 'comma' || parent.phase === 'firstKey' || parent.phase === 'firstValue'), 'unexpected JSON close');
        this.stack.pop();
      } else if (c === '{' || c === '[') {
        checkReveal(parent || c === '{', 'box file must be a JSON object');
        checkReveal(this.stack.length < 64, 'reveal JSON depth limit');
        const keep = this.keepValue();
        const value = c === '{' ? {} : [];
        this.put(value);
        this.stack.push({ kind: c === '{' ? 'object' : 'array', keep, value, phase: c === '{' ? 'firstKey' : 'firstValue', key: '', count: 0, keys: new Set() });
      } else if (c === '"') {
        this.capture = this.isKey() || this.keepValue();
        this.mode = 'string'; this.token = ''; this.append(c);
      } else {
        checkReveal(parent && /[tfn\-0-9]/.test(c), 'invalid JSON token');
        this.mode = 'primitive'; this.token = c;
      }
      i++;
    }
  }
  finish(): unknown {
    if (this.mode === 'primitive') this.primitive();
    checkReveal(this.mode === 'idle' && this.stack.length === 0 && this.complete, 'incomplete reveal JSON');
    return this.root;
  }
}

async function* blobChunks(blob: Blob) {
  // slice() bounds each decode even on browsers whose Blob.stream() emits very large chunks.
  for (let offset = 0; offset < blob.size; offset += 65_536) yield new Uint8Array(await blob.slice(offset, offset + 65_536).arrayBuffer());
}

export async function readOpenRevealJsonV2(source: OpenRevealSourceV2, limits: OpenRevealReadLimitsV2 = {}): Promise<unknown> {
  const maxBytes = limits.maxFileBytes ?? 256 * 1024 * 1024;
  checkReveal(Number.isSafeInteger(maxBytes) && maxBytes > 0, 'invalid file byte limit');
  const isBlob = typeof Blob !== 'undefined' && source instanceof Blob;
  if (isBlob) checkReveal(source.size <= maxBytes, 'reveal file byte limit');
  const parts = isBlob ? blobChunks(source) : source as AsyncIterable<Uint8Array>;
  const parser = new BoxJsonProjection();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let size = 0;
  for await (const part of parts) {
    checkReveal(part instanceof Uint8Array, 'reveal source parts must be bytes');
    size += part.byteLength;
    checkReveal(size <= maxBytes, 'reveal file byte limit');
    for (let start = 0; start < part.byteLength; start += 65_536) parser.push(decoder.decode(part.subarray(start, start + 65_536), { stream: true }));
  }
  parser.push(decoder.decode());
  return parser.finish();
}
