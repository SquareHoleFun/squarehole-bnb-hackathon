/**
 * SH-192 (BOXSPEC-AUTOSAVE): the reveal data this browser keeps (reveal-data.ts), built from the run's own spec bytes.
 * Open art's copy is read by the open reveal tool exactly as the full Download BoxSpec file is
 * (packages/chain/scripts/reveal-open-v2.ts `readOpenBoxSpec`), salts and all; hidden art's is the reveal file the box
 * page loads (core/v2/reveal-file.ts). Art that does not commit the run's root keeps nothing, nor does a token box.
 */
import { describe, expect, it } from 'vitest';
import { readOpenBoxSpec } from '../../../../../../packages/chain/scripts/reveal-open-v2';
import { parseRevealFile } from '../../core/v2/reveal-file';
import { buildSpec, commitArt } from '../create-model';
import { specOfRun } from './create-send';
import { buildSpecV2, recipeCtx } from './model';
import { commitsReveal, revealDataOf } from './reveal-data';
import { encodeBoxSpecV2, specHashV2 } from './spec-types';
import { CONFIGURATIONS } from './test-support/example-configurations';
import { inputV2Of } from './test-support/v2-fixtures';

const config = (id: string) => {
  const found = CONFIGURATIONS.find((entry) => entry.id === id);
  if (!found) throw new Error(id);
  return found;
};
/** The page's input for a configuration (its listings as a chain source's: no sample label), and the run's spec. */
function run(id: string) {
  const sample = inputV2Of(config(id));
  const input = { ...sample, listings: sample.listings.map((listing) => { const chain = { ...listing }; delete chain.demo; return chain; }) };
  const commitment = commitArt(input.art, input.form.artMode);
  const page = { ...input, commitment };
  const spec = specOfRun({ encoded: encodeBoxSpecV2(buildSpecV2(page)) });
  return { input: page, spec, data: () => revealDataOf({ spec, art: page.art, commitment, ctx: recipeCtx(page), v1Spec: () => buildSpec(page) }) };
}

describe('SH-192 the reveal data kept for a box', () => {
  it('open art: the BoxSpec frame with the reveal list and no picture bytes, read by reveal-open-v2.ts as the box’s own', () => {
    const { spec, data } = run('gas-guzzlers');
    const kept = data();
    expect(JSON.parse(kept?.text ?? '{}')).not.toHaveProperty('demo');
    expect(kept).not.toBeNull();
    expect(kept?.artMode).toBe('open');
    expect(kept?.fileName).toBe('guzz-reveal-data-v2.json');
    expect(kept?.specHash).toBe(specHashV2(spec).toLowerCase());
    const file = JSON.parse(kept?.text ?? '') as { pictures: unknown[]; revealList: { items: { salt: string }[] } };
    expect(file.pictures).toEqual([]);
    expect(file.revealList.items.every((item) => /^0x[0-9a-f]{64}$/.test(item.salt) && !/^0x0{64}$/.test(item.salt))).toBe(true);
    const read = readOpenBoxSpec(file);
    expect(read.tree.root).toBe(spec.revealRoot.toLowerCase());
    expect(read.specHash.toLowerCase()).toBe(specHashV2(spec).toLowerCase());
    expect(read.list.items).toHaveLength(spec.n);
  });

  it('hidden art: the reveal file, which the box page checks against the collection’s root and size', () => {
    const { spec, data } = run('ultrasound-owls');
    const kept = data();
    expect(kept?.artMode).toBe('hidden');
    expect(kept?.fileName).toBe('owl-reveal-file.json');
    const file = parseRevealFile(kept?.text ?? '', spec.revealRoot, BigInt(spec.n));
    expect(file.root).toBe(spec.revealRoot.toLowerCase());
    expect(file.revealOf(1n)?.proof.length).toBeGreaterThan(0);
  });

  it('keeps nothing for art that is not the run’s (another root or list) and nothing for a token box', () => {
    const { input, spec } = run('gas-guzzlers');
    const other = commitArt(input.art ? { ...input.art, salts: input.art.salts.map((_, i) => `0x${(i + 7).toString(16).padStart(64, '0')}` as const) } : null, 'open');
    expect(other?.revealRoot).not.toBe(spec.revealRoot);
    expect(revealDataOf({ spec, art: input.art, commitment: other, ctx: recipeCtx(input), v1Spec: () => buildSpec(input) })).toBeNull();
    expect(revealDataOf({ spec, art: input.art, commitment: null, ctx: recipeCtx(input), v1Spec: () => buildSpec(input) })).toBeNull();
    const token = run('rug-rugs');
    expect(commitsReveal(token.spec)).toBe(false);
    expect(token.data()).toBeNull();
    expect(commitsReveal(spec)).toBe(true);
  });
});
