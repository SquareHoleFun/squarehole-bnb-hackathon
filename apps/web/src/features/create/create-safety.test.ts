/**
 * Source checks for the creation page (box creation flow § 11, acceptance 6, 8, 10): amounts never pass through
 * Number or parseFloat (they are bigint in logic, decimal strings in data), nothing here talks to a wallet provider or
 * the network, and the creator's pictures are only ever an <img> source.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const shipped = (dir: string) =>
  readdirSync(dir)
    .filter((name) => /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name))
    .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1') }));
const BOXES = ['spec-record.ts', 'created-boxes.ts', 'fee-kinds.ts', 'site-links.ts', 'collection-contract.ts', 'AboutPanel.tsx', 'ContentsPanel.tsx', 'BoxCard.tsx'];
const FILES = [...shipped(HERE), ...BOXES.map((name) => ({ name: `boxes/${name}`, text: readFileSync(join(HERE, '../boxes', name), 'utf8') }))];
const AMOUNT = /raise|first|creator|buy|wei|eth|amount|cost|price|fee|royalt|token|supply|share/i;

describe('creation page sources', () => {
  it('finds the files it checks', () => {
    expect(FILES.map((file) => file.name)).toEqual(
      expect.arrayContaining(['create-model.ts', 'CreatePage.tsx', 'BasicsStep.tsx', 'ContentsStep.tsx', 'KindStep.tsx', 'OverviewStep.tsx', 'boxes/spec-record.ts', 'boxes/fee-kinds.ts', 'boxes/site-links.ts']),
    );
  });

  it('never puts an amount through Number or parseFloat (counts, ids and byte limits only)', () => {
    for (const { name, text } of FILES) {
      expect(text, name).not.toMatch(/parseFloat/);
      for (const match of text.matchAll(/Number(?:\.parseInt)?\(([^)]*)\)/g)) {
        const argument = match[1] ?? '';
        // The spec's own size limits (MAX_TOKEN_NAME_BYTES, MAX_ADD_ONS …) and a byte limit are counts, not amounts.
        if (/^(?:MAX_[A-Z_]+|max)$/.test(argument)) continue;
        expect(argument, `${name}: ${match[0]}`).not.toMatch(AMOUNT);
      }
    }
  });

  it('asks no wallet and no server for anything: no provider, no request, no fetch, no upload', () => {
    for (const { name, text } of FILES) {
      expect(text, name).not.toMatch(/window\.ethereum|eth_[a-zA-Z]+|\.request\(|fetch\(|XMLHttpRequest|sendBeacon|WebSocket/);
    }
  });

  it('links out only with rel="noopener noreferrer" (the site links, the explorer)', () => {
    for (const { name, text } of FILES) {
      for (const match of text.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)) expect(match[0], name).toMatch(/rel="noopener noreferrer"/);
    }
  });

  it('shows the creator’s pictures only through <img> (never inlined markup or a background)', () => {
    for (const { name, text } of FILES) {
      expect(text, name).not.toMatch(/dangerouslySetInnerHTML|innerHTML|backgroundImage|<object|<iframe|<embed/);
    }
  });
});
