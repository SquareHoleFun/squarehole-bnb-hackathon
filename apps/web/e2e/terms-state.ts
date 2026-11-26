/**
 * The entry terms gate (F19) in the browser suites.
 *
 * Every spec starts as a visitor who has accepted the current Terms (`use.storageState` in both Playwright configs),
 * so the existing specs see the app exactly as before. The acceptance is a first-party cookie rather than
 * localStorage because the locked M1 acceptance spec `feed-pin` makes localStorage throw and still expects the feed;
 * the app reads the cookie as its fallback record. A host-only cookie for 127.0.0.1 is sent to every port, so the
 * same state serves the preview (5392) and the chain app (5393). `terms-gate.spec.ts` opts out with NO_TERMS_ACCEPTANCE.
 *
 * e2e never imports src: TERMS_VERSION must equal apps/web/src/features/legal/terms.ts. terms-gate.spec checks the
 * version the app shows, so a new version fails loudly there (and everywhere else, since the gate then appears).
 */
export const TERMS_VERSION = '2026-10-11-draft-7';
export const TERMS_KEY = 'squarehole.terms';

const ACCEPTED_RECORD = encodeURIComponent(JSON.stringify({ version: TERMS_VERSION, acceptedAt: '2026-09-30T00:00:00.000Z' }));

export const TERMS_ACCEPTED = {
  cookies: [
    { name: TERMS_KEY, value: ACCEPTED_RECORD, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' as const },
  ],
  origins: [],
};

export const NO_TERMS_ACCEPTANCE = { cookies: [], origins: [] };

/**
 * The production build's Terms (SH-V2-FE7, apps/web/src/features/legal/terms-production.ts) carry their own version, so
 * the production smoke test (e2e/production, playwright.production.config.ts) starts accepted with this one.
 * terms-production.test.ts checks that it equals the app's.
 */
export const PRODUCTION_TERMS_VERSION = '2026-10-15-production-draft-4';
/** The date the production Terms show beside that version ("Draft of …"); terms-production.test.ts checks it too. */
export const PRODUCTION_TERMS_DATE_TEXT = '15 October 2026';

const PRODUCTION_ACCEPTED_RECORD = encodeURIComponent(JSON.stringify({ version: PRODUCTION_TERMS_VERSION, acceptedAt: '2026-10-11T00:00:00.000Z' }));

export const PRODUCTION_TERMS_ACCEPTED = {
  cookies: [
    { name: TERMS_KEY, value: PRODUCTION_ACCEPTED_RECORD, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' as const },
  ],
  origins: [],
};

/**
 * The Sepolia test site's build (SH-TA-02, `SH_TARGET=sepolia`) asks visitors to accept the test network notice
 * (apps/web/src/features/legal/test-network.ts) under its own version; the production smoke test starts accepted with
 * it when it runs against that target. test-network.test.ts checks that it equals the app's.
 */
export const TEST_NETWORK_NOTICE_VERSION = '2026-11-20-sepolia-test-6';

const TEST_NETWORK_ACCEPTED_RECORD = encodeURIComponent(JSON.stringify({ version: TEST_NETWORK_NOTICE_VERSION, acceptedAt: '2026-10-23T00:00:00.000Z' }));

export const TEST_NETWORK_NOTICE_ACCEPTED = {
  cookies: [
    { name: TERMS_KEY, value: TEST_NETWORK_ACCEPTED_RECORD, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' as const },
  ],
  origins: [],
};
