import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * SH-280 STEP 3b: the web image's launch stage holds only `bounties/` and the platform's privy-config.ts
 * (hackathon/stack/app.Dockerfile), and its build type-checks every file the tsconfig includes. So no import of this app
 * may lead outside `bounties/`, except the entries' ABI files (JSON under bounties/flap and bounties/openfour); files of
 * the platform are read as text where a test compares with them. (The ship of main eb105cf9 stopped on such an import.)
 */
const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BOUNTIES = resolve(APP, '..');
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  if (name === 'node_modules' || name === 'dist' || name === 'test-results' || name.startsWith('.')) return [];
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : /\.(ts|tsx|mjs|js)$/.test(name) ? [path] : [];
});

describe('the launch stage builds with what it copies', () => {
  it('no import leaves bounties/', () => {
    const outside: string[] = [];
    for (const file of [...['src', 'test', 'e2e', 'scripts', 'build'].flatMap((d) => walk(join(APP, d))), join(APP, 'vite.config.ts'), join(APP, 'vitest.config.ts'), join(APP, 'playwright.config.ts')]) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) {
        const target = resolve(dirname(file), match[1]!);
        if (!target.startsWith(`${BOUNTIES}/`)) outside.push(`${relative(APP, file)}: ${match[1]}`);
      }
    }
    expect(outside).toEqual([]);
  });
});
