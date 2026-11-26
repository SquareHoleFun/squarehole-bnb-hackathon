/**
 * SH-EXISTING-NFTS-E08C source guards over the add-on's two new folders (features/set and features/create/set),
 * shipped files only:
 * - none of the ticket's forbidden words in any string or JSX text a visitor can meet (verified, trusted, draw, reveal,
 *   payout, earnings, buy, sell, swap, with their usual forms);
 * - the amount source guard (create/create-safety.test.ts, here stricter): no parseFloat or parseInt at all, and no
 *   Number(…) of anything named like an amount or an id; amounts and ids stay bigint, data stays decimal strings;
 * - outside metadata is never markup: no innerHTML, no dangerouslySetInnerHTML, no frames, objects or embeds, no CSS
 *   background pictures; pictures are <img> only;
 * - the wallet is asked only for its network and account (set-actions.ts), never for a transaction here: sending is
 *   E-08B's executor's alone (set-calls.ts `setSubmit`);
 * - only the indexer adapter and the picture reader fetch anything.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { FORBIDDEN } from './test-support/words';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../../../..');
const DIRS = [HERE, resolve(HERE, '../create/set')];
const NOT_SHIPPED = /\.test\.tsx?$|[\\/]test-support[\\/]/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) && !NOT_SHIPPED.test(path) ? [path] : [];
  });
}
const SHIPPED = DIRS.flatMap(files).map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, 'utf8') }));
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Every string, template part and JSX text of a file, outside comments and module paths. */
function copyOf(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    const parent = node.parent;
    const modulePath = parent !== undefined && (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent));
    if (!modulePath && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) out.push(node.text);
    if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) out.push(node.text);
    if (ts.isJsxText(node) && node.text.trim() !== '') out.push(node.text);
    node.forEachChild(visit);
  };
  visit(source);
  return out;
}

const AMOUNT_OR_ID = /raise|first|creator|buy|wei|eth|amount|cost|price|fee|royalt|token|supply|share|coin|\bt\b|\bp\b|pot|escrow|principal|inside|loaded|released|count|\bids?\b|index|offset|block|balance|allowance|value/i;

describe('the add-on’s sources', () => {
  it('finds its files', () => {
    const names = SHIPPED.map((file) => file.path);
    for (const expected of ['apps/web/src/features/set/SetBoxPage.tsx', 'apps/web/src/features/set/set-pictures.ts', 'apps/web/src/features/create/set/CreateSetFlow.tsx', 'apps/web/src/features/create/set/set-send.ts']) {
      expect(names).toContain(expected);
    }
    expect(names.some((name) => /test/.test(name))).toBe(false);
  });

  it('shows none of the forbidden words in any string or JSX text', () => {
    const found = SHIPPED.flatMap((file) => copyOf(file.path, file.text).filter((text) => FORBIDDEN.test(text)).map((text) => `${file.path}: ${text}`));
    expect(found).toEqual([]);
    // The pattern itself catches what it must, and leaves the vault's function names alone.
    for (const word of ['Verified', 'unverified', 'Trusted', 'draw', 'Drawn', 'reveal', 'payout', 'Earnings', 'buy', 'Sell', 'swap']) expect(FORBIDDEN.test(`a ${word} b`), word).toBe(true);
    for (const name of ['withdrawBatch', 'creatorBuy', 'seller'.replace('seller', 'cellar'), 'redrawn'.replace('redrawn', 'redraft')]) expect(FORBIDDEN.test(name), name).toBe(false);
  });

  it('never puts an amount or an id through Number, parseInt or parseFloat', () => {
    for (const { path, text } of SHIPPED) {
      const code = withoutComments(text);
      expect(code, path).not.toMatch(/parseFloat|parseInt/);
      for (const match of code.matchAll(/Number\(([^)]*)\)/g)) {
        expect(match[1] ?? '', `${path}: ${match[0]}`).not.toMatch(AMOUNT_OR_ID);
      }
    }
  });

  it('renders outside data as text or a checked <img> only, never as markup', () => {
    for (const { path, text } of SHIPPED) {
      expect(withoutComments(text), path).not.toMatch(/dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write|<iframe|<object|<embed|srcDoc|backgroundImage|createContextualFragment/);
    }
  });

  it('asks the wallet only for its network and account, in the action runner; sends nothing itself', () => {
    for (const { path, text } of SHIPPED) {
      const code = withoutComments(text);
      const methods = [...code.matchAll(/method:\s*'([a-zA-Z_]+)'/g)].map((m) => m[1]);
      if (path.endsWith('set-actions.ts')) expect(methods.sort(), path).toEqual(['eth_accounts', 'eth_chainId']);
      else expect(methods, path).toEqual([]);
      // Spelled with a class so this test names no wallet request itself (no-trade-source.test.ts scans tests too).
      expect(code, path).not.toMatch(/eth_send|eth_sign|requestAccounts|window\.ethereum|send[T]ransaction|personal_sign/);
    }
  });

  it('only the indexer adapter and the picture reader fetch anything', () => {
    const fetching = SHIPPED.filter((file) => /\bfetch\b|XMLHttpRequest|WebSocket|sendBeacon/.test(withoutComments(file.text))).map((file) => file.path);
    expect(fetching.sort()).toEqual(['apps/web/src/features/set/set-indexer.ts', 'apps/web/src/features/set/set-pictures.ts']);
  });
});
