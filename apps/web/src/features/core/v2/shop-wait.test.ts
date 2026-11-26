// @vitest-environment node
/**
 * SH-300: the wait words, and the one place the release-1 rule could hide a release-2 box: the generated spec
 * validator (packages/box-spec/src/generated/box-spec.v2.ts) accepts a shop wait of 7, 14 or 30 days only, so a box of
 * the second release (a ten-minute wait) would be called invalid by it. No page, list or read of the site runs it on a
 * spec from the chain (box pages, the feed, My Box, search decode the spec and its shop config, nothing checks its
 * members); this pins that, so a later import cannot hide such a box without this test saying so.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { timeLeftWords, waitWords } from './shop-wait';

describe('the wait in words', () => {
  it('days, hours, minutes as set', () => {
    expect([604_800, 1_209_600, 2_592_000, 86_400, 600, 60, 3_600, 7_200, 90].map(waitWords)).toEqual(['7 days', '14 days', '30 days', '1 day', '10 minutes', '1 minute', '1 hour', '2 hours', '90 seconds']);
  });
  it('what is left, rounded up; a rounded-up 60 minutes is 1 hour and 24 hours is 1 day', () => {
    const left = (s: number) => timeLeftWords(1_000n + BigInt(s), 1_000n);
    const cases: [number, string][] = [
      [3 * 86_400 - 10, '3 days'], [86_401, '2 days'], [86_400, '1 day'], [86_399, '1 day'], [82_801, '1 day'],
      [82_800, '23 hours'], [7_200, '2 hours'], [3_601, '2 hours'], [3_600, '1 hour'], [3_599, '1 hour'], [3_541, '1 hour'],
      [3_540, '59 minutes'], [600, '10 minutes'], [300, '5 minutes'], [61, '2 minutes'], [60, '1 minute'], [1, '1 minute'],
    ];
    for (const [seconds, words] of cases) expect(left(seconds), String(seconds)).toBe(words);
    expect(timeLeftWords(1_000n, 2_000n)).toBe('1 minute');
  });
  it('a time far ahead rounds up exactly (bigint, never through a Number)', () => {
    // 2^63 days and one second ahead: as a Number the one second is lost and the count would read 2^63 days.
    const days = 2n ** 63n;
    expect(timeLeftWords(days * 86_400n + 1n, 0n)).toBe(`${days + 1n} days`);
    expect(timeLeftWords(days * 86_400n, 0n)).toBe(`${days} days`);
    // The largest uint64 activation time against a chain time of zero.
    const max = 2n ** 64n - 1n;
    expect(timeLeftWords(max, 0n)).toBe(`${(max + 86_399n) / 86_400n} days`);
  });
});

describe('the release-1 spec validator never judges a box the site shows', () => {
  // The site's runtime files and the package sources it imports (apps/web/src imports chain, domain, box-spec, artwork,
  // indexer, design, providers, links and cards): none calls any of the generated v2 validator's entry points (the three
  // validate functions and the zod schema `boxSpecV2Schema`, whose refinements run the same checks), except the generated
  // file that defines them.
  const VALIDATOR = /validate(Encoded)?BoxSpecV2(Bytes)?\b|boxSpecV2Schema\b/;
  const repo = fileURLToPath(new URL('../../../../../../', import.meta.url));
  const runtimeFiles = (dir: string): string[] => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const path = join(d, name);
        if (statSync(path).isDirectory()) { if (!['test-support', 'node_modules', 'generated-tests', '__tests__'].includes(name)) walk(path); continue; }
        if (/\.(ts|tsx|mts|cts|mjs|js|jsx|cjs|html)$/.test(name) && !/\.test\.(ts|tsx|mts|cts|mjs|js|jsx)$/.test(name) && !/\.test-support\./.test(name)) files.push(path);
      }
    };
    walk(dir);
    return files;
  };
  it('no runtime file of the site, nor of the packages it imports, calls the v2 validator', () => {
    // The site's runtime entry points too: the edge functions (the box route's preview) and the public scripts (the join
    // page is HTML only).
    // The launch app (bounties/app, served at /launches/) and the shipped HTML entries too.
    const dirs = ['apps/web/src', 'apps/web/functions', 'apps/web/public', 'bounties/app/src', ...['chain', 'domain', 'box-spec', 'artwork', 'indexer', 'design', 'providers', 'links', 'cards'].map((p) => `packages/${p}/src`)];
    const perDir = dirs.map((d) => [d, runtimeFiles(join(repo, d))] as const);
    for (const [d, list] of perDir) expect(list.length, d).toBeGreaterThan(0);
    const entries = ['apps/web/index.html', 'apps/web/join/index.html', 'bounties/app/index.html'].map((f) => join(repo, f));
    const files = [...perDir.flatMap(([, list]) => list), ...entries];
    expect(files.length).toBeGreaterThan(900);
    const naming = files.filter((f) => VALIDATOR.test(readFileSync(f, 'utf8'))).map((f) => relative(repo, f));
    expect(naming).toEqual(['packages/box-spec/src/generated/box-spec.v2.ts']);
    // Inside the generated module only the four entry points and their own internal calls name the checks: no other
    // exported function (one the site might import) runs them.
    const generated = readFileSync(join(repo, 'packages/box-spec/src/generated/box-spec.v2.ts'), 'utf8');
    const exported = generated.split(/\nexport (?=function |const )/).slice(1).map((chunk) => ({ name: /^(?:function|const) (\w+)/.exec(chunk)?.[1] ?? '', body: chunk }));
    const callers = exported.filter((f) => VALIDATOR.test(f.body.replace(new RegExp(`^(?:function|const) ${f.name}\\b`), ''))).map((f) => f.name);
    expect(callers.every((n) => ['validateBoxSpecV2', 'validateBoxSpecV2Bytes', 'validateEncodedBoxSpecV2', 'boxSpecV2Schema'].includes(n)), callers.join(', ')).toBe(true);
  });
});
