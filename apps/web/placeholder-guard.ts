import type { Plugin } from 'vite';

/**
 * The legal drafts' open items cannot ship (SH-V2-FE7). The production Terms and privacy notice mark every fact they do
 * not have yet as `[COUNSEL: …]`, `[FOUNDER: …]` or `[ENGINEERING: …]` (apps/web/src/features/legal/terms-production.ts).
 * A production build (`SH_BUILD=production`, `pnpm build:production`, the folder that is uploaded) refuses to finish
 * while one is in its output, and lists them. `SH_ALLOW_PLACEHOLDERS=1` lets a build that is never uploaded through:
 * `pnpm check:production`'s own build (it lists the same items itself) and the production smoke test's preview.
 * The output is the same either way: the variable only decides whether the build fails.
 */
const OPEN_ITEM = /\[(?:COUNSEL|FOUNDER|ENGINEERING)\b[^\]]*\]/g;

/** The distinct open items in some built text, in order of first appearance. */
export function openItems(text: string): string[] {
  return [...new Set(text.match(new RegExp(OPEN_ITEM.source, 'g')) ?? [])];
}

type Env = Readonly<Record<string, string | undefined>>;

/** The failure message, or null when the build may finish. */
export function placeholderVerdict(found: readonly string[], env: Env): string | null {
  if (found.length === 0 || env.SH_ALLOW_PLACEHOLDERS === '1') return null;
  return [
    `SH_BUILD=production: the legal texts still hold ${found.length} open ${found.length === 1 ? 'item' : 'items'} for the founder and counsel, so this build may not be uploaded (docs/evidence/SH-V2-FE10.md lists them):`,
    ...found.map((item) => `  ${item}`),
    'Fill or strike each one in apps/web/src/features/legal/terms-production.ts and privacy-production.ts. For a preview or a test that is never uploaded, set SH_ALLOW_PLACEHOLDERS=1.',
  ].join('\n');
}

export function squareHolePlaceholderGuard(env: Env, production: boolean): Plugin {
  return {
    name: 'squarehole-placeholder-guard',
    apply: 'build',
    generateBundle(_options, bundle) {
      if (!production) return;
      const found = new Set<string>();
      for (const output of Object.values(bundle)) {
        const text = output.type === 'chunk' ? output.code : typeof output.source === 'string' ? output.source : '';
        for (const item of openItems(text)) found.add(item);
      }
      const verdict = placeholderVerdict([...found], env);
      if (verdict) this.error(verdict);
    },
  };
}
