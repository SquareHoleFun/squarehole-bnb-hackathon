import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PRIVACY_NOTICE, STORED_ON_DEVICE, allPrivacyText, alphaStoredOnDevice } from './privacy';
import { BOX_LINKS_PRIVACY, PRODUCTION_PRIVACY_NOTICE } from './privacy-production';
import { TERMS_ACCEPTANCE_KEY, TERMS_COOKIE_NAME } from './terms-acceptance';
import { appCopyFraming, unnegatedReturnFraming } from './wording';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const SCANNED = ['apps/web/src', ...readdirSync(join(ROOT, 'packages')).map((name) => `packages/${name}/src`)];
const NOT_SHIPPED = /\.test\.(?:tsx?|mjs)$|\/(test-support|integration|tools|e2e)\//;
/** A call into browser storage (comments are removed first, so a mention in prose does not count). */
const STORAGE_USE = /\b(?:window|globalThis|self)\.(?:localStorage|sessionStorage|indexedDB)\b|\bdocument\.cookie\b/;

function sourceFiles(dir: string, extension = /\.tsx?$/): string[] {
  const absolute = join(ROOT, dir);
  try {
    statSync(absolute);
  } catch {
    return [];
  }
  return readdirSync(absolute, { recursive: true, encoding: 'utf8' })
    .map((name) => join(absolute, name))
    .filter((path) => extension.test(path) && statSync(path).isFile())
    .map((path) => relative(ROOT, path))
    .filter((path) => !NOT_SHIPPED.test(path));
}

const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('privacy notice (Fable review S1 / R-25)', () => {
  it('lists every browser-storage item the shipped code writes, with its key in the file that writes it', () => {
    const users = SCANNED.flatMap((dir) => sourceFiles(dir)).filter((path) => STORAGE_USE.test(withoutComments(readFileSync(join(ROOT, path), 'utf8'))));
    expect(users.length).toBeGreaterThan(5);
    // The Sepolia alpha's items are listed in its builds only (F161 (4), F166), and this build holds no alpha code: the
    // app's own among them (not our server's cookie, nor Privy's items) count here as well.
    const alpha = alphaStoredOnDevice();
    const listed = [...STORED_ON_DEVICE, ...alpha.filter((item) => item.writer === undefined)];
    expect(new Set(users)).toEqual(new Set(listed.map((item) => item.source)));
    for (const item of [...STORED_ON_DEVICE, ...alpha]) {
      expect(readFileSync(join(ROOT, item.source), 'utf8'), `${item.key} in ${item.source}`).toContain(`'${item.key}'`);
    }
    expect(STORED_ON_DEVICE.filter((item) => alpha.some((own) => own.key === item.key))).toEqual([]);
    expect(alpha.map((item) => item.key)).toContain('sh.alpha.setup.v1');
    expect(STORED_ON_DEVICE.filter((item) => item.key === TERMS_ACCEPTANCE_KEY).map((item) => item.store)).toEqual(['localStorage', 'cookie']);
    expect(TERMS_COOKIE_NAME).toBe(TERMS_ACCEPTANCE_KEY);
    expect(new Set(STORED_ON_DEVICE.map((item) => `${item.store}:${item.key}`)).size).toBe(STORED_ON_DEVICE.length);
  });

  it('lists every server host-cookie name found in source', () => {
    const sources = sourceFiles('infra/server/services', /\.mjs$/).map((path) => ({
      path, code: withoutComments(readFileSync(join(ROOT, path), 'utf8')),
    }));
    // Discover names independently of the inventory, so an omitted server cookie fails too.
    const cookies = sources.flatMap(({ path, code }) => [...code.matchAll(/(['"])(__Host-[\w-]+)\1/g)]
      .map((match) => ({ key: match[2], source: path })));
    const listed = alphaStoredOnDevice().filter((item) => item.writer === 'server');
    expect(cookies.length).toBeGreaterThan(0);
    expect(new Set(listed.map((item) => `${item.source}:${item.key}`)))
      .toEqual(new Set(cookies.map((item) => `${item.source}:${item.key}`)));
    for (const item of listed) expect(item.store).toBe('cookie');
    expect(listed.find((item) => item.key === '__Host-alpha_returning')?.what).toBe(
      'For 30 days: a marker linked to your X account, sent to our server with each page. It stays after sign-out and lets this browser start sign-in when new sign-ups are closed, but gives no access.',
    );
  });

  it('inventories every storage-key literal, including extra keys in an existing writer', () => {
    const listed = [...STORED_ON_DEVICE, ...alphaStoredOnDevice().filter((item) => item.writer === undefined)];
    const users = SCANNED.flatMap((dir) => sourceFiles(dir)).filter((path) => STORAGE_USE.test(withoutComments(readFileSync(join(ROOT, path), 'utf8'))));
    // These keys are only read and removed during migration; they are never written.
    const retired = new Set(['sh.create.draft.v1', 'sh.create.art.v1', 'sh.create.cover.v1']);
    for (const path of users) {
      const source = withoutComments(readFileSync(join(ROOT, path), 'utf8'));
      const keys = [...source.matchAll(/['"]((?:sh\.|squarehole[.-])[a-zA-Z0-9.-]+)['"]/g)].map((match) => match[1]).filter((key): key is string => key !== undefined && !retired.has(key));
      expect(new Set(keys), path).toEqual(new Set(listed.filter((item) => item.source === path).map((item) => item.key)));
    }
    expect(STORED_ON_DEVICE.find((item) => item.key === 'sh.create.art.v2')?.what).toContain('secret salts');
  });

  it('says there are no accounts, what stays local, that addresses are public and that the host sees IP addresses', () => {
    const summary = PRIVACY_NOTICE.summary.bullets.join(' ');
    expect(summary).toContain('Square Hole has no accounts');
    expect(summary).toContain('The app keeps your choices on your device only, and sends none of them to us, except links you sign for a box you made.');
    expect(summary).toContain('Wallet addresses and transactions are public on the blockchain');
    expect(summary).toContain('Our host sees your IP address with every page request');
    expect(summary).toContain('The app contains no analytics, advertising or tracking code.');
    expect(PRIVACY_NOTICE.sections.map((section) => section.id)).toEqual(['privacy-device', 'privacy-others', 'privacy-wallets', 'privacy-contact']);
  });

  it('follows the wording rule and uses only balanced marks and closed placeholders', () => {
    expect(unnegatedReturnFraming(allPrivacyText())).toEqual([]);
    expect(appCopyFraming(allPrivacyText())).toEqual([]);
    for (const text of allPrivacyText()) {
      expect(text.split('**').length % 2, text).toBe(1);
      expect((text.match(/\[/g) ?? []).length, text).toBe((text.match(/\]/g) ?? []).length);
    }
    expect(allPrivacyText().join(' ')).toContain('[COUNSEL: legal entity, once formed');
  });

  // LINKS-WEB 9 (docs/design/box-links-v2.md § 5 "Privacy"): the design's lines, word for word, in both notices. They
  // are wording for the founder and counsel to review (docs/evidence/SH-LINKS-WEB.md).
  it('says what a creator’s signed box links send and keep, in the development and the production notice', () => {
    const line = '**Box links.** If you made a box and sign its links, your browser sends the links and your signature to our server, which keeps them and shows them with the box. They are public and tied to your address. Sign empty links to remove them; our backups keep older versions for up to 7 days.';
    expect(BOX_LINKS_PRIVACY).toBe(line);
    for (const notice of [PRIVACY_NOTICE, PRODUCTION_PRIVACY_NOTICE]) {
      expect(notice.summary.bullets).toContain('The app keeps your choices on your device only, and sends none of them to us, except links you sign for a box you made.');
      expect(notice.summary.bullets.join(' ')).not.toContain('sends none of them to us.');
      expect(notice.sections.find((section) => section.id === 'privacy-others')?.bullets).toContain(line);
      expect(unnegatedReturnFraming(allPrivacyText(notice))).toEqual([]);
      expect(appCopyFraming(allPrivacyText(notice))).toEqual([]);
      // No trust label for links, here either (F149).
      expect(allPrivacyText(notice).join(' ')).not.toMatch(/\b(verified|trusted|official)\b/i);
    }
  });

  it('is frozen all the way down', () => {
    expect(Object.isFrozen(PRIVACY_NOTICE)).toBe(true);
    expect(Object.isFrozen(PRIVACY_NOTICE.sections[1]?.bullets)).toBe(true);
    expect(Object.isFrozen(STORED_ON_DEVICE)).toBe(true);
    expect(Object.isFrozen(STORED_ON_DEVICE[0])).toBe(true);
  });
});
