// @vitest-environment node
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { shLimit } from '../../../vitest.timeouts.mjs';

/**
 * SH-RC7 open item 30 (SH-V21-RC6-INT P5.5, RR.3): the chain suite and the examples run on the dev server, and a late
 * file event for the stack's own manifest reached the deployments plugin's watch while a box page loaded, so the dev
 * server pushed an update of the deployments module and its importers mid-test. `SH_DEV_SERVER_WATCH=off` (set by those
 * two stacks only) starts the dev server with no file watcher at all, so no file event can update or reload its
 * modules; the founder's `pnpm dev` and `pnpm dev:core-v2-local` keep watching. These run the real config
 * (vite.config.ts) through Vite's own dev server, never listening on a port.
 */
const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const saved = { watch: process.env.SH_DEV_SERVER_WATCH, manifest: process.env.SH_CORE_LOCAL_MANIFEST };
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  if (saved.watch === undefined) delete process.env.SH_DEV_SERVER_WATCH; else process.env.SH_DEV_SERVER_WATCH = saved.watch;
  if (saved.manifest === undefined) delete process.env.SH_CORE_LOCAL_MANIFEST; else process.env.SH_CORE_LOCAL_MANIFEST = saved.manifest;
});

/** A dev server from the app's own config, with an embedded local core manifest outside the app root (as the stack's). */
async function devServer(watch: string | undefined): Promise<{ server: ViteDevServer; manifest: string }> {
  const parent = join(APP, '../../.cache/tmp');
  mkdirSync(parent, { recursive: true });
  const scratch = mkdtempSync(join(parent, 'dev-server-watch-'));
  cleanups.push(() => rmSync(scratch, { recursive: true, force: true }));
  mkdirSync(join(scratch, 'run'));
  const manifest = join(scratch, 'run', 'core-v2-manifest-11155111.json');
  writeFileSync(manifest, '{"network":"local"}\n');
  if (watch === undefined) delete process.env.SH_DEV_SERVER_WATCH; else process.env.SH_DEV_SERVER_WATCH = watch;
  process.env.SH_CORE_LOCAL_MANIFEST = manifest;
  const server = await createServer({
    configFile: join(APP, 'vite.config.ts'), root: APP, logLevel: 'silent', clearScreen: false,
    // Keep the dependency optimizer out of the app's own cache; nothing here needs it.
    cacheDir: join(scratch, 'vite'), optimizeDeps: { noDiscovery: true, include: [] },
  });
  cleanups.push(() => server.close());
  // The embedded manifests are read when the deployments module loads (deployments-plugin.ts `addWatchFile`).
  await server.environments.client.transformRequest('virtual:squarehole-deployments');
  return { server, manifest };
}

/** Whether the dev server's watcher holds `file` (chokidar's map: directory to names; empty for no watcher). */
const watches = (server: ViteDevServer, file: string): boolean =>
  Object.entries(server.watcher.getWatched()).some(([dir, names]) => names.includes(basename(file)) && realpathSync(dir) === realpathSync(dirname(file)));

describe('the dev server in E2E runs (SH-RC7 item 30)', () => {
  it('with SH_DEV_SERVER_WATCH=off it watches no file, the embedded local manifest included', async () => {
    const { server, manifest } = await devServer('off');
    expect(server.config.server.watch).toBeNull();
    expect(watches(server, manifest)).toBe(false);
    expect(server.watcher.getWatched()).toEqual({});
  }, shLimit(60_000));

  it('without the variable (the founder’s dev server) it still watches the embedded local manifest', async () => {
    const { server, manifest } = await devServer(undefined);
    expect(server.config.server.watch).not.toBeNull();
    await expect.poll(() => watches(server, manifest), { timeout: 30_000, interval: 100 }).toBe(true);
  }, shLimit(60_000));

  it('refuses any other value rather than guessing', async () => {
    const outcome = await devServer('no').then(() => 'the dev server started', (error: unknown) => String(error));
    expect(outcome).toMatch(/SH_DEV_SERVER_WATCH must be unset, "on" or "off"/);
  }, shLimit(60_000));
});
