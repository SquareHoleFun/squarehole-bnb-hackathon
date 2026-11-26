/**
 * F161 (4), SH-ALPHA-SITE: the join page with Privy's real SDK (@privy-io/react-auth 3.51.0 through privy-live.tsx, on
 * the probe page the suite's edge serves at /__probe/ with the release's headers), and Privy's service and X stood in
 * at the network: every request to auth.privy.io is answered here in the shapes of Privy's own API types
 * (@privy-io/api-types), its wallet frame answers only its ready check, and X's authorize page sends the browser back
 * as X and Privy do. Our server is the suite's real alpha-api, so the identity token the SDK hands the page must pass
 * alpha-api's own check. The run records what the SDK keeps in this site's storage at each step
 * (docs/design/alpha-access-privy.md § 5, "Storage": "read from a real run") and holds STORED_ON_DEVICE to it.
 * Nothing reaches Privy, X or any other host: each such request is aborted and recorded.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { PRIVY_BROWSER_STORAGE } from '../../src/features/alpha-sepolia/privy-storage.ts';
import { TESTERS, alphaContext, sessionCookie } from './helpers.mjs';

const APP_ID = 'standinappid0000000000000';
const PRIVY = 'https://auth.privy.io';
const seconds = () => Math.floor(Date.now() / 1000);
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
/** A token in a JWT's shape (Privy's SDK reads its claims; only alpha-api checks a signature, the identity token's). */
const unsignedJwt = (payload) => `${b64({ alg: 'ES256', typ: 'JWT' })}.${b64(payload)}.${randomBytes(64).toString('base64url')}`;

/** Privy's app settings as its dashboard would serve them for the alpha's app (AppResponse, @privy-io/api-types). */
const APP = {
  id: APP_ID, name: 'Square Hole alpha', accent_color: null, allowed_domains: [], allowed_native_app_ids: [], allowed_native_app_url_schemes: [],
  allowlist_config: { cta_link: null, cta_text: null, error_detail: null, error_title: null }, allowlist_enabled: false,
  apple_oauth: false, captcha_enabled: false, custom_api_url: null, custom_jwt_auth: false, custom_oauth_providers: [], data_classification: 'public',
  disable_plus_emails: false, discord_oauth: false, email_auth: false,
  embedded_wallet_config: { create_on_login: 'off', ethereum: { create_on_login: 'off' }, solana: { create_on_login: 'off' }, user_owned_recovery_options: ['user-passcode'], mode: 'user-controlled-server-wallets-only' },
  enabled_captcha_provider: null, enforce_wallet_uis: false, external_wallets_for_signup_enabled: false, farcaster_auth: false, farcaster_link_wallets_enabled: false,
  fiat_on_ramp_enabled: false, github_oauth: false, google_oauth: false, guest_auth: false, icon_url: null, instagram_oauth: false, legacy_wallet_ui_config: false,
  legal_name: null, line_oauth: false, linkedin_oauth: false, logo_url: null, max_linked_wallets_per_user: null, merge_accounts_by_email: false, mfa_methods: [],
  passkey_auth: false, passkeys_for_signup_enabled: false, privacy_policy_url: null, require_users_accept_terms: false, show_wallet_login_first: false,
  smart_wallet_config: { enabled: false }, sms_auth: false, solana_wallet_auth: false, spotify_oauth: false, telegram_auth: false, telegram_oauth: false,
  terms_and_conditions_url: null, theme: 'dark', tiktok_oauth: false, twitch_oauth: false, twitter_oauth: true, twitter_oauth_on_mobile_enabled: true,
  verification_key: '-----BEGIN PUBLIC KEY-----\\nstand-in\\n-----END PUBLIC KEY-----', wallet_auth: false, wallet_connect_cloud_project_id: null, whatsapp_enabled: false,
};

/** The wallet frame (`/apps/<id>/embedded-wallets`): it answers the SDK's ready check, and refuses the rest. */
const FRAME = `<!doctype html><html><body><script>
addEventListener('message', (event) => {
  const message = event.data;
  if (!message || typeof message.event !== 'string' || !event.source) return;
  if (message.event === 'privy:iframe:ready') event.source.postMessage({ id: message.id, event: message.event, data: {} }, event.origin);
  else event.source.postMessage({ id: message.id, event: message.event, error: { type: 'unsupported', message: 'the suite stands in for sign-in only' } }, event.origin);
});
</script></body></html>`;

/** A listed key as a pattern: its `<…>` parts stand for whatever the SDK puts there. */
const listed = (key) => new RegExp(`^${key.split(/<[^>]+>/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^:]+')}$`);
/** Privy's own items in a step's storage, as `store:key` (ours never start with `privy`). */
const privyItems = (step) => [
  ...step.localStorage.filter((key) => key.startsWith('privy')).map((key) => `localStorage:${key}`),
  ...step.sessionStorage.filter((key) => key.startsWith('privy')).map((key) => `sessionStorage:${key}`),
  ...step.cookie.filter((key) => key.startsWith('privy')).map((key) => `cookie:${key}`),
  ...step.indexedDB.map((name) => `indexedDB:${name}`),
];

/** What this site's storage holds now: each key by its store (our own items and Privy's alike). */
const storageOf = (page) => page.evaluate(async () => ({
  localStorage: Object.keys(window.localStorage).sort(),
  sessionStorage: Object.keys(window.sessionStorage).sort(),
  cookie: document.cookie.split(';').map((part) => part.trim().split('=')[0]).filter(Boolean).sort(),
  indexedDB: ((await indexedDB.databases?.()) ?? []).map((database) => database.name).sort(),
}));

test('sign in with X through Privy’s real SDK: X and back, the identity token alpha-api accepts, our cookie, You’re on the list; and what the SDK keeps here', async ({ page }, testInfo) => {
  const { baseURL, escaped, problems } = await alphaContext(page, testInfo, TESTERS.ada);
  const origin = new URL(baseURL).origin;
  const tester = TESTERS.ada;
  const asked = [];
  const steps = {};
  let init = null;
  const user = {
    id: 'did:privy:cmprobe00000000000000000', created_at: seconds(), has_accepted_terms: false, is_guest: false, mfa_methods: [],
    linked_accounts: [{ type: 'twitter_oauth', subject: tester.xId, username: tester.handle, name: tester.name, profile_picture_url: tester.picture, verified_at: seconds(), first_verified_at: seconds(), latest_verified_at: seconds() }],
  };
  /** The identity token Privy's service would sign: the edge signs it with the key its alpha-api checks. */
  const identityToken = async () => (await (await page.request.post('/__edge/identity-token', { data: tester })).json()).token;
  /** AuthenticatedUser (@privy-io/api-types): Privy's tokens for this user. */
  const tokens = async () => {
    const claims = { sid: 'cmsession0000000000000000', iss: 'privy.io', aud: APP_ID, sub: user.id, iat: seconds(), exp: seconds() + 3600 };
    return { token: unsignedJwt(claims), privy_access_token: unsignedJwt(claims), refresh_token: randomBytes(24).toString('hex'), identity_token: await identityToken(), session_update_action: 'set', user };
  };
  const cors = { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' };
  const json = (body, status = 200) => ({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });

  await page.route(`${PRIVY}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    asked.push(`${request.method()} ${url.pathname}`);
    if (request.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS', 'access-control-allow-headers': request.headers()['access-control-request-headers'] ?? '*', 'access-control-max-age': '600' } });
    }
    if (url.pathname === `/apps/${APP_ID}/embedded-wallets`) return route.fulfill({ status: 200, contentType: 'text/html', body: FRAME });
    if (request.method() === 'GET' && url.pathname === `/api/v1/apps/${APP_ID}`) return route.fulfill(json(APP));
    if (url.pathname === '/api/v1/analytics_events') return route.fulfill(json({}));
    if (url.pathname === '/api/v1/oauth/init') {
      init = request.postDataJSON();
      // The SDK keeps its one-time values before it asks: what this site holds during an X trip.
      steps.duringSignIn = await storageOf(page);
      return route.fulfill(json({ url: `https://x.com/i/oauth2/authorize?response_type=code&client_id=privy&state=${encodeURIComponent(init.state_code ?? '')}` }));
    }
    if (url.pathname === '/api/v1/oauth/authenticate') {
      const body = request.postDataJSON();
      expect(body).toMatchObject({ authorization_code: 'x-code', state_code: init?.state_code });
      return route.fulfill(json({ ...(await tokens()), is_new_user: true }));
    }
    // RefreshSession and RefreshUser (@privy-io/routes): a renewed session, and the user with a fresh identity token.
    if (request.method() === 'POST' && url.pathname === '/api/v1/sessions') return route.fulfill(json(await tokens()));
    if (request.method() === 'GET' && url.pathname === '/api/v1/users/me') return route.fulfill(json({ user, identity_token: await identityToken() }));
    if (url.pathname === '/api/v1/sessions/logout') return route.fulfill(json({}));
    return route.fulfill(json({ error: 'the suite does not stand in for this' }, 404));
  });
  // X's authorize page: X sends the browser back to Privy, which sends it back to the page with its three parameters.
  await page.route('https://x.com/**', (route) => {
    const back = new URL(init?.redirect_to ?? `${origin}/__probe/`);
    back.searchParams.set('privy_oauth_code', 'x-code');
    back.searchParams.set('privy_oauth_state', init?.state_code ?? '');
    back.searchParams.set('privy_oauth_provider', 'twitter');
    return route.fulfill({ status: 302, headers: { location: back.href } });
  });

  await page.goto('/__probe/');
  await expect(page.getByRole('heading', { level: 1, name: 'Square Hole alpha' })).toBeVisible();
  steps.beforeSignIn = await storageOf(page);
  // Nothing of Privy's before the press: no request to its service.
  expect(asked).toEqual([]);

  await page.getByRole('checkbox').check();
  // Within seconds: the sign-in waits for nothing of Privy's wallet frame (privy-live.tsx `ready`).
  const session = page.waitForResponse((response) => new URL(response.url()).pathname === '/alpha/session', { timeout: 20_000 });
  await page.getByRole('button', { name: 'Sign in with X' }).click();
  const answer = await session;
  expect(answer.status()).toBe(200);
  await expect(page.locator('.sh-join__big')).toHaveText('You’re on the list.');
  await expect(page.locator('.sh-join__handle')).toHaveText('@ada_builds');
  expect(init).toMatchObject({ provider: 'twitter' });
  expect(await sessionCookie(page)).toMatchObject({ httpOnly: true, secure: true });
  steps.signedIn = await storageOf(page);
  steps.signedInCookies = (await page.context().cookies()).map((cookie) => cookie.name).sort();

  // SH-179: the export press asks whether Privy made a wallet. Privy's own "wallets ready" never comes with the alpha's
  // config (no external-wallet connector starts, so the SDK never sets it), and ship 12 waited for it: a minute, then
  // "Export did not open". Privy's account record answers at once.
  const pressed = Date.now();
  await page.getByRole('button', { name: 'Export wallet key' }).click();
  await expect(page.getByText('Privy made no wallet for this X account.')).toBeVisible({ timeout: 10_000 });
  expect(Date.now() - pressed).toBeLessThan(10_000);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('Signed out.')).toBeVisible();
  expect(asked).toContain('POST /api/v1/sessions/logout');
  steps.signedOut = await storageOf(page);

  const record = { sdk: '@privy-io/react-auth 3.51.0', fix: 'build/privy-fixes.ts', asked, steps };
  const file = process.env.SH_EVIDENCE_SCREENSHOTS === '1'
    ? join(dirname(fileURLToPath(import.meta.url)), `../../../../docs/evidence/SH-ALPHA-SITE/privy-storage-${testInfo.project.name}.json`)
    : testInfo.outputPath('privy-storage.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  // No cookie of Privy's on this site at any step (privy-live.tsx `cookieWriteBehavior: 'never'`, build/privy-fixes.ts),
  // nor in the browser's own jar.
  for (const step of [steps.beforeSignIn, steps.duringSignIn, steps.signedIn, steps.signedOut]) expect(step.cookie.filter((name) => name.startsWith('privy'))).toEqual([]);
  expect(steps.signedInCookies.filter((name) => name.startsWith('privy'))).toEqual([]);
  // Every item of Privy's the run found is in STORED_ON_DEVICE, in its own store; nothing of Privy's before the press.
  expect(privyItems(steps.beforeSignIn)).toEqual([]);
  const found = [...new Set([steps.duringSignIn, steps.signedIn, steps.signedOut].flatMap(privyItems))].sort();
  const unlisted = found.filter((item) => !PRIVY_BROWSER_STORAGE.some(({ store, key }) => item.startsWith(`${store}:`) && listed(key).test(item.slice(store.length + 1))));
  expect(unlisted).toEqual([]);
  // Listed but not seen: only the wallets' list, which Privy writes once its wallet frame reports the wallets.
  const unseen = PRIVY_BROWSER_STORAGE.filter(({ store, key }) => !found.some((item) => item.startsWith(`${store}:`) && listed(key).test(item.slice(store.length + 1)))).map(({ key }) => key);
  expect(unseen).toEqual(['privy:connections']);
  // Sign-out takes Privy's tokens; its two markers stay (as the list says).
  expect(privyItems(steps.signedOut).map((item) => item.replace(APP_ID, '<app ID>').replace(/:\d+$/, ':<number>')).sort()).toEqual(['localStorage:privy:sent:<app ID>:<number>', 'localStorage:privy:<app ID>:recent-login-method'].sort());
  expect(escaped.filter((host) => /privy|x\.com|twitter/.test(host))).toEqual([]);
  // The one thing the release's CSP refuses: Privy's SDK asks WalletConnect's wallet list after sign-in although its
  // external wallets are off (the design leaves WalletConnect's origins out of connect-src); it logs the refusal and
  // goes on. Anything else refused, or any uncaught error, fails here.
  expect(problems.filter((text) => !text.includes('https://explorer-api.walletconnect.com/'))).toEqual([]);
});
