import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TRADE_PATTERN } from '../../../production-check';
import { ABOUT_FACTS } from '../../pages/about-facts';
import { PRODUCTION_TERMS } from './terms-production';
import { BOX_LINKS_PRIVACY, PRODUCTION_PRIVACY_NOTICE } from './privacy-production';
import { eligibilityBullet, placeholdersIn, termsTextOf } from './terms-common';
import { TEST_NETWORK_NOTICE } from './test-network';
import { appCopyFraming, unnegatedReturnFraming } from './wording';
import { allPrivacyText } from './privacy';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const notice = TEST_NETWORK_NOTICE;
const everything = [
  ...termsTextOf(notice.gate, notice.document),
  notice.gate.fullTermsLink,
  notice.gate.summaryLabel ?? '',
  notice.gate.reviewAgain,
  notice.link,
  notice.title,
  notice.lede,
  notice.versionLine,
  ...notice.points,
  notice.privacy.title,
  ...notice.privacy.bullets,
  notice.privacy.deviceTitle,
  notice.privacy.device,
  ...allPrivacyText(notice.privacyNotice, []),
];
/** The point that starts with these bold lead words. */
const point = (lead: string): string => notice.points.find((entry) => entry.startsWith(`**${lead}.** `)) ?? '';

/** The test network notice of the Sepolia test site (SH-TA-02, founder 2026-10-23), version 3 for the closed alpha (SH-ALPHA-NOTICE). */
describe('the test network notice', () => {
  it('says what the founder asked for: Sepolia, test tokens with no value, no real money, no outside audit, full Terms before mainnet', () => {
    const text = notice.points.join('\n');
    expect(notice.lede).toBe('This is the Square Hole test site. It runs on the Sepolia test network only.');
    expect(text).toContain('Tokens, ETH and NFTs on Sepolia are test tokens. They have no value.');
    expect(text).toContain('Nothing on this site uses real money.');
    expect(text).toContain('The full Terms of Use come before Square Hole runs on mainnet. Nothing here promises a launch or a date.');
    expect(text).toContain(eligibilityBullet());
  });

  it('keeps the production Terms’ own words for the audit', () => {
    const clause = PRODUCTION_TERMS.document.sections.flatMap((section) => section.clauses).find((entry) => entry.n === '5.3');
    const audit = clause?.items?.find((item) => item.text.startsWith('(c) '))?.text.slice(4);
    expect(audit).toBe('The smart contracts have not been audited by an outside firm. Our own reviews are not audits.');
    expect(notice.points).toContain(`**No outside audit.** ${audit ?? ''}`);
  });

  it('version 4, the closed alpha (F156, F157, F161 (4)): X sign-in, test trades, the launch tax, tETH by claim, no points or prizes, pictures, a contact', () => {
    // Who may use it comes second: the gate's checkbox confirms it, and the gate's window scrolls after about ten points.
    expect(notice.points.map((entry) => /^\*\*([^*]+)\.\*\* /.exec(entry)?.[1])).toEqual([
      'Closed alpha',
      'Who may use it',
      'Test tokens only',
      'Test trades only',
      'Launch tax',
      'tETH',
      'No outside audit',
      'Nothing carries over',
      'Pictures',
      'Full Terms before mainnet',
      'Contact',
    ]);
    expect(point('Who may use it')).toBe(`**Who may use it.** ${eligibilityBullet()}`);
    // F161 (4): X through Privy, the founder's approval (design § 5, notice line 21).
    expect(point('Closed alpha')).toBe('**Closed alpha.** You sign in with X. We let in the X accounts we approve.');
    // Version 2's "No real money" point lives on inside "Test trades only".
    expect(point('Test trades only')).toBe('**Test trades only.** Box pages buy and sell test tokens only. Nothing on this site uses real money.');
    expect(notice.points.some((entry) => entry.startsWith('**No real money.**'))).toBe(false);
    // F161 (4): the faucet opens for the wallet a tester claims with, and both transactions are public (lines 14, 28).
    expect(point('tETH')).toBe('**tETH.** A test token with no value. Its faucet opens for the wallet you claim with. Admitting that wallet, and the starter SepETH we send it from our desk address, are public transactions.');
    // F156 (1): no rewards. The word itself never enters app copy (wording.ts APP_COPY_NEVER), so the point names points and prizes.
    expect(point('Nothing carries over')).toBe('**Nothing carries over.** The alpha gives no points or prizes. Using this site, a test network or a test token gives you no right to any future token, NFT, allocation or airdrop.');
    // F157 (3): only illegal pictures or pictures under a legal notice, on this site; the copies on Arweave stay.
    expect(point('Pictures')).toBe('**Pictures.** We hide a picture on this site only if it is illegal or comes with a legal notice. Its copies on Arweave stay where they are.');
    expect(point('Contact')).toBe('**Contact.** hello@squarehole.fun, for questions, feedback and legal notices.');
  });

  it('states the launch tax with the release’s own figures (about-facts.ts), so a changed table fails here', () => {
    expect(ABOUT_FACTS.window).toBe('6.4 min');
    const minutes = ABOUT_FACTS.window.replace(/ min$/, ' minutes');
    expect(point('Launch tax')).toBe(`**Launch tax.** In a box’s first ${minutes}, a tax takes ${ABOUT_FACTS.taxFirst} of a buy at first, falling to ${ABOUT_FACTS.taxLast}. The box shows the current tax.`);
    expect([ABOUT_FACTS.taxFirst, ABOUT_FACTS.taxLast]).toEqual(['93.2%', '8.1%']);
  });

  it('says what the sign-in with X through Privy shows and keeps, the claim’s link, the made wallet’s key, and no longer claims there is no sign-up or account', () => {
    const data = notice.privacy.bullets;
    // F161 (4), design § 5 "Notice lines that change" (lines 15, 42-44, the two new ones, 48), against what alpha-api keeps.
    expect(data.slice(0, 4)).toEqual([
      'You sign in with X through Privy, a Stripe company. X shows Privy’s name. Privy and our server log sign-ins.',
      'Privy receives your X account’s number, handle, name and picture, your IP address, device and sign-in times, and keeps them in the United States. If Privy makes a wallet for you, it also keeps that wallet’s address with your X account. We get your X number, handle, name, picture and Privy user ID from Privy and keep them with your sign-up and sign-in times, our decision and the wallet you claim with, so each account claims once. We delete them 30 days after the alpha.',
      'To claim, your wallet signs a message that links your X account to that address. Only we keep that link, and Privy too for a wallet it made. The two transactions to it are public.',
      'A wallet Privy makes for you is yours. You and Privy hold its key, and we cannot move its coins. Export the key to keep it after the alpha.',
    ]);
    expect(data).toContain('Privy and X see your IP address when you sign in, and Privy whenever a page uses a wallet it made.');
    expect(everything.join(' ')).not.toMatch(/Cloudflare Access|one-time code|invited address/);
    // What our server keeps is what alpha-api's store holds (infra/server/services/alpha/store.mjs) and deletes (purge.mjs).
    const store = readFileSync(join(ROOT, 'infra/server/services/alpha/store.mjs'), 'utf8');
    for (const column of ['xId TEXT PRIMARY KEY', 'privyDid TEXT NOT NULL', 'handle TEXT NOT NULL', 'name TEXT NOT NULL', 'picture TEXT', 'signedUpAt TEXT NOT NULL', 'CREATE TABLE IF NOT EXISTS signins', 'CREATE TABLE IF NOT EXISTS decisions', 'address TEXT NOT NULL']) expect(store, column).toContain(column);
    expect(readFileSync(join(ROOT, 'infra/server/services/alpha/purge.mjs'), 'utf8')).toContain('now >= ended + 30 * 86400000');
    // The device paragraph's cookie exception (the review's F2) and the sign-in cookie, seven days (alpha/auth.mjs).
    expect(notice.privacy.device).toContain('Our server sets a 7-day sign-in cookie, which your browser sends to it with each page; so does the notice’s cookie, if the browser cannot store your acceptance otherwise.');
    expect(notice.privacy.device).toContain('Our 30-day returning cookie is linked to your X account and sent to our server with each page. It stays after sign-out and lets this browser start sign-in when new sign-ups are closed, but gives no access. Nothing else here is sent to Square Hole.');
    expect(notice.privacy.device).not.toContain('are never sent to Square Hole.');
    const joinPage = readFileSync(join(ROOT, 'apps/web/src/features/alpha-sepolia/join/JoinPage.tsx'), 'utf8');
    expect(joinPage).toContain('<p>{notice.privacy.device}</p>');
    expect(joinPage).not.toContain('A returning-browser cookie lasts 30 days.');
    // The identity token is the one item of Privy's the page sends us (JoinPage.tsx, once per sign-in).
    expect(notice.privacy.device).toContain('Privy keeps its sign-in tokens there, which it sends only to Privy; the page sends us its identity token once, when you sign in.');
    expect(everything.join(' ')).not.toMatch(/do not sign up|no accounts|asks for no name, email address/i);
    // Every other line, checked against the code on 2026-10-28 (docs/evidence/SH-ALPHA-NOTICE.md, "The privacy lines").
    expect(data).toContain('Our own server sees your IP address when the app reads box data from it, and the wallet addresses whose boxes and claims the app shows.');
    expect(data).toContain('The app reads Sepolia through PublicNode and Tenderly. They see your IP address and the addresses the app looks up.');
    expect(data).toContain('Box pictures are published to Arweave through ArDrive Turbo and load from turbo-gateway.com, arweave.net and goldsky.arweave.net, which see your IP address and which picture you asked for.');
    // The signed links and the contact, in the production notice's own words (privacy-production.ts).
    expect(BOX_LINKS_PRIVACY).toContain(`${data.find((line) => line.startsWith('If you made a box')) ?? '?'} They are public`);
    expect(PRODUCTION_PRIVACY_NOTICE.summary.bullets).toContain('If you write to us, we receive your email address and your message.');
    expect(data).toContain('If you write to us, we receive your email address and your message.');
    expect(data).toHaveLength(12);
    expect(notice.privacyNotice.summary.bullets).toBe(data);
  });

  it('holds no open item, no Demo or mock word, no return framing and no trade marker, while the production drafts still hold theirs', () => {
    expect(placeholdersIn(everything)).toEqual([]);
    expect(everything.join(' ')).not.toMatch(/\[(?:COUNSEL|FOUNDER|ENGINEERING)|\bdemo|\bmock|\$1\b|\bdraft\b/i);
    expect(appCopyFraming(everything)).toEqual([]);
    expect(unnegatedReturnFraming(everything)).toEqual([]);
    // F156: the trade rule of `pnpm check:production` refuses these markers outside the lazy trade chunk; the notice is
    // loaded with the gate, at first paint.
    expect(everything.filter((text) => new RegExp(TRADE_PATTERN.source, 'i').test(text))).toEqual([]);
    expect(everything.join(' ')).not.toMatch(/PoolSwapTest|0x[0-9a-f]{8}/i);
    // The drafts the main site needs are still open: the test notice replaces them only on the Sepolia test site.
    expect(placeholdersIn(termsTextOf(PRODUCTION_TERMS.gate, PRODUCTION_TERMS.document)).length).toBeGreaterThan(40);
  });

  it('is short: one card of points, one of data, no sections', () => {
    expect(notice.points).toHaveLength(11);
    for (const entry of notice.points) expect(entry.split(/(?<=[.!?])\s+/).length, entry).toBeLessThanOrEqual(4);
    expect(notice.document.sections).toEqual([]);
    expect(notice.gate.bullets).toBe(notice.points);
    expect(notice.document.readFirst.bullets).toBe(notice.points);
    expect(Object.isFrozen(notice.gate)).toBe(true);
  });

  it('has its own version, which a new text changes (every visitor is asked again), set in the browser suites as well', () => {
    expect(notice.version).toBe('2026-11-20-sepolia-test-6');
    expect(notice.date).toBe('2026-11-20');
    expect(notice.versionLine).toBe('Version 2026-11-20-sepolia-test-6 · 20 November 2026');
    expect(notice.version).not.toBe(PRODUCTION_TERMS.version);
    const state = readFileSync(join(ROOT, 'apps/web/e2e/terms-state.ts'), 'utf8');
    expect(state).toContain(`export const TEST_NETWORK_NOTICE_VERSION = '${notice.version}';`);
  });
});
