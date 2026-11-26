// @vitest-environment node
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { appCopyFraming, unnegatedReturnFraming } from '../legal/wording';
import { ALPHA_SESSION_COOKIE, PRIVY_BROWSER_STORAGE } from './privy-storage';
import { privyAppIdOf, PRIVY_APP_ID, PRIVY_APP_ID_PLACEHOLDER } from './privy-config';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ROOT = resolve(WEB, '../..');

/** The installed SDK's shipped code: react-auth and the core it runs on. */
function sdkText(): string {
  const reactAuth = realpathSync(join(WEB, 'node_modules/@privy-io/react-auth'));
  const esm = join(reactAuth, 'dist/esm');
  const core = readdirSync(join(ROOT, 'node_modules/.pnpm')).filter((name) => name.startsWith('@privy-io+js-sdk-core@'));
  return [
    ...readdirSync(esm).filter((name) => name.endsWith('.mjs')).map((name) => readFileSync(join(esm, name), 'utf8')),
    ...core.map((name) => readFileSync(join(ROOT, 'node_modules/.pnpm', name, 'node_modules/@privy-io/js-sdk-core/dist/esm/index.mjs'), 'utf8')),
  ].join('\n');
}

/**
 * F161 (4), SH-ALPHA-SITE: the alpha's items in the browser, which `STORED_ON_DEVICE` lists in Sepolia trade builds:
 * our server's sign-in cookie and Privy's own items, each by the name its writer uses.
 */
describe('what the alpha’s sign-in keeps in the browser (F161 (4), SH-ALPHA-SITE)', () => {
  it('our server’s cookie, by the name alpha/auth.mjs sets, HttpOnly for seven days', async () => {
    const auth = await import(/* @vite-ignore */ join(ROOT, 'infra/server/services/alpha/auth.mjs')) as { COOKIE: string; SESSION_MS: number };
    expect(ALPHA_SESSION_COOKIE.key).toBe(auth.COOKIE);
    expect(auth.SESSION_MS).toBe(7 * 86_400_000);
    expect(ALPHA_SESSION_COOKIE.writer).toBe('server');
    expect(readFileSync(join(ROOT, ALPHA_SESSION_COOKIE.source), 'utf8')).toContain(`'${ALPHA_SESSION_COOKIE.key}'`);
    expect(readFileSync(join(ROOT, 'infra/server/services/alpha/auth.mjs'), 'utf8')).toContain('Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=');
    expect(ALPHA_SESSION_COOKIE.what).toContain('seven days');
  });

  it('Privy’s items, each a storage name the installed SDK writes, listed once', () => {
    const sdk = sdkText();
    for (const item of PRIVY_BROWSER_STORAGE) {
      // A fixed name is a string in the SDK; one with a part that varies (`<…>`) is a template with a slot there.
      const parts = item.key.split(/<[^>]+>/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const pattern = parts.length === 1 ? `["\`']${parts[0] ?? ''}["\`']` : `\`${parts.join('\\$\\{[^}]+\\}')}\``;
      expect(sdk, item.key).toMatch(new RegExp(pattern));
      expect(item.writer).toBe('privy');
      expect(readFileSync(join(ROOT, item.source), 'utf8')).toContain(`'${item.key}'`);
    }
    expect(new Set(PRIVY_BROWSER_STORAGE.map((item) => `${item.store}:${item.key}`)).size).toBe(PRIVY_BROWSER_STORAGE.length);
    // Privy's cookie copies of its tokens are off (privy-live.tsx; its provider honours that with build/privy-fixes.ts,
    // privy-fixes.test.ts), so none is listed.
    expect(PRIVY_BROWSER_STORAGE.filter((item) => item.store === 'cookie')).toEqual([]);
    expect(readFileSync(join(WEB, 'src/features/trade-sepolia/privy-live.tsx'), 'utf8')).toContain("sessions: { cookieWriteBehavior: 'never' }");
    expect(readFileSync(join(WEB, 'vite.config.ts'), 'utf8')).toContain('[privyTrims(), privyFixes()]');
    expect(readFileSync(join(WEB, 'build/alpha-pages.ts'), 'utf8')).toContain('[privyTrims(), privyFixes(), react()');
  });

  it('say what they hold in plain words, under the app’s wording rule, naming no host of Privy’s', () => {
    const texts = [ALPHA_SESSION_COOKIE, ...PRIVY_BROWSER_STORAGE].map((item) => item.what);
    expect(unnegatedReturnFraming(texts)).toEqual([]);
    expect(appCopyFraming(texts)).toEqual([]);
    for (const text of texts) expect(text).not.toMatch(/auth\.privy\.io|privy\.systems/);
  });
});

describe('the Privy app ID (F161 (4), SH-ALPHA-SITE)', () => {
  it('is the founder’s production app (XR-ALPHA-SITE af1), and the page still treats the placeholder, or an ID of another form, as none', () => {
    expect(PRIVY_APP_ID).toBe('cmvtgx1tx019q0il8tg89ebfz');
    // PrivyProvider refuses any app ID that is not 25 characters long (@privy-io/react-auth 3.51.0).
    expect(PRIVY_APP_ID).toHaveLength(25);
    expect(privyAppIdOf()).toBe(PRIVY_APP_ID);
    expect(privyAppIdOf(PRIVY_APP_ID_PLACEHOLDER)).toBeNull();
    expect(privyAppIdOf('cm1abcdefghijklmnopqrstu')).toBe('cm1abcdefghijklmnopqrstu');
    for (const bad of ['', 'short', 'CM1ABCDEFGHIJKLMNOPQRSTU', 'cm1abc def ghijklmnopqrst', 'cm1abcdefghijklmnopqrstu-secret']) expect(privyAppIdOf(bad), bad).toBeNull();
  });
});

describe('SH-275: the BNB Chain testnet site’s own Privy app', () => {
  it('a BNB build takes its own app, never Sepolia’s; the placeholder path stays', async () => {
    vi.stubEnv('SH_TESTNET', 'bnb');
    vi.resetModules();
    try {
      const config = await import('./privy-config');
      expect(config.PRIVY_APP_ID).toBe('cmwwb2y9p00gv0gl9m9im0uve');
      expect(config.PRIVY_APP_ID).toBe(config.BNB_PRIVY_APP_ID);
      expect(config.PRIVY_APP_ID).not.toBe(PRIVY_APP_ID);
      expect(config.PRIVY_APP_ID).toHaveLength(25);
      expect(config.privyAppIdOf()).toBe('cmwwb2y9p00gv0gl9m9im0uve');
      expect(config.privyAppIdOf(config.PRIVY_APP_ID_PLACEHOLDER)).toBeNull();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

