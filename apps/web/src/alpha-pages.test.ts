// @vitest-environment node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, type Plugin, type Rolldown } from 'vite';
import { describe, expect, it } from 'vitest';
import { shLimit } from '../../../vitest.timeouts.mjs';
import { ALPHA_PAGES, ALPHA_PAGES_REGISTRY, alphaPages } from '../build/alpha-pages';
import { PRIVY_TRIMMED, privyTrims, trimmedStub } from '../build/privy-trims';
import { buildDefines } from '../build-target';
import { htmlReferences, importsOf, TRADE_SOURCE } from '../production-check';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * F161 (4), SH-ALPHA-SITE (SH-ALPHA-API integrator request 1): one build makes the join page and the desk, each with its
 * own complete asset graph under its own folder, so the public join page never needs a file of the private app and the
 * desk none of the app's or the join page's. Built here as the app's build runs them (build/alpha-pages.ts), for the
 * Sepolia production target, around an empty app.
 */
async function buildPages(): Promise<{ files: Map<string, string>; registry: { fileName: string; moduleIds: string[] }[]; sources: Set<string> }> {
  const env = { SH_BUILD: 'production', SH_TARGET: 'sepolia' };
  const registry = { chunks: [] as { fileName: string; moduleIds: string[] }[] };
  const sources = new Set<string>();
  const app: Plugin = { name: 'empty-app', resolveId: (id) => (id === 'virtual:empty-app' ? '\0empty-app' : null), load: (id) => (id === '\0empty-app' ? 'export default 1;' : null) };
  (globalThis as Record<symbol, unknown>)[ALPHA_PAGES_REGISTRY] = registry;
  try {
    const result = await build({
      configFile: false, root: WEB, logLevel: 'silent', publicDir: false, define: buildDefines(env, 'build'),
      plugins: [app, alphaPages({ define: buildDefines(env, 'build'), production: true, sources })],
      build: { write: false, outDir: join(WEB, '.cache/alpha-pages-test/dist'), emptyOutDir: false, copyPublicDir: false, rolldownOptions: { input: 'virtual:empty-app' } },
    }) as Rolldown.RolldownOutput;
    const files = new Map(result.output.filter((item) => item.type === 'asset').map((item) => [item.fileName, typeof item.source === 'string' ? item.source : Buffer.from(item.source).toString('latin1')]));
    return { files, registry: registry.chunks, sources };
  } finally {
    Reflect.deleteProperty(globalThis, ALPHA_PAGES_REGISTRY);
  }
}

/** Every file a page's HTML and scripts name, from its HTML through every static and dynamic import. */
function reached(files: ReadonlyMap<string, string>, html: string): { readonly all: Set<string>; readonly firstPaint: Set<string> } {
  const named = (reference: string, from: string): string | null => {
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(reference)) return null;
    const path = reference.split(/[?#]/)[0] ?? '';
    return path.startsWith('/') ? path.slice(1) : posix.join(posix.dirname(from), path);
  };
  const firstPaint = new Set<string>();
  const queue = htmlReferences(files.get(html) ?? '').map((reference) => named(reference, html)).filter((file): file is string => file !== null);
  const walk = (start: string[], into: Set<string>, follow: 'static' | 'both') => {
    const pending = [...start];
    while (pending.length > 0) {
      const file = pending.shift() as string;
      if (into.has(file)) continue;
      into.add(file);
      if (!file.endsWith('.js')) continue;
      const imports = importsOf(files.get(file) ?? '');
      for (const reference of follow === 'static' ? imports.static : [...imports.static, ...imports.dynamic]) {
        const next = named(reference, file);
        if (next) pending.push(next);
      }
    }
  };
  walk(queue, firstPaint, 'static');
  const all = new Set<string>();
  walk(queue, all, 'both');
  return { all, firstPaint };
}

describe('the alpha’s join and desk pages (F161 (4), SH-ALPHA-SITE)', () => {
  it('each page’s files sit under its own folder, and everything it loads is its own', async () => {
    const { files, registry, sources } = await buildPages();
    for (const page of ALPHA_PAGES) {
      expect(files.has(page.html), page.html).toBe(true);
      const own = [...files.keys()].filter((file) => file.startsWith(`${page.name}/`));
      expect(own.every((file) => file === page.html || file.startsWith(`${page.assets}/`)), own.join(', ')).toBe(true);
      // Flat names only, as Caddy's public join route serves them (infra/server/Caddyfile `@alpha_join`).
      expect(own.filter((file) => file !== page.html).every((file) => /^[a-z]+\/assets\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(file)), page.name).toBe(true);
      const { all } = reached(files, page.html);
      expect(all.size).toBeGreaterThanOrEqual(2);
      for (const file of all) {
        expect(file.startsWith(`${page.assets}/`), `${page.name} loads ${file}`).toBe(true);
        expect(files.has(file), `${page.name} names ${file}, which its build did not write`).toBe(true);
      }
      expect(files.has(`${page.assets}/third-party-notices.txt`)).toBe(true);
    }
    // The check's builder gets every chunk with its modules; the notices sources reach the app's own file.
    expect(registry.length).toBeGreaterThan(10);
    for (const chunk of registry) expect(files.has(chunk.fileName), chunk.fileName).toBe(true);
    expect([...sources].some((file) => file.includes('/node_modules/') && file.includes('@privy-io'))).toBe(true);
  }, shLimit(240_000));

  it('Privy’s SDK and every trade-folder module load lazily on the join page and never on the desk; Privy’s turned-off features stay out', async () => {
    const { files, registry } = await buildPages();
    const join = reached(files, 'join/index.html');
    const desk = reached(files, 'desk/index.html');
    const modulesOf = (fileName: string) => registry.find((chunk) => chunk.fileName === fileName)?.moduleIds ?? [];
    const repo = resolve(WEB, '../..');
    const tradeOrPrivy = (id: string) => /[\\/]node_modules[\\/]\.pnpm[\\/]@privy-io\+/.test(id) || TRADE_SOURCE.test(id.replace(`${repo}/`, ''));
    for (const file of join.firstPaint) {
      expect(modulesOf(file).filter(tradeOrPrivy), `${file} is first paint`).toEqual([]);
      expect(files.get(file) ?? '', file).not.toMatch(/auth\.privy\.io|privy\.systems/);
    }
    const lazy = [...join.all].filter((file) => !join.firstPaint.has(file));
    expect(lazy.some((file) => modulesOf(file).some(tradeOrPrivy))).toBe(true);
    expect(lazy.some((file) => /auth\.privy\.io/.test(files.get(file) ?? ''))).toBe(true);
    for (const file of desk.all) expect(modulesOf(file).filter(tradeOrPrivy), file).toEqual([]);
    const ids = registry.flatMap((chunk) => chunk.moduleIds);
    for (const name of Object.keys(PRIVY_TRIMMED)) expect(ids.filter((id) => id.includes(`/node_modules/${name}/`)), name).toEqual([]);
    expect(ids.some((id) => /[\\/]@walletconnect[\\/]|[\\/]@reown[\\/]/.test(id))).toBe(false);
    expect(ids.some((id) => id.includes(`sh-privy-trimmed:@walletconnect/ethereum-provider`))).toBe(true);
  }, shLimit(240_000));
});

describe('Privy’s turned-off features as stubs (F161 (4), SH-ALPHA-SITE)', () => {
  it('each stub exports the names it lists, holds nothing and refuses when called', async () => {
    for (const name of Object.keys(PRIVY_TRIMMED)) {
      const folder = join(WEB, '.cache/alpha-pages-test');
      mkdirSync(folder, { recursive: true });
      const file = join(folder, `stub-${name.replace(/[^a-z0-9]+/gi, '-')}.mjs`);
      writeFileSync(file, trimmedStub(name));
      const module = await import(/* @vite-ignore */ pathToFileURL(file).href) as Record<string, unknown>;
      const entry = PRIVY_TRIMMED[name] as (typeof PRIVY_TRIMMED)[string];
      for (const call of entry.calls) expect(() => (module[call] as () => unknown)(), `${name} ${call}`).toThrow(`${name} is not part of this build (build/privy-trims.ts)`);
      for (const value of Object.keys(entry.values ?? {})) expect(module[value], `${name} ${value}`).not.toBeUndefined();
      expect(() => (module.default as () => unknown)()).toThrow('is not part of this build');
    }
    expect(() => trimmedStub('react')).toThrow('react is not trimmed');
  });

  it('replaces only the listed packages', () => {
    const plugin = privyTrims();
    const resolveId = plugin.resolveId as (source: string) => string | null;
    expect(resolveId('@walletconnect/ethereum-provider')).toBe('\0sh-privy-trimmed:@walletconnect/ethereum-provider');
    expect(resolveId('@walletconnect/ethereum-provider/sub')).toBeNull();
    expect(resolveId('@privy-io/react-auth')).toBeNull();
    expect(resolveId('viem')).toBeNull();
  });
});
