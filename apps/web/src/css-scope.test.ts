/**
 * Stylesheet scope guard (M2/M3 integration). Every feature stylesheet is bundled into one global cascade, so a class
 * styled by two features' stylesheets silently takes the later file's rules. Merging the lanes did exactly that: the
 * pair detail's `.sh-card` restyled the M1 feed cards, the rewards page's `.sh-notice` restyled the M1 feed notices,
 * the launch upload's `.sh-gallery` collapsed the detail gallery card and the detail's `.sh-rewards` painted the
 * rewards page. This test fails when a class is the subject of an unscoped rule in more than one feature directory
 * (or page stylesheet). Rules scoped under another class (`.a .b`) are contained and not counted.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = dirname(fileURLToPath(import.meta.url));

/** Reviewed overlaps: the same class deliberately styled from two places. */
const ALLOWED: Readonly<Record<string, string>> = {
  'sh-button': 'M1 shell base button; the feed adds :disabled and an accent modifier only.',
  'sh-na': 'Identical muted colour in the feed and the pair detail (one declaration each).',
  'sh-risks__intro': 'About & risks (SH-012): pair.css holds the shared card layout, risks.css the page tweak.',
};

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'scene' ? [] : cssFiles(path);
    return name.endsWith('.css') ? [path] : [];
  });
}

/** `features/<name>` for feature stylesheets, `shell` for the shell, else the file itself (e.g. `pages/risks.css`). */
function owner(path: string): string {
  const parts = relative(SRC, path).split(/[\\/]/);
  if (parts[0] === 'features') return `features/${parts[1] ?? ''}`;
  if (parts[0] === 'shell') return 'shell';
  return parts.join('/');
}

function unscopedSubjects(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const classes: string[] = [];
  for (const match of text.matchAll(/([^{};]+)\{/g)) {
    const selectorList = (match[1] ?? '').trim();
    if (selectorList.startsWith('@')) continue;
    for (const selector of selectorList.split(',')) {
      const compounds = selector.trim().split(/\s+/);
      if (compounds.length !== 1) continue;
      for (const found of (compounds[0] ?? '').matchAll(/\.([a-zA-Z][\w-]*)/g)) classes.push(found[1] ?? '');
    }
  }
  return classes;
}

describe('stylesheet scope', () => {
  it('no class is styled by unscoped rules in two features’ stylesheets', () => {
    const owners = new Map<string, Set<string>>();
    for (const file of cssFiles(SRC)) {
      for (const name of unscopedSubjects(readFileSync(file, 'utf8'))) {
        const set = owners.get(name) ?? new Set<string>();
        set.add(owner(file));
        owners.set(name, set);
      }
    }
    const shared = [...owners].filter(([name, set]) => set.size > 1 && !(name in ALLOWED)).map(([name, set]) => `${name}: ${[...set].sort().join(', ')}`);
    expect(shared).toEqual([]);
  });

  it('finds the stylesheets it guards', () => {
    const owned = new Set(cssFiles(SRC).map(owner));
    for (const expected of ['features/feed', 'features/pair', 'features/create', 'features/rewards', 'features/accounts', 'shell']) {
      expect(owned.has(expected), expected).toBe(true);
    }
    expect(resolve(SRC).endsWith(join('apps', 'web', 'src'))).toBe(true);
  });
});
