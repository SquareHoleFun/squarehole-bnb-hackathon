/**
 * TEST ONLY (M1-52): reads M1-00's frozen Solidity files as text and gives each event's canonical signature, each
 * struct's canonical tuple, each enum's members, and the event signatures the shape tests pin
 * (`packages/contracts/test/box-v2/shape`, `_assertEvent("…")` and `_topic("…")`). The v2 ABIs of `../abi-v2.ts` are
 * checked against this, so a frozen shape the TypeScript side copied wrongly fails a test instead of a decode.
 *
 * Canonical types follow the ABI: an enum is uint8, a struct its tuple, a user-defined value type its underlying
 * type, an interface or contract an address, `uint`/`int` uint256/int256.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONTRACTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../../contracts');

export interface SolParam {
  readonly type: string;
  readonly indexed: boolean;
  readonly name: string;
}

export interface SolEvent {
  readonly container: string;
  readonly name: string;
  readonly params: readonly SolParam[];
  readonly signature: string;
}

export interface SolShapes {
  readonly enums: ReadonlyMap<string, readonly string[]>;
  readonly structs: ReadonlyMap<string, readonly SolParam[]>;
  readonly events: readonly SolEvent[];
  canonical(type: string): string;
  event(container: string, name: string): SolEvent | undefined;
}

const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** Top-level `,`-separated parts (no split inside parentheses or brackets). */
function splitTop(list: string, separator: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of list) {
    if (ch === '(' || ch === '[') depth += 1;
    if (ch === ')' || ch === ']') depth -= 1;
    if (ch === separator && depth === 0) {
      out.push(current);
      current = '';
    } else current += ch;
  }
  if (current.trim()) out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

function param(text: string): SolParam {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter((w) => !['memory', 'calldata', 'storage', 'payable'].includes(w));
  const indexed = words.includes('indexed');
  const rest = words.filter((w) => w !== 'indexed');
  return { type: rest[0] ?? '', indexed, name: rest[1] ?? '' };
}

/** Each `interface|library|contract Name … { body }` with its body (braces matched). */
function containers(code: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  for (const m of code.matchAll(/\b(?:interface|library|contract)\s+(\w+)[^{;]*\{/g)) {
    let depth = 1;
    let i = (m.index ?? 0) + m[0].length;
    const start = i;
    while (i < code.length && depth > 0) {
      if (code[i] === '{') depth += 1;
      if (code[i] === '}') depth -= 1;
      i += 1;
    }
    out.push({ name: m[1] ?? '', body: code.slice(start, i - 1) });
  }
  return out;
}

/** Reads the given files (paths relative to packages/contracts). */
export function loadSolidityShapes(files: readonly string[]): SolShapes {
  const enums = new Map<string, string[]>();
  const structs = new Map<string, SolParam[]>();
  const valueTypes = new Map<string, string>();
  const named = new Set<string>();
  const events: { container: string; name: string; params: SolParam[] }[] = [];
  for (const file of files) {
    const code = stripComments(readFileSync(join(CONTRACTS_DIR, file), 'utf8'));
    for (const m of code.matchAll(/\benum\s+(\w+)\s*\{([^}]*)\}/g)) enums.set(m[1] ?? '', splitTop(m[2] ?? '', ','));
    for (const m of code.matchAll(/\bstruct\s+(\w+)\s*\{([^}]*)\}/g)) structs.set(m[1] ?? '', splitTop(m[2] ?? '', ';').map(param));
    for (const m of code.matchAll(/\btype\s+(\w+)\s+is\s+(\w+)\s*;/g)) valueTypes.set(m[1] ?? '', m[2] ?? '');
    for (const c of containers(code)) {
      named.add(c.name);
      for (const m of c.body.matchAll(/\bevent\s+(\w+)\s*\(([^;]*)\)\s*;/g)) events.push({ container: c.name, name: m[1] ?? '', params: splitTop(m[2] ?? '', ',').map(param) });
    }
  }
  const canonical = (type: string): string => {
    const m = /^([A-Za-z_][\w.]*)((?:\[\d*\])*)$/.exec(type.trim());
    if (!m) throw new Error(`unreadable Solidity type ${type}`);
    const base = (m[1] ?? '').split('.').pop() ?? '';
    const suffix = m[2] ?? '';
    if (base === 'uint' || base === 'int') return `${base}256${suffix}`;
    if (/^(u?int\d+|bytes\d+|address|bool|string|bytes)$/.test(base)) return `${base}${suffix}`;
    if (enums.has(base)) return `uint8${suffix}`;
    const underlying = valueTypes.get(base);
    if (underlying) return `${canonical(underlying)}${suffix}`;
    const members = structs.get(base);
    if (members) return `(${members.map((p) => canonical(p.type)).join(',')})${suffix}`;
    if (named.has(base) || /^I[A-Z]/.test(base)) return `address${suffix}`;
    throw new Error(`unknown Solidity type ${type}`);
  };
  const resolved: SolEvent[] = events.map((e) => {
    const params = e.params.map((p) => ({ ...p, type: canonical(p.type) }));
    return { ...e, params, signature: `${e.name}(${params.map((p) => p.type).join(',')})` };
  });
  return {
    enums,
    structs,
    events: resolved,
    canonical,
    event: (container, name) => resolved.find((e) => e.container === container && e.name === name),
  };
}

/** Every `.sol` file of a folder under packages/contracts (relative paths). */
export function solidityFilesIn(folder: string): string[] {
  return readdirSync(join(CONTRACTS_DIR, folder))
    .filter((f) => f.endsWith('.sol'))
    .sort()
    .map((f) => `${folder}/${f}`);
}

/** The frozen v2 interfaces and the outside types their events and structs name. */
export function frozenV2Shapes(): SolShapes {
  return loadSolidityShapes([
    ...solidityFilesIn('src/box-v2/interfaces'),
    'lib/v4-core/src/types/PoolKey.sol',
    'lib/v4-core/src/types/Currency.sol',
    'src/box/interfaces/BoxTypes.sol',
    'lib/v4-core/src/types/PoolId.sol',
  ]);
}

/** The event signatures M1-00's shape tests pin (`_assertEvent("Sig(…)"` and `_topic("Sig(…)")`). */
export function pinnedEventSignatures(): string[] {
  const out = new Set<string>();
  for (const file of solidityFilesIn('test/box-v2/shape')) {
    const source = readFileSync(join(CONTRACTS_DIR, file), 'utf8');
    for (const m of source.matchAll(/_(?:assertEvent|topic)\(\s*"([A-Za-z0-9_]+\([^"]*\))"/g)) out.add(m[1] ?? '');
  }
  return [...out].sort();
}
