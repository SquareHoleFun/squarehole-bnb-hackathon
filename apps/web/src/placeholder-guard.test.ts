// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { openItems, placeholderVerdict, squareHolePlaceholderGuard } from '../placeholder-guard';
import { PRODUCTION_TERMS } from './features/legal/terms-production';
import { termsTextOf } from './features/legal/terms-common';

/** The production build refuses to finish while the legal drafts hold an open item (SH-V2-FE7). */
describe('the placeholder guard of the production build', () => {
  it('finds each open item once, whole, and never the pages’ own pattern for them', () => {
    const code = 'a="[COUNSEL: legal entity] and [FOUNDER + COUNSEL: sign-off]";b="[COUNSEL: legal entity]";c=/(\\[(?:COUNSEL|FOUNDER|ENGINEERING)\\b[^\\]]*\\])/;d="[founder: no]"';
    expect(openItems(code)).toEqual(['[COUNSEL: legal entity]', '[FOUNDER + COUNSEL: sign-off]']);
    expect(openItems('no items here')).toEqual([]);
  });

  it('fails a production build that holds one, unless the build is marked as never uploaded', () => {
    const found = openItems(termsTextOf(PRODUCTION_TERMS.gate, PRODUCTION_TERMS.document).join(' '));
    expect(found.length).toBeGreaterThan(40);
    const verdict = placeholderVerdict(found, {});
    expect(verdict?.split('\n')[0]).toBe(`SH_BUILD=production: the legal texts still hold ${found.length} open items for the founder and counsel, so this build may not be uploaded (docs/evidence/SH-V2-FE10.md lists them):`);
    expect(verdict).toContain('  [COUNSEL: legal entity name, legal form, registered address and company number; no entity is formed yet]');
    expect(placeholderVerdict(found, { SH_ALLOW_PLACEHOLDERS: '1' })).toBeNull();
    expect(placeholderVerdict(found, { SH_ALLOW_PLACEHOLDERS: 'yes' })).not.toBeNull();
    expect(placeholderVerdict([], {})).toBeNull();
  });

  it('reads every chunk and text asset of the bundle, and only in a production build', () => {
    const run = (production: boolean, env: Record<string, string> = {}) => {
      const errors: string[] = [];
      const plugin = squareHolePlaceholderGuard(env, production);
      const hook = plugin.generateBundle as unknown as (this: { error: (message: string) => never }, options: unknown, bundle: Record<string, unknown>) => void;
      const context = { error: (message: string): never => { errors.push(message); throw new Error(message); } };
      try {
        hook.call(context, {}, { 'a.js': { type: 'chunk', code: 'x="[ENGINEERING: confirm]"' }, 'b.css': { type: 'asset', source: 'p{}' }, 'c.json': { type: 'asset', source: '{"t":"[FOUNDER: how]"}' } });
      } catch {
        // the build stops here
      }
      return errors;
    };
    expect(run(true)).toHaveLength(1);
    expect(run(true)[0]).toContain('  [ENGINEERING: confirm]\n  [FOUNDER: how]');
    expect(run(true, { SH_ALLOW_PLACEHOLDERS: '1' })).toEqual([]);
    expect(run(false)).toEqual([]);
    expect(squareHolePlaceholderGuard({}, true).apply).toBe('build');
  });
});
