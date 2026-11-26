/**
 * Source guards for the whole package (EXT-01, UI-09, G08, 06-ARCHITECTURE). The read side (everything outside
 * src/write) has no wallet client, no signing or sending and no account requests. The write side (src/write, SH-C
 * integration) may make exactly three wallet requests, each in one file: `eth_sendTransaction` in write/executor.ts,
 * and `eth_requestAccounts` and `eth_signTypedData_v4` (LINKS-WEB: a box creator's signed links, box-links-v2.md § 5)
 * in write/injected-wallet.ts (its own audit, write/audit.test.ts, pins the four sendable calls).
 * Nowhere: swap building, a viem wallet client, local signing, key material, build-time secrets or a mainnet chain;
 * no node:* imports outside node.ts, tests, test support and the anvil integration harness. Comments are skipped;
 * code and string tokens are scanned.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}

function tokenList(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const tokens: string[] = [];
  const visit = (node: ts.Node): void => {
    // JSDoc blocks are attached to the AST as children; they are comments, not code.
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(source);
    if (children.length === 0) {
      if (node.kind !== ts.SyntaxKind.EndOfFileToken) tokens.push(node.getText(source));
      return;
    }
    children.forEach(visit);
  };
  visit(source);
  return tokens;
}

const codeTokens = (path: string): string => tokenList(path).join(' ');

const isTestSupport = (path: string): boolean => /(^|\/)(test-support|integration)\//.test(relative(SRC, path));
const production = files(SRC).filter((path) => !path.endsWith('.test.ts') && !isTestSupport(path));
const readSide = production.filter((path) => !relative(SRC, path).startsWith('write/'));
const writeSide = production.filter((path) => relative(SRC, path).startsWith('write/'));

/** The only wallet requests the package makes, each allowed in exactly one write-side file. */
const WRITE_ALLOWANCE: ReadonlyMap<string, readonly RegExp[]> = new Map([
  ['write/executor.ts', [/eth_sendTransaction/]],
  // LINKS-WEB: the account request, and the one signature (EIP-712 v4) a box creator gives for the box's links.
  ['write/injected-wallet.ts', [/eth_requestAccounts/, /\bsignTypedData\b/, /eth_signTypedData_v4/]],
]);

const FORBIDDEN: readonly RegExp[] = [
  /createWalletClient/,
  /\bwriteContract\b/,
  /\bsendTransaction\b/,
  /\bsendRawTransaction\b/,
  /eth_sendTransaction/,
  /eth_sendRawTransaction/,
  /eth_signTransaction/,
  /eth_requestAccounts/,
  /wallet_requestPermissions/,
  /\bsignTypedData\b/,
  /eth_signTypedData_v4/,
  /eth_signTypedData(?!_v4\b)/,
  /\bsignMessage\b/,
  /privateKeyToAccount|mnemonicToAccount/,
  /buildSwap/i,
  /swapExact/i,
  /exactInput(Single)?\b/,
  /exactOutput(Single)?\b/,
  /UniversalRouter/,
  /\bapi[_-]?key\b/i,
  /\bprivate[_-]?key\b/i,
  /import\s*\.\s*meta\s*\.\s*env/,
];

describe('chain package source guards', () => {
  it('scans every production source file of both sides', () => {
    expect(readSide.length).toBeGreaterThan(20);
    expect(writeSide.length).toBeGreaterThan(10);
  });

  it('the read side contains no wallet, signing, sending or swap-building code and no secret-shaped names', () => {
    const findings = readSide.flatMap((path) => {
      const code = codeTokens(path);
      return FORBIDDEN.filter((pattern) => pattern.test(code)).map((pattern) => `${relative(SRC, path)}: ${pattern.source}`);
    });
    expect(findings).toEqual([]);
  });

  it('the write side sends only through executor.ts and asks for accounts and a signature only in injected-wallet.ts', () => {
    const findings = writeSide.flatMap((path) => {
      const code = codeTokens(path);
      const allowed = WRITE_ALLOWANCE.get(relative(SRC, path)) ?? [];
      return FORBIDDEN.filter((pattern) => !allowed.some((entry) => entry.source === pattern.source) && pattern.test(code)).map((pattern) => `${relative(SRC, path)}: ${pattern.source}`);
    });
    expect(findings).toEqual([]);
    for (const [file, patterns] of WRITE_ALLOWANCE) for (const pattern of patterns) expect(codeTokens(join(SRC, file)), file).toMatch(pattern);
    // Every allowance is a forbidden pattern lifted for that one file, never a new kind of request.
    for (const patterns of WRITE_ALLOWANCE.values()) for (const pattern of patterns) expect(FORBIDDEN.map((entry) => entry.source)).toContain(pattern.source);
  });

  it('configures no mainnet chain (no viem/chains import, no chain id 1 client)', () => {
    const findings = production.filter(
      (path) => /from\s+['"]viem\/chains['"]/.test(readFileSync(path, 'utf8')) || tokenList(path).some((token) => token === 'mainnet' || token === 'MAINNET'),
    );
    expect(findings.map((path) => relative(SRC, path))).toEqual([]);
  });

  it('keeps the browser entry free of node:* imports (only node.ts may use them)', () => {
    const findings = production.filter((path) => !path.endsWith('/node.ts') && /from\s+['"]node:/.test(readFileSync(path, 'utf8')));
    expect(findings.map((path) => relative(SRC, path))).toEqual([]);
  });
});
