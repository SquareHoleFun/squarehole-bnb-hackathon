/**
 * SH-218 rail 2 (design section 6, `existing-box-is-independent-of-every-switch`, the source half; the browser half is
 * e2e/create-options.spec.ts): existing boxes never consult the Create switches. No module the box pages or their
 * actions load (statically or lazily) reaches the switches' files, and the ordinary send (`submitWrite`) has no
 * switches check: only the creation entry point asks one.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SRC = join(WEB, 'src');
const ROOT = resolve(WEB, '../..');
const SWITCHES = ['create-options.ts', 'useCreateOptions.ts', 'CreateOptionsLines.tsx', 'create-options-words.ts'].map((name) => join(SRC, 'features/create/v2', name));
const ENTRIES = ['pages/BoxPage.tsx', 'pages/WalletBoxPage.tsx', 'features/core/v2/actions-v2.ts'].map((path) => join(SRC, path));
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g;

function resolveImport(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (/\.[cm]?[jt]sx?$/.test(candidate) && existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every app module reachable from `entries` through relative imports (static, re-exports and lazy `import()`). */
function reachable(entries: readonly string[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file) || !file.startsWith(SRC)) continue;
    seen.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
      const next = resolveImport(file, match[1] ?? '');
      if (next) queue.push(next);
    }
  }
  return seen;
}

describe('existing-box-is-independent-of-every-switch', () => {
  it('the box pages and their actions reach none of the Create switches’ files', () => {
    for (const entry of ENTRIES) expect(existsSync(entry), entry).toBe(true);
    const seen = reachable(ENTRIES);
    // The walk follows the pages into their parts (a sanity floor, so an empty walk cannot pass).
    expect(seen.size).toBeGreaterThan(50);
    expect([...seen].filter((file) => SWITCHES.includes(file)).map((file) => file.slice(SRC.length + 1))).toEqual([]);
  });

  it('the walk does find the switches from Create (the same walk, the other entry)', () => {
    const seen = reachable([join(SRC, 'features/create/CreatePage.tsx')]);
    expect(SWITCHES.every((file) => seen.has(file))).toBe(true);
  });

  it('the ordinary send has no switches check; only the creation entry point asks one', () => {
    const executor = readFileSync(join(ROOT, 'packages/chain/src/write/executor.ts'), 'utf8');
    const body = (name: string) => {
      const start = executor.indexOf(`export async function ${name}(`);
      const end = executor.indexOf('\n}\n', start);
      expect(start, name).toBeGreaterThan(0);
      return executor.slice(start, end);
    };
    expect(body('submitWrite')).not.toMatch(/createOptionsCheck|beforeRequest/);
    expect(body('submitSetCreateWrite')).not.toMatch(/createOptionsCheck/);
    expect(body('submitCreateWriteV2')).toMatch(/createOptionsCheck/);
    const actions = readFileSync(join(SRC, 'features/core/v2/actions-v2.ts'), 'utf8');
    expect(actions).not.toMatch(/submitCreateWriteV2|createOptionsCheck|create-options/);
  });
});
