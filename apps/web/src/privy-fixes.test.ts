// @vitest-environment node
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PRIVY_FIXES, applyPrivyFixes, privyFixes } from '../build/privy-fixes';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROVIDER = join(realpathSync(join(WEB, 'node_modules/@privy-io/react-auth')), 'dist/esm/index-CaWn8tEz.mjs');

type Hooks = { buildStart(): void; transform(code: string, id: string): { code: string } | null; buildEnd(this: { error(message: string): never }, error?: Error): void };

/**
 * F161 (4), SH-ALPHA-SITE: the build's one fix to Privy's React SDK 3.51.0 (build/privy-fixes.ts): its provider hands
 * the session's client the config it was given, so `sessions.cookieWriteBehavior: 'never'` (privy-live.tsx) holds and
 * no token of Privy's is copied into a cookie of this site. The alpha-access suite's run of the real SDK shows the
 * cookies gone (e2e/alpha-access/privy-sdk.spec.mjs).
 */
describe('Privy’s provider fix (F161 (4), SH-ALPHA-SITE)', () => {
  it('mends the installed 3.51.0 provider at its one place: the client gets the config, the core client its sessions', () => {
    const installed = readFileSync(PROVIDER, 'utf8');
    expect(JSON.parse(readFileSync(join(PROVIDER, '../../../package.json'), 'utf8')).version).toBe('3.51.0');
    const fixed = applyPrivyFixes(installed);
    for (const { find, replace } of PRIVY_FIXES) {
      expect(fixed.split(replace).length - 1).toBe(1);
      expect(fixed.includes(find)).toBe(false);
    }
    // The provider takes config off the props it hands that client: the reason for the fix.
    expect(installed).toContain('Un=({config:t,...r})=>');
    expect(installed).toContain('function(e){if("string"!=typeof e||25!==e.length)');
    expect(fixed.length - installed.length).toBe(PRIVY_FIXES.reduce((sum, { find, replace }) => sum + replace.length - find.length, 0));
  });

  it('refuses a provider without the text, or with it twice', () => {
    const { find } = PRIVY_FIXES[0] ?? { find: '' };
    expect(() => applyPrivyFixes('no such text')).toThrow('0 times');
    expect(() => applyPrivyFixes(`${find};${find}`)).toThrow('2 times');
  });

  it('as a plugin: mends the provider file only, and fails a build with Privy’s React SDK but not that file', () => {
    const plugin = privyFixes() as unknown as Hooks;
    const fail = { error(message: string): never { throw new Error(message); } };
    plugin.buildStart();
    expect(plugin.transform('export {}', '/repo/apps/web/src/main.tsx')).toBeNull();
    expect(plugin.transform('export {}', '/repo/node_modules/@privy-io/react-auth/dist/esm/useWallets-x.mjs')).toBeNull();
    expect(() => plugin.buildEnd.call(fail)).toThrow('not the 3.51.0 provider file');
    plugin.buildStart();
    expect(plugin.transform(readFileSync(PROVIDER, 'utf8'), `${PROVIDER}?v=1`)?.code).toContain('K({...r,config:t})');
    expect(() => plugin.buildEnd.call(fail)).not.toThrow();
    plugin.buildStart();
    expect(() => plugin.buildEnd.call(fail)).not.toThrow();
  });
});
