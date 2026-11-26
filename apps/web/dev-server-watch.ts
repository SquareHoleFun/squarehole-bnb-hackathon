/**
 * `SH_DEV_SERVER_WATCH` (SH-RC7 open item 30): whether the dev server watches files.
 * - unset or `on`: Vite's watcher, as `pnpm dev` and the founder's `pnpm dev:core-v2-local` always had (live reload).
 * - `off`: no watcher at all (Vite's `server.watch: null`). No file event can then update, reload or restart anything
 *   the dev server serves, the embedded deployment manifests included (deployments-plugin.ts). The core v2 chain suite
 *   (`scripts/dev-core-v2-local.mjs --e2e`) and the examples' stack set it: a late file event for the stack's own
 *   manifest made the dev server push an update of the deployments module and its importers while a box page loaded,
 *   and the page took a second, provider-less data-source module (SH-V21-RC6-INT RR.3, P5.5). The examples read the
 *   page's draft through the dev server's /src/ modules, so those stacks keep the dev server rather than a build.
 * Anything else is refused, as `SH_BUILD` is: a typo must not silently leave the watcher on.
 */
type Env = Readonly<Record<string, string | undefined>>;

export function devServerWatch(env: Env): { readonly watch?: null } {
  const value = env.SH_DEV_SERVER_WATCH?.trim() ?? '';
  if (value === '' || value === 'on') return {};
  if (value === 'off') return { watch: null };
  throw new Error(`SH_DEV_SERVER_WATCH must be unset, "on" or "off" (got "${value}")`);
}
