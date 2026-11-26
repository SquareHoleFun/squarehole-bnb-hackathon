// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The declarations of each rule, by selector, in a stylesheet (flat rules only, as both files write them). */
function rules(css: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    found.set((match[1] ?? '').trim().replace(/\s+/g, ' '), (match[2] ?? '').split(';').map((part) => part.trim().replace(/\s+/g, ' ')).filter(Boolean).join('; '));
  }
  return found;
}

/**
 * F161 (4), SH-ALPHA-SITE: the join page and the desk load no shell styles (their own builds, build/alpha-pages.ts), so
 * join.css carries the app's button under `.sh-join`; the two copies stay equal.
 */
describe('the join and desk pages’ button (F161 (4), SH-ALPHA-SITE)', () => {
  it('is the app’s button, declaration for declaration', () => {
    const shell = rules(readFileSync(join(HERE, '../../../shell/shell.css'), 'utf8'));
    const pages = rules(readFileSync(join(HERE, 'join.css'), 'utf8'));
    for (const selector of ['.sh-button', '.sh-button--primary', '.sh-button--primary:hover', '.sh-button--primary:focus-visible']) {
      expect(shell.get(selector), selector).toBeTruthy();
      expect(pages.get(`.sh-join ${selector}`), selector).toBe(shell.get(selector));
    }
  });
});
