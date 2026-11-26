/**
 * SH-258 round 3 (re-read finding 6): a BNB Chain testnet build (`SH_TESTNET=bnb`) takes the `.bnb` variant of each
 * module below in place of the module itself, at the import, so box 0's pages and panels, the unrevealed edition's art
 * and words and the first-generation box page are not in its bundle at all (the runtime switches already kept them off
 * every page). Each variant exports the same names (bnb-variants.test.ts) with nothing of box 0 in them. A Sepolia build
 * is not touched. The output's own search (testnet-output.ts `bnbOutputHits`) refuses a BNB build that still holds them.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import type { TestnetProfile } from '../../../packages/chain/src/config/testnet-profile';

/** The repository root, read when first needed (a BNB build): Vitest loads this file where import.meta.url is not a file. */
const rootDir = (): string => fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '');

/**
 * The modules a BNB build replaces, by path from the repository root, and the variant each one becomes (a name of its
 * own, so no emitted chunk carries the original's name).
 */
export const BNB_VARIANTS: Readonly<Record<string, string>> = Object.freeze({
  'packages/design/src/art/misfits-art.ts': 'packages/design/src/art/box-art.bnb.ts',
  'apps/web/src/features/boxes/bundled-picture-files.ts': 'apps/web/src/features/boxes/bundled-picture-files.bnb.ts',
  'apps/web/src/features/boxes/misfits-content.ts': 'apps/web/src/features/boxes/edition-content.bnb.ts',
  'apps/web/src/features/core/RowBoxPage.tsx': 'apps/web/src/features/core/row-page.bnb.tsx',
  'apps/web/src/pages/FitPairPage.tsx': 'apps/web/src/pages/FitPairPage.bnb.tsx',
  'apps/web/src/pages/LaunchRedirect.tsx': 'apps/web/src/pages/LaunchRedirect.bnb.tsx',
  'apps/web/src/features/core/v2/FitBurnLogV2.tsx': 'apps/web/src/features/core/v2/FitBurnLogV2.bnb.tsx',
  'apps/web/src/features/core/v2/SafesV2.tsx': 'apps/web/src/features/core/v2/SafesV2.bnb.tsx',
  'apps/web/src/features/core/v2/HiddenDrawsV2.tsx': 'apps/web/src/features/core/v2/HiddenDrawsV2.bnb.tsx',
  'packages/artwork/src/fit-picture.ts': 'packages/artwork/src/fit-picture.bnb.ts',
});

/** Folders of first-generation and box 0 code a BNB bundle must not hold at all (round 3b). */
export const FIRST_GENERATION: readonly string[] = Object.freeze(['apps/web/src/features/core/box0/', 'packages/design/art/misfits/']);

/** The variant of an absolute module path, or null when the build keeps the module. */
export function variantOf(file: string): string | null {
  const root = rootDir();
  const relative = file.startsWith(`${root}/`) ? file.slice(root.length + 1) : null;
  const variant = relative === null ? undefined : BNB_VARIANTS[relative];
  return variant === undefined ? null : resolve(root, variant);
}

export function bnbVariants(profile: TestnetProfile): Plugin {
  return {
    name: 'squarehole-bnb-variants',
    enforce: 'pre',
    apply: 'build',
    async resolveId(source, importer, options) {
      if (profile.name !== 'bnb' || source.includes('.bnb')) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved || resolved.external) return null;
      const variant = variantOf(resolved.id.split('?')[0] ?? '');
      if (variant === null) return null;
      return variant;
    },
    // Round 3b: the originals must not be in the emitted module graph at all (by path, whatever imported them).
    generateBundle(_options, bundle) {
      if (profile.name !== 'bnb') return;
      const root = rootDir();
      const found = new Set<string>();
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const id of Object.keys(chunk.modules)) {
          const file = (id.split('?')[0] ?? '').replace(/^\0/, '');
          const relative = file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file;
          if (Object.hasOwn(BNB_VARIANTS, relative) || FIRST_GENERATION.some((dir) => relative.startsWith(dir))) found.add(`${relative} (in ${chunk.fileName})`);
        }
      }
      if (found.size) this.error(`SH-258: the BNB bundle holds modules it must not: ${[...found].join(', ')}`);
    },
    buildStart() {
      if (profile.name !== 'bnb') return;
      const missing = Object.values(BNB_VARIANTS).filter((file) => !existsSync(resolve(rootDir(), file)));
      if (missing.length) this.error(`SH-258: no BNB variant for ${missing.join(', ')}`);
    },
  };
}
