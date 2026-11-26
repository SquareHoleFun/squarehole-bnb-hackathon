/**
 * F161 (4), SH-ALPHA-SITE: the join page and the page lock, as a stranger, a pending, an approved and a removed tester
 * meet them (docs/design/alpha-access-privy.md § 5, "The page lock"), on the suite's edge with the real alpha-api.
 */
import { expect, test } from '@playwright/test';
import { TESTERS, alphaContext, decide, loadedScripts, lockAnswer, sessionCookie, shot, signIn } from './helpers.mjs';

const PENDING = 'You’re on the list.';
const APPROVED = 'You’re in.';
const REMOVED = 'Your access has ended.';
// SH-220: the founder's approved line under "Sign in with X", on phones only (15 November 2026).
const PHONE_LINE = 'On a phone, X asks you to log in once. That’s X, not us.';

/**
 * SH-220: where the phone line stands against its "Sign in with X" button, by the browser's own layout and computed
 * style: shown with `(pointer: coarse)` (the mobile project's Pixel 7 emulation matches it), `display: none` otherwise.
 */
async function phoneLineState(page) {
  return page.evaluate(() => {
    const line = document.querySelector('.sh-join__phone');
    const button = Array.from(document.querySelectorAll('button')).find((element) => element.textContent === 'Sign in with X');
    if (!line || !button) return { line: Boolean(line), button: Boolean(button) };
    const box = line.getBoundingClientRect();
    const row = button.closest('.sh-join__actions').getBoundingClientRect();
    const buttonBox = button.getBoundingClientRect();
    return {
      line: true,
      button: true,
      coarse: matchMedia('(pointer: coarse)').matches,
      display: getComputedStyle(line).display,
      under: box.height === 0 ? null : box.top >= row.bottom,
      left: box.left,
      right: box.right,
      viewport: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      onTop: document.elementFromPoint(buttonBox.left + buttonBox.width / 2, buttonBox.top + buttonBox.height / 2) === button,
    };
  });
}

/**
 * SH-220 follow-up: the phone line's line boxes, measured with a Range over its one text node: its client rects, one
 * or more per line box, grouped by their top; the last line box's width (its rects' left to right); and the width of
 * the last word ("us.") alone, from a Range over just its letters.
 */
async function phoneLineBoxes(page) {
  return page.evaluate(() => {
    const line = document.querySelector('.sh-join__phone');
    const text = line.firstChild;
    const whole = document.createRange();
    whole.selectNodeContents(text);
    const rects = Array.from(whole.getClientRects()).filter((rect) => rect.width > 0);
    const tops = [...new Set(rects.map((rect) => Math.round(rect.top)))].sort((a, b) => a - b);
    const last = rects.filter((rect) => Math.round(rect.top) === tops.at(-1));
    const word = document.createRange();
    word.setStart(text, text.data.lastIndexOf(' ') + 1);
    word.setEnd(text, text.data.length);
    return {
      lines: tops.length,
      lastWidth: Math.max(...last.map((rect) => rect.right)) - Math.min(...last.map((rect) => rect.left)),
      lastWord: word.toString(),
      wordWidth: word.getBoundingClientRect().width,
      textWrapStyle: getComputedStyle(line).textWrapStyle,
    };
  });
}

test('SH-220: on a phone a line under each “Sign in with X” says X asks for its login once; on a desktop it is neither shown nor announced', async ({ page }, testInfo) => {
  const { problems } = await alphaContext(page, testInfo, TESTERS.ada);
  const phone = testInfo.project.name === 'mobile';
  await page.goto('/join');
  const button = page.getByRole('button', { name: 'Sign in with X' });
  await expect(button).toBeVisible();
  const line = page.locator('.sh-join__phone');
  await expect(line).toHaveCount(1);
  await expect(line).toHaveText(PHONE_LINE);
  const stranger = await phoneLineState(page);
  const card = page.locator('.sh-join__card');
  if (phone) {
    await expect(line).toBeVisible();
    expect(stranger).toMatchObject({ coarse: true, display: 'block', under: true, viewport: 390, scrollWidth: 390, onTop: true });
    expect(stranger.left).toBeGreaterThanOrEqual(0);
    expect(stranger.right).toBeLessThanOrEqual(390);
    expect(await card.ariaSnapshot()).toContain(PHONE_LINE);
    // Two balanced lines at 390 px: the last line box is wider than its last word, so "us." never stands alone.
    const boxes = await phoneLineBoxes(page);
    expect(boxes).toMatchObject({ lines: 2, lastWord: 'us.' });
    expect(boxes.lastWidth, JSON.stringify(boxes)).toBeGreaterThan(boxes.wordWidth + 1);
  } else {
    await expect(line).toBeHidden();
    expect(stranger).toMatchObject({ coarse: false, display: 'none', under: null, onTop: true });
    expect(await card.ariaSnapshot()).not.toContain(PHONE_LINE);
  }
  await shot(page, testInfo, 'join-phone-line', card);

  // The button under which it sits still signs in.
  await page.getByRole('checkbox').check();
  const session = page.waitForResponse((response) => new URL(response.url()).pathname === '/alpha/session');
  await button.click();
  expect((await session).status()).toBe(200);
  await expect(page.locator('.sh-join__big')).toHaveText(PENDING);
  // The member view without "Sign in with X" has no line.
  await expect(line).toHaveCount(0);

  // The member view's "Sign in with X" (Privy's sign-in lapsed, from the Claim card's link) has it too.
  await page.evaluate(() => window.localStorage.removeItem('sh.standin.privy.v1'));
  await page.goto('/join?then=export');
  await expect(page.locator('.sh-join__big')).toHaveText(PENDING);
  await expect(button).toBeVisible();
  await expect(line).toHaveCount(1);
  await expect(line).toHaveText(PHONE_LINE);
  const member = await phoneLineState(page);
  if (phone) {
    await expect(line).toBeVisible();
    expect(member).toMatchObject({ coarse: true, display: 'block', under: true, viewport: 390, scrollWidth: 390, onTop: true });
    expect(member.right).toBeLessThanOrEqual(390);
  } else {
    await expect(line).toBeHidden();
    expect(member).toMatchObject({ display: 'none', under: null });
    expect(await card.ariaSnapshot()).not.toContain(PHONE_LINE);
  }
  await shot(page, testInfo, 'join-phone-line-member', card);
  expect(problems).toEqual([]);
});

test('a stranger: any app address leads to the join page, with the notice, its box and Sign in with X; Privy’s code loads only on the press', async ({ page }, testInfo) => {
  const { escaped, problems } = await alphaContext(page, testInfo);
  const asked = [];
  page.on('request', (request) => asked.push(new URL(request.url()).pathname));
  const refused = [];
  page.on('response', (response) => { if (response.status() >= 400) refused.push(`${response.status()} ${new URL(response.url()).pathname}`); });

  await page.goto('/test-coins');
  await expect(page).toHaveURL(/\/join$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Square Hole alpha' })).toBeVisible();
  await expect(page.locator('.sh-join__status')).toHaveText('Sepolia test network. Test tokens with no value.');
  const notice = page.getByRole('region', { name: 'Test network notice' });
  await expect(notice.getByRole('listitem')).toHaveCount(11);
  await expect(notice.getByRole('listitem').first()).toHaveText('Closed alpha. You sign in with X. We let in the X accounts we approve.');
  const box = page.getByRole('checkbox', { name: /^I have read and accept the test network notice, and I confirm that I am at least 18/ });
  await expect(box).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Sign in with X' })).toBeDisabled();
  await shot(page, testInfo, 'join-stranger');

  // The data part, behind its button: the sign-in through Privy, what is kept, our cookie and Privy's items.
  await page.locator('summary', { hasText: 'Your data' }).click();
  await expect(page.getByText('You sign in with X through Privy, a Stripe company. X shows Privy’s name. Privy and our server log sign-ins.')).toBeVisible();
  await page.locator('summary', { hasText: 'What stays on your device' }).click();
  for (const key of ['__Host-alpha_session', 'privy:token', 'privy:refresh_token']) await expect(page.locator('.sh-join__details').getByText(key, { exact: true })).toBeVisible();
  // (Its picture comes from the release build, production-alpha-pages.spec.ts: this development build also lists the
  // sample data's items.)

  // Nothing of Privy's (here its stand-in) before the press, nothing from the locked app, and no wallet asked.
  expect((await loadedScripts(page)).filter((path) => /privy|standin/i.test(path))).toEqual([]);
  expect(asked.filter((path) => path.startsWith('/__standin/') || path === '/alpha/session')).toEqual([]);
  expect(asked.filter((path) => path.startsWith('/assets/'))).toEqual([]);
  // Only our server's "not signed in" answers (the page asks /alpha/me once); every file loaded.
  expect(refused).toEqual(['401 /alpha/me']);

  // The box first, then the press: the stand-in loads then, and only then.
  await box.check();
  await expect(page.getByRole('button', { name: 'Sign in with X' })).toBeEnabled();
  expect(escaped).toEqual([]);
  expect(problems).toEqual([]);
});

test('sign in with X: the stand-in’s trip to X and back, one identity token to our server, its 7-day __Host- cookie, You’re on the list; the app stays locked', async ({ page }, testInfo) => {
  const { escaped, problems } = await alphaContext(page, testInfo, TESTERS.ada);
  const sessions = [];
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/alpha/session') sessions.push(request); });

  const answer = await signIn(page);
  expect(answer.status()).toBe(200);
  expect(answer.request().method()).toBe('POST');
  expect(answer.request().headers()['privy-id-token']).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
  await expect(page.locator('.sh-join__big')).toHaveText(PENDING);
  await expect(page.locator('.sh-join__handle')).toHaveText('@ada_builds');
  await expect(page.getByText('We let you in once we approve your X account.')).toBeVisible();
  // Privy's three query parameters are gone from the address.
  await expect(page).toHaveURL(/\/join$/);
  expect(sessions).toHaveLength(1);

  // Our server's cookie: seven days, HttpOnly, Secure, SameSite=Lax, for this host only; no page script sees it.
  const cookie = await sessionCookie(page);
  expect(cookie).toMatchObject({ domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' });
  const days = (cookie.expires * 1000 - Date.now()) / 86_400_000;
  expect(days).toBeGreaterThan(6.99);
  expect(days).toBeLessThanOrEqual(7);
  expect(await page.evaluate(() => document.cookie)).not.toContain('__Host-alpha_session');
  await shot(page, testInfo, 'join-pending');

  // A pending account is still locked out: every page and file of the app leads back here.
  await page.goto('/');
  await expect(page).toHaveURL(/\/join$/);
  await expect(page.locator('.sh-join__big')).toHaveText(PENDING);
  for (const path of ['/', '/test-coins', '/about/risks']) expect(await lockAnswer(page, path), path).toBe('redirected');
  expect(sessions).toHaveLength(1);
  expect(escaped).toEqual([]);
  expect(problems).toEqual([]);
});

test('approved: the founder lets the account in; the join page shows You’re in with the way into the app; sign-out ends both sessions; a fresh sign-in goes straight in', async ({ page }, testInfo) => {
  const { baseURL, escaped, problems } = await alphaContext(page, testInfo, TESTERS.bo);
  await signIn(page);
  await expect(page.locator('.sh-join__big')).toHaveText(PENDING);
  await decide(page, testInfo, TESTERS.bo.xId, 'approve');

  await page.reload();
  await expect(page.locator('.sh-join__big')).toHaveText(APPROVED);
  await expect(page.locator('.sh-join__handle')).toHaveText('@bo_tests');
  await expect(page.getByRole('link', { name: 'Open the app' })).toHaveAttribute('href', '/');
  await expect(page.getByRole('link', { name: 'Claim test ETH' })).toHaveAttribute('href', '/test-coins');
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await shot(page, testInfo, 'join-approved');

  // The app is this session's now.
  expect(await lockAnswer(page, '/test-coins')).toBe(200);
  await page.getByRole('link', { name: 'Open the app' }).click();
  await expect(page).toHaveURL(`${baseURL}/`);
  await expect(page.locator('.sh-footer')).toContainText('Sepolia testnet · Test tokens only · Not audited · Test trades only');

  // Sign out (on the join page): our cookie goes, Privy's session in this browser goes, and the lock is back.
  await page.goto('/join');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('Signed out.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with X' })).toBeVisible();
  expect(await sessionCookie(page)).toBeNull();
  expect(await page.evaluate(() => window.localStorage.getItem('sh.standin.privy.v1'))).toBeNull();
  expect(await lockAnswer(page, '/test-coins')).toBe('redirected');

  // An approved account's fresh sign-in goes straight into the app.
  await signIn(page);
  await expect(page).toHaveURL(`${baseURL}/`);
  await expect(page.locator('.sh-footer')).toBeVisible();
  expect(escaped.filter((host) => /privy|x\.com|twitter/.test(host))).toEqual([]);
  expect(problems).toEqual([]);
});

test('removed: the founder ends the access; the next page is the join page saying so, and the export of the wallet Privy made stays', async ({ page }, testInfo) => {
  const { escaped, problems } = await alphaContext(page, testInfo, TESTERS.cy);
  await signIn(page);
  await decide(page, testInfo, TESTERS.cy.xId, 'approve');
  await page.goto('/test-coins');
  const card = page.getByRole('region', { name: 'Claim' });
  // Today's steps, behind the card's "I'll do it myself" (F166).
  await card.getByRole('button', { name: 'I’ll do it myself' }).click();
  await card.getByRole('button', { name: 'Make me a wallet' }).click();
  const shown = card.locator('dd code');
  await expect(shown).toHaveAttribute('title', /^0x[0-9a-fA-F]{40}$/);
  const made = await shown.getAttribute('title');

  expect(await lockAnswer(page, '/test-coins')).toBe(200);
  await decide(page, testInfo, TESTERS.cy.xId, 'remove');
  // Removal acts at once: the next request of the app is the lock's.
  expect(await lockAnswer(page, '/test-coins')).toBe('redirected');
  await page.reload();
  await expect(page).toHaveURL(/\/join$/);
  await expect(page.locator('.sh-join__big')).toHaveText(REMOVED);
  await expect(page.locator('.sh-join__handle')).toHaveText('@cy_on_sepolia');
  await expect(page.getByText('A wallet Privy made for you stays yours: export its key below.')).toBeVisible();
  await shot(page, testInfo, 'join-removed');

  // The export stays on the public join page: Privy's export of the wallet it made (the stand-in records the ask).
  await page.getByRole('button', { name: 'Export wallet key' }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.standinExport ?? null)).toBe(made);
  expect(escaped.filter((host) => /privy|x\.com|twitter/.test(host))).toEqual([]);
  expect(problems).toEqual([]);
});

test('the export after Privy’s sign-in lapsed while ours is on (XR-ALPHA-SITE af2): the join page says so, offers “Sign in with X”, and comes back to itself', async ({ page }, testInfo) => {
  const { problems } = await alphaContext(page, testInfo, TESTERS.ada);
  await signIn(page);
  await decide(page, testInfo, TESTERS.ada.xId, 'approve');
  await page.goto('/test-coins');
  const card = page.getByRole('region', { name: 'Claim' });
  await card.getByRole('button', { name: 'I’ll do it myself' }).click();
  await card.getByRole('button', { name: 'Make me a wallet' }).click();
  const shown = card.locator('dd code');
  await expect(shown).toHaveAttribute('title', /^0x[0-9a-fA-F]{40}$/);
  const made = await shown.getAttribute('title');
  // Privy's sign-in in this browser lapses (the stand-in's own record goes); our 7-day cookie stays.
  await page.evaluate(() => window.localStorage.removeItem('sh.standin.privy.v1'));
  await page.goto('/join');
  await expect(page.locator('.sh-join__big')).toHaveText(APPROVED);
  await page.getByRole('button', { name: 'Export wallet key' }).click();
  await expect(page.getByRole('status')).toHaveText('Sign in with X again first, then export.');
  await shot(page, testInfo, 'join-export-signin');
  // The sign-in from here comes back here, not into the app.
  const session = page.waitForResponse((response) => new URL(response.url()).pathname === '/alpha/session');
  await page.getByRole('button', { name: 'Sign in with X' }).click();
  expect((await session).status()).toBe(200);
  await expect(page).toHaveURL(/\/join$/);
  await expect(page.locator('.sh-join__big')).toHaveText(APPROVED);
  await page.getByRole('button', { name: 'Export wallet key' }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.standinExport ?? null)).toBe(made);
  expect(problems).toEqual([]);
});
