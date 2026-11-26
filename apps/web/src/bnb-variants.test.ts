// @vitest-environment node
/**
 * SH-258 round 3 (re-read finding 6): every module a BNB Chain testnet build swaps for its `.bnb` variant
 * (build/bnb-variants.ts) keeps the original's exports, so a page that imports it builds and runs the same; and the
 * output search refuses box 0's words (build/testnet-output.ts), with each remaining string named.
 */
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BNB_VARIANTS, variantOf } from '../build/bnb-variants';
import { BNB_OUTPUT_EXCEPTIONS, BNB_REVIEWED_SENTENCES, bnbOutputHits, bnbOutputIdentity } from '../build/testnet-output';

const ROOT = resolve(import.meta.dirname, '../../..');

describe('the BNB variants', () => {
  it.each(Object.entries(BNB_VARIANTS))('%s: the variant exports every name the original exports', async (original, variant) => {
    const [a, b] = await Promise.all([import(/* @vite-ignore */ resolve(ROOT, original)), import(/* @vite-ignore */ resolve(ROOT, variant))]);
    expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
  });

  it('a listed module resolves to its variant; any other module is kept', () => {
    expect(variantOf(resolve(ROOT, 'apps/web/src/features/core/RowBoxPage.tsx'))).toBe(resolve(ROOT, 'apps/web/src/features/core/row-page.bnb.tsx'));
    expect(variantOf(resolve(ROOT, 'apps/web/src/pages/BoxPage.tsx'))).toBeNull();
  });
});

describe('the BNB output search', () => {
  it('a file name or text with the edition, box 0 or the coin stops the build; a named exception does not', () => {
    const out = mkdtempSync(join(tmpdir(), 'sh258-scan-'));
    mkdirSync(join(out, 'assets'));
    writeFileSync(join(out, 'assets', 'a.js'), 'const x = `The Misfits`; const y = `Box 0`; const z = `buy FIT now`; const fine = `does not fit`;');
    writeFileSync(join(out, 'assets', 'cover-misfits-1.webp'), '');
    writeFileSync(join(out, 'assets', 'web-1234abcd.css'), '.sh-box0-actions{gap:0}');
    const hits = bnbOutputHits(out);
    rmSync(out, { recursive: true, force: true });
    expect(hits.filter((hit) => hit.includes('(its name)'))).toEqual(['assets/cover-misfits-1.webp: (its name)']);
    expect(hits.filter((hit) => hit.startsWith('assets/a.js'))).toHaveLength(3);
    expect(hits.some((hit) => hit.startsWith('assets/web-1234abcd.css'))).toBe(false);
    expect(BNB_OUTPUT_EXCEPTIONS.every((exception) => exception.why.length > 20)).toBe(true);
  });
});

describe('round 3b: the strict search', () => {
  const identity = bnbOutputIdentity(ROOT);

  it('knows the edition pictures by their bytes and the swapped-out modules by their pinned sentences', () => {
    expect(identity.pictures.size).toBeGreaterThanOrEqual(29);
    expect(identity.sentences).toEqual(BNB_REVIEWED_SENTENCES.map((row) => row.sentence));
    // Each pinned sentence is still its module's (the pin names real text), and its module is one the build swaps out.
    for (const { module, sentence } of BNB_REVIEWED_SENTENCES) {
      expect(Object.keys(BNB_VARIANTS), module).toContain(module);
      expect(readFileSync(resolve(ROOT, module), 'utf8'), sentence).toContain(sentence);
    }
  });

  it('round 4: a named sentence copied into a kept BNB module still fails the build (the list does not follow kept sources)', () => {
    const named = 'Burns from the FIT Safe need a second owner’s signature.';
    expect(identity.sentences).toContain(named);
    const out = mkdtempSync(join(tmpdir(), 'sh258-kept-'));
    mkdirSync(join(out, 'assets'));
    // As the bundle would hold it had a kept page (BoxPage) taken the sentence over.
    writeFileSync(join(out, 'assets', 'BoxPage-1234abcd.js'), `const line = \`${named}\`;`);
    const hits = bnbOutputHits(out, identity);
    rmSync(out, { recursive: true, force: true });
    expect(hits.some((hit) => hit === `assets/BoxPage-1234abcd.js: a swapped-out sentence "${named}"`)).toBe(true);
  });

  it('a neutral-named copy of an edition picture, its inlined data URL, a swapped sentence and a Demo word are each a hit', () => {
    const out = mkdtempSync(join(tmpdir(), 'sh258-strict-'));
    mkdirSync(join(out, 'assets'));
    copyFileSync(resolve(ROOT, 'packages/design/art/misfits/m-B02.webp'), join(out, 'assets', 'plain-1234abcd.webp'));
    const inline = readFileSync(resolve(ROOT, 'packages/design/art/misfits/m-B02.webp')).toString('base64');
    writeFileSync(join(out, 'assets', 'a.js'), `const p = "data:image/webp;base64,${inline}";`);
    writeFileSync(join(out, 'assets', 'guide.mjs'), `const s = \`${identity.sentences[0]}\`; const d = \`Demo snapshot · during the curve\`;`);
    const hits = bnbOutputHits(out, identity);
    rmSync(out, { recursive: true, force: true });
    expect(hits.some((hit) => hit.startsWith('assets/plain-1234abcd.webp: the edition picture packages/design/art/misfits/m-B02.webp'))).toBe(true);
    expect(hits.some((hit) => hit.startsWith('assets/a.js: the edition picture') && hit.endsWith('inlined'))).toBe(true);
    expect(hits.some((hit) => hit.startsWith('assets/guide.mjs: a swapped-out sentence'))).toBe(true);
    expect(hits.some((hit) => hit.startsWith('assets/guide.mjs: …') && hit.includes('Demo snapshot'))).toBe(true);
  });

  it('an exception covers only its exact text in its own file, never a word next to it or the same text elsewhere', () => {
    const out = mkdtempSync(join(tmpdir(), 'sh258-exact-'));
    mkdirSync(join(out, 'assets'));
    writeFileSync(join(out, 'assets', 'web-1234abcd.css'), '.sh-box0-actions{gap:0}/* The Misfits */');
    writeFileSync(join(out, 'assets', 'other-1234abcd.css'), '.sh-box0-actions{gap:0}');
    const hits = bnbOutputHits(out, identity);
    rmSync(out, { recursive: true, force: true });
    expect(hits.filter((hit) => hit.startsWith('assets/web-1234abcd.css'))).toHaveLength(1);
    expect(hits.filter((hit) => hit.startsWith('assets/web-1234abcd.css'))[0]).toContain('Misfits');
    expect(hits.filter((hit) => hit.startsWith('assets/other-1234abcd.css'))).toHaveLength(1);
    // SH-275: the join page's own files (join/assets/) as well, now that the BNB build makes it.
    expect(BNB_OUTPUT_EXCEPTIONS.every((exception) => /^(?:join\/)?assets\//.test(exception.file) && exception.text.length >= 5)).toBe(true);
  });
});
