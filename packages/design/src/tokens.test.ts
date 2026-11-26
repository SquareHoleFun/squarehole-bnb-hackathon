import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compositeOver, contrastRatio } from './contrast';

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

/** `--name: value;` declarations inside the first `:root { … }` block. */
function rootTokens(css: string): Map<string, string> {
  const root = /:root\s*\{([\s\S]*?)\n\}/.exec(css);
  if (!root?.[1]) throw new Error('no :root block');
  const body = root[1].replace(/\/\*[\s\S]*?\*\//g, '');
  const tokens = new Map<string, string>();
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    tokens.set(match[1] as string, (match[2] as string).trim().replace(/\s+/g, ' '));
  }
  return tokens;
}

const handoff = rootTokens(read('../../../square-hole-handoff/design/tokens.css'));
const ours = rootTokens(read('./styles/tokens.css'));
const hex = (name: string): string => {
  const value = ours.get(name);
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${name} is not a solid hex token: ${value}`);
  return value;
};

describe('tokens.css keeps the handoff values', () => {
  it('declares every handoff token with the same value (font stack only extended)', () => {
    expect(handoff.size).toBeGreaterThan(15);
    for (const [name, value] of handoff) {
      if (name === '--sh-font') {
        expect(ours.get('--sh-font-fallback')).toBe(value);
        expect(ours.get('--sh-font')).toBe("'Plus Jakarta Sans Variable', var(--sh-font-fallback)");
        continue;
      }
      expect(ours.get(name), name).toBe(value);
    }
  });

  it('adds the 02-DESIGN scales', () => {
    const px = (name: string) => ours.get(name);
    expect(['4px', '8px', '12px', '16px', '24px', '32px', '48px']).toEqual(
      ['--sh-gap-1', '--sh-gap-2', '--sh-gap-3', '--sh-gap-4', '--sh-gap-6', '--sh-gap-8', '--sh-gap-12'].map(px),
    );
    expect(px('--sh-radius-card')).toBe('16px');
    expect(px('--sh-radius-control')).toBe('10px');
    // Titles 28–36, section 20–24, body 15–16, table labels 12–14 (02-DESIGN).
    expect(px('--sh-type-title')).toBe('32px');
    expect(px('--sh-type-section')).toBe('22px');
    expect(px('--sh-type-body')).toBe('15px');
    expect(px('--sh-type-label')).toBe('13px');
    // Layout budgets at 1440×900 and 390×844.
    expect(px('--sh-topbar-h')).toBe('64px');
    expect(px('--sh-topbar-h-compact')).toBe('56px');
    expect(px('--sh-sidebar-w')).toBe('192px');
    expect(px('--sh-main-pad')).toBe('24px');
    expect(px('--sh-touch-target')).toBe('44px');
    for (const z of ['--sh-z-sticky', '--sh-z-header', '--sh-z-drawer', '--sh-z-popover', '--sh-z-skip']) {
      expect(ours.has(z), z).toBe(true);
    }
    for (const e of ['--sh-elevation-1', '--sh-elevation-2', '--sh-elevation-3']) expect(ours.has(e), e).toBe(true);
  });
});

// Measured, not inferred (02-DESIGN). AA normal text 4.5:1; non-text UI and focus indicators 3:1.
const SURFACES = ['--sh-canvas', '--sh-surface', '--sh-surface-raised', '--sh-panel-top', '--sh-selected'] as const;
const TEXT_ON_SURFACES = [
  '--sh-text',
  '--sh-text-secondary',
  '--sh-text-muted',
  '--sh-accent',
  '--sh-positive',
  '--sh-negative',
  '--sh-warning',
] as const;

describe('WCAG contrast of token pairs', () => {
  for (const fg of TEXT_ON_SURFACES) {
    for (const bg of SURFACES) {
      it(`${fg} on ${bg} ≥ 4.5:1 (normal text)`, () => {
        expect(contrastRatio(hex(fg), hex(bg))).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it('text on the brightest point of the panel glow stays ≥ 4.5:1', () => {
    const alpha = Number(/([\d.]+)\)$/.exec(ours.get('--sh-glow') ?? '')?.[1]);
    expect(alpha).toBeGreaterThan(0);
    const peak = compositeOver(hex('--sh-accent'), alpha, hex('--sh-panel-top'));
    for (const fg of TEXT_ON_SURFACES) expect(contrastRatio(hex(fg), peak), fg).toBeGreaterThanOrEqual(4.5);
  });

  it('text on the filled action colour ≥ 4.5:1', () => {
    expect(contrastRatio(hex('--sh-on-action'), hex('--sh-action'))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(hex('--sh-on-action'), hex('--sh-action-hover'))).toBeGreaterThanOrEqual(4.5);
  });

  it('Demo badge text ≥ 4.5:1 and its border ≥ 3:1 against the canvas', () => {
    expect(contrastRatio(hex('--sh-warning'), hex('--sh-demo-bg'))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(hex('--sh-warning'), hex('--sh-canvas'))).toBeGreaterThanOrEqual(3);
  });

  it('focus ring is visible on dark surfaces and, via its dark halo, on light artwork', () => {
    for (const bg of SURFACES) expect(contrastRatio(hex('--sh-focus-ring'), hex(bg)), bg).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(hex('--sh-focus-halo'), '#ffffff')).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(hex('--sh-focus-ring'), hex('--sh-focus-halo'))).toBeGreaterThanOrEqual(3);
  });

  it('control boundaries (--sh-border-strong) ≥ 3:1 on every surface', () => {
    for (const bg of SURFACES) expect(contrastRatio(hex('--sh-border-strong'), hex(bg)), bg).toBeGreaterThanOrEqual(3);
  });

  it('documents the failing pairs that usage rules forbid', () => {
    // --sh-action is a fill, never a text colour on dark surfaces.
    expect(contrastRatio(hex('--sh-action'), hex('--sh-surface-raised'))).toBeLessThan(4.5);
    // Muted/secondary/accent text never sits on the action fill.
    expect(contrastRatio(hex('--sh-text-muted'), hex('--sh-action'))).toBeLessThan(4.5);
    expect(contrastRatio(hex('--sh-accent'), hex('--sh-action'))).toBeLessThan(4.5);
    // --sh-border is decorative only (separators), never the sole boundary of a control.
    expect(contrastRatio(hex('--sh-border'), hex('--sh-surface'))).toBeLessThan(3);
  });
});
