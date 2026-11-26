/**
 * ART-05 (no provider API key in the browser bundle) and 06-ARCHITECTURE "no client-side secret": the app and the
 * packages it bundles read no build-time environment secret and carry no credential-shaped name in code or strings.
 * Comments are skipped (they may name these rules). A future AI adapter talks to a server-side broker by URL only.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SELF = fileURLToPath(import.meta.url);
const SCANNED_DIRS = ['apps/web/src', 'packages/artwork/src', 'packages/chain/src', 'packages/design/src', 'packages/domain/src', 'packages/links/src', 'packages/providers/src'];

const PRIVATE_KEY = /\bprivate[_-]?key\b/i;
const FORBIDDEN: readonly RegExp[] = [
  /import\s*\.\s*meta\s*\.\s*env\s*\.\s*\w*(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i,
  /\bapi[_-]?key\b/i,
  /\bapiKey\b/,
  /x-api-key/i,
  /\bsecret[_-]?key\b/i,
  PRIVATE_KEY,
  /authorization['"]?\s*:\s*['"`]?bearer/i,
  /\bsk-[A-Za-z0-9]{16,}/,
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}

/** Code and string tokens without comments. */
function code(fileName: string, text: string): string {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const tokens: string[] = [];
  const visit = (node: ts.Node): void => {
    const children = node.getChildren(source);
    if (children.length === 0) tokens.push(node.getText(source));
    else children.forEach(visit);
  };
  visit(source);
  return tokens.join(' ');
}

describe('no client-side secret (ART-05)', () => {
  it('the scan catches credential-shaped names in code and strings, not in comments', () => {
    const hits = (text: string) => FORBIDDEN.filter((pattern) => pattern.test(code('x.ts', text))).length;
    expect(hits("const k = import.meta.env.VITE_OPENAI_KEY;")).toBeGreaterThan(0);
    expect(hits("fetch(url, { headers: { 'x-api-key': k } });")).toBeGreaterThan(0);
    expect(hits('const apiKey = "abc";')).toBeGreaterThan(0);
    expect(hits('// never put an apiKey here\nexport {};')).toBe(0);
  });

  it('finds none in the app and the bundled packages', () => {
    const files = SCANNED_DIRS.flatMap((dir) => sourceFiles(join(ROOT, dir))).filter((file) => file !== SELF);
    expect(files.length).toBeGreaterThan(60);
    const findings = files.flatMap((file) => {
      const tokens = code(file, readFileSync(file, 'utf8'));
      // The chain write side's anvil harness (test-only, never bundled) derives anvil's PUBLIC default test keys.
      const harness = relative(ROOT, file).startsWith('packages/chain/src/write/integration/');
      return FORBIDDEN.filter((pattern) => !(harness && pattern === PRIVATE_KEY) && pattern.test(tokens)).map(
        (pattern) => `${relative(ROOT, file)}: ${pattern.source}`,
      );
    });
    expect(findings).toEqual([]);
  });
});
