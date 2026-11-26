/**
 * `@squarehole/indexer/client` is bundled into the app (the FIT pair page, v2 T19). Its import graph must stay free of
 * Node, Redis, sockets and the service: only the pure modules (shape, math, curve, views) and value imports from the
 * browser-safe `@squarehole/chain` / `@squarehole/domain` entries; `viem` only as types.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as client from '../src/client';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const ALLOWED_PACKAGES = new Set(['@squarehole/chain', '@squarehole/domain', '@squarehole/box-spec']);

interface Import {
  readonly specifier: string;
  readonly typeOnly: boolean;
}

function importsOf(file: string): Import[] {
  const text = readFileSync(file, 'utf8');
  const found: Import[] = [];
  for (const match of text.matchAll(/^(import|export)\s+(type\s+)?[^'";]*?from\s+'([^']+)'/gm)) {
    found.push({ specifier: match[3] ?? '', typeOnly: match[2] !== undefined });
  }
  return found;
}

function walk(file: string, seen: Set<string>, external: Import[]): void {
  if (seen.has(file)) return;
  seen.add(file);
  for (const entry of importsOf(file)) {
    if (entry.specifier.startsWith('.')) {
      // A type-only import is erased from the bundle (verbatimModuleSyntax), whatever it points at.
      if (entry.typeOnly) continue;
      walk(resolve(dirname(file), `${entry.specifier}.ts`), seen, external);
    } else {
      external.push(entry);
    }
  }
}

describe('@squarehole/indexer/client', () => {
  it('pulls in no Node, Redis, socket or service module', () => {
    const seen = new Set<string>();
    const external: Import[] = [];
    walk(resolve(SRC, 'client.ts'), seen, external);
    const files = [...seen].map((path) => path.slice(SRC.length + 1)).sort();
    expect(files).toEqual(['client.ts', 'core/core-fees.ts', 'core/core-math.ts', 'core/core-row.ts', 'core/core-views.ts', 'core/derive-core.ts', 'core/direct-view.ts', 'curve.ts', 'model.ts', 'shape.ts', 'v4-math.ts', 'views.ts']);
    const valueImports = external.filter((entry) => !entry.typeOnly).map((entry) => entry.specifier);
    expect(valueImports.every((specifier) => ALLOWED_PACKAGES.has(specifier)), valueImports.join(', ')).toBe(true);
    expect(external.filter((entry) => entry.specifier === 'viem').every((entry) => entry.typeOnly)).toBe(true);
  });

  it('exports what the page needs', () => {
    expect(client.SNAPSHOT_SCHEMA).toBe('sh.live-pool.v1');
    expect(client.MISFITS_CURVE.raiseWei).toBe(client.BAND_TARGET_WEI);
    expect(typeof client.stateView).toBe('function');
    expect(typeof client.windowView).toBe('function');
    expect(typeof client.computeSwapStepExactIn).toBe('function');
  });
});
