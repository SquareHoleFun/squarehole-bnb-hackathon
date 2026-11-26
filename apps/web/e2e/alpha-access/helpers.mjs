/**
 * F161 (4), SH-ALPHA-SITE: the alpha-access suite's testers, wallets and evidence (playwright.alpha-access.config.ts).
 * Each test gets its own alpha-api state on the edge (the `edge_tenant` cookie, from its title and project, so the
 * desktop and phone runs never meet) and names the X account the stand-in signs in (`standin_x`). The browser wallet
 * is one EIP-6963 provider whose key lives in this process: it answers the account and the chain and signs a message
 * only for its own address; it sends nothing. Every request leaving the machine is aborted and recorded, and so is
 * every refusal of the release's CSP and every uncaught page error.
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { privateKeyToAccount } from 'viem/accounts';

export const SITE_ORIGIN = 'https://test-app.squarehole.fun';
export const SEPOLIA = 11155111;
/** The testers the suite signs in (each test has its own state, so the same ones serve every test). */
export const TESTERS = Object.freeze({
  ada: Object.freeze({ xId: '1849302217654321001', handle: 'ada_builds', name: 'Ada Builder', picture: 'https://pbs.twimg.com/profile_images/1/ada_normal.png' }),
  bo: Object.freeze({ xId: '1849302217654321002', handle: 'bo_tests', name: 'Bo Tester', picture: null }),
  cy: Object.freeze({ xId: '1849302217654321003', handle: 'cy_on_sepolia', name: 'Cy', picture: null }),
  // Hostile profile text: markup, a direction override and a bell in the name (the desk shows text only).
  mallory: Object.freeze({ xId: '1849302217654321004', handle: 'mallory_x', name: '<img src=x onerror=alert(1)>‮evil\u0007 name', picture: null }),
});

const seedOf = (testInfo, label) => createHash('sha256').update(`${testInfo.titlePath.join(' / ')}|${testInfo.project.name}|${label}`).digest('hex');
const base64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * This test's own state on the edge, the X account the stand-in signs in, the Sepolia data source, and no request
 * off the machine (each one aborted and recorded in `escaped`).
 */
export async function alphaContext(page, testInfo, tester = TESTERS.ada) {
  const baseURL = testInfo.project.use.baseURL;
  const tenant = `t${seedOf(testInfo, 'tenant').slice(0, 24)}`;
  await page.context().addCookies([
    { name: 'edge_tenant', value: tenant, url: baseURL },
    { name: 'standin_x', value: base64url(tester), url: baseURL },
  ]);
  await page.addInitScript(() => window.localStorage.setItem('squarehole.data-source.v1', JSON.stringify({ source: 'sepolia' })));
  const escaped = [];
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (route) => { escaped.push(new URL(route.request().url()).host); return route.abort(); });
  // What the release's CSP refused, and any uncaught error of the page.
  const problems = [];
  page.on('console', (message) => { if (message.type() === 'error' && /Content Security Policy|Refused to/i.test(message.text())) problems.push(message.text()); });
  page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
  return { baseURL, tenant, escaped, problems };
}

/** The X account the stand-in signs in from now on (another tester on the same device). */
export const signInAs = (page, testInfo, tester) => page.context().addCookies([{ name: 'standin_x', value: base64url(tester), url: testInfo.project.use.baseURL }]);

/** The join page's "Sign in with X", with its box ticked: the trip through the stand-in's X and back. */
export async function signIn(page) {
  await page.goto('/join');
  const box = page.getByRole('checkbox');
  await expect(box).toBeVisible();
  await box.check();
  const session = page.waitForResponse((response) => new URL(response.url()).pathname === '/alpha/session');
  await page.getByRole('button', { name: 'Sign in with X' }).click();
  return session;
}

/** The founder's decision, through the desk's API (the edge signs the Access token), from this site's origin. */
export async function decide(page, testInfo, xId, decision) {
  const response = await page.request.post('/desk/api/decide', { data: { xId, decision }, headers: { origin: new URL(testInfo.project.use.baseURL).origin } });
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}

/** A sign-up made the way the join page makes one (for the desk's list), in this test's state. */
export async function signUp(page, tester) {
  const response = await page.request.post('/__edge/signup', { data: tester });
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}

/** The sender's receipt for a queued claim: `sent`, `dry-run`, `refused` or `failed`. */
export async function receipt(page, id, status) {
  const response = await page.request.post('/__edge/receipt', { data: { id, status } });
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}

/** The claims in the sender's queue, as alpha-api wrote them. */
export async function queued(page) {
  const response = await page.request.get('/__edge/claims');
  expect(response.status()).toBe(200);
  return (await response.json()).claims;
}

/**
 * What the lock answers this browser for a path: `redirected` (to the join page) or the status. Asked from the page
 * itself: our sign-in cookie is Secure, which Chromium sends to http://127.0.0.1 but Playwright's own request context
 * does not, so a check through `page.request` would never carry it.
 */
export const lockAnswer = (page, path) => page.evaluate(async (target) => {
  const response = await fetch(target, { redirect: 'manual', cache: 'no-store', credentials: 'same-origin' });
  return response.type === 'opaqueredirect' ? 'redirected' : response.status;
}, path);

/** Our server's sign-in cookie, as the browser holds it. */
export async function sessionCookie(page) {
  return (await page.context().cookies()).find((cookie) => cookie.name === '__Host-alpha_session') ?? null;
}

/**
 * The browser's wallet: one EIP-6963 provider ("Alpha test wallet") with a key of this test's own. Every request is
 * recorded; `personal_sign` signs the exact bytes asked, for its own address only; nothing is ever sent.
 */
export async function browserWallet(page, testInfo, label = 'wallet') {
  const account = privateKeyToAccount(`0x${seedOf(testInfo, label)}`);
  const requests = [];
  await page.exposeFunction('alphaAccessWallet', async ({ method, params = [] }) => {
    requests.push({ method, params });
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account.address];
    if (method === 'eth_chainId') return `0x${SEPOLIA.toString(16)}`;
    if (method === 'wallet_switchEthereumChain') {
      if (Number.parseInt(params[0]?.chainId ?? '0', 16) !== SEPOLIA) throw new Error('Sepolia only');
      return null;
    }
    if (method === 'personal_sign') {
      const [data, from] = params;
      if (typeof from !== 'string' || from.toLowerCase() !== account.address.toLowerCase()) throw new Error('the test wallet signs for its own address only');
      if (typeof data !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(data)) throw new Error('hex message bytes only');
      return account.signMessage({ message: { raw: data } });
    }
    throw new Error(`the test wallet does not answer ${method}`);
  });
  await page.addInitScript(() => {
    const provider = { request: (request) => window.alphaAccessWallet(request), on() {}, removeListener() {} };
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
      detail: { info: { uuid: '0f4c2b7e-3d91-4a6b-8c5e-7a1d2f3b4c5d', name: 'Alpha test wallet', rdns: 'org.example.alpha-access', icon: 'data:image/svg+xml;base64,PHN2Zy8+' }, provider },
    })));
  });
  return { account, requests };
}

/** The scripts the page loaded so far, by file name. */
export const loadedScripts = (page) => page.evaluate(() => performance.getEntriesByType('resource').map((entry) => new URL(entry.name).pathname).filter((path) => path.endsWith('.js')));

const EVIDENCE = join(dirname(fileURLToPath(import.meta.url)), '../../../../docs/evidence');
/**
 * A screen as evidence, `<name>-<width>.png` (390 on the phone, 1440 on the desktop), when SH_EVIDENCE_SCREENSHOTS=1;
 * in the test's output otherwise. The whole page from its top, or one part of it; `record` names the evidence folder
 * (SH-ALPHA-SITE by default; F166's onboarding: SH-ALPHA-ONBOARDING), and `screen` takes the top of the page only, as
 * the visitor sees it on opening, rather than all of it.
 */
export async function shot(page, testInfo, name, locator = null, { record = 'SH-ALPHA-SITE', screen = false } = {}) {
  const width = page.viewportSize()?.width ?? 0;
  const file = process.env.SH_EVIDENCE_SCREENSHOTS === '1' ? join(EVIDENCE, record, `${name}-${width}.png`) : testInfo.outputPath(`${name}-${width}.png`);
  mkdirSync(dirname(file), { recursive: true });
  await page.evaluate(() => document.fonts?.ready);
  if (locator) {
    await locator.scrollIntoViewIfNeeded();
    await locator.screenshot({ path: file, scale: 'css', animations: 'disabled' });
  } else {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: file, fullPage: !screen, scale: 'css', animations: 'disabled' });
  }
}
