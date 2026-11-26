/**
 * F166 (SH-ALPHA-ONBOARDING): "Set me up", the automated onboarding, for an approved tester on the app's pages, against
 * the suite's edge (the real alpha-api, the sender's receipts written by the test, Privy's stand-in, whose made wallet
 * signs the claim with no window). This suite has no chain (every request off the machine is aborted), so here the
 * setup's chain part ends where the chain cannot be read; the alpha-trade suite's setup.spec.mjs runs it to its end on
 * the local alpha chain. Covered here: the one choice (a sheet over the page), "Not now", the run in the background
 * with its chip in the top bar while the tester browses, the sender's dry run ending it with a toast, a later visit's
 * "Finish setup" in the chip (nothing resumes by itself), a failed step on the chip and its Try again, the manual
 * path's entry and the Claim card's own entry. Each check of what does NOT show waits for the gate's answer (our
 * server's `GET /alpha/me`) and a drawn frame, not for a fixed time.
 */
import { expect, test } from '@playwright/test';
import { verifyMessage } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { TESTERS, alphaContext, decide, loadedScripts, queued, receipt, shot, signIn } from './helpers.mjs';

const RECORD = { record: 'SH-ALPHA-ONBOARDING' };
const WORDS = Object.freeze({
  title: 'Get set up', start: 'Set me up', finish: 'Finish setup', manual: 'I’ll do it myself', manualThere: 'I’ll do it myself on Test coins',
  notNow: 'Not now', tryAgain: 'Try again', close: 'Close', coins: 'Test coins',
  // SH-196/SH-198: the claim's real state, with its place in the sender's queue; no ETA.
  queued: 'Claim queued: position 1.', testMode: 'Test mode: nothing was sent.',
});
const HINT = 'sh.alpha.setup.v1';
/** Privy's SDK (privy-live.tsx) or its stand-in (this suite's): never before the press. Our own bridge interface may load. */
const PRIVY_CODE = /privy-live|standin/i;
/** The trade folders' chunk (TradeSlot.tsx): on the app's pages only for a tester the welcome step is for. */
const TRADE_CODE = /TradeSlot/;
const STANDIN_WALLET = 'sh.standin.privy.wallet.v1';

/** The gate's answer: our server's `GET /alpha/me`, then two drawn frames, so whatever it decided is on the page. */
async function gateAnswered(page, go) {
  const answer = page.waitForResponse((response) => new URL(response.url()).pathname === '/alpha/me');
  await go();
  await answer;
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
/** An approved tester signed in, on the app's first page: the welcome sheet there. */
async function approvedInApp(page, testInfo, tester) {
  await signIn(page);
  await expect(page.locator('.sh-join__big')).toHaveText('You’re on the list.');
  await decide(page, testInfo, tester.xId, 'approve');
  await page.goto('/');
  const sheet = page.getByRole('region', { name: WORDS.title });
  await expect(sheet).toBeVisible();
  return sheet;
}
/** The address of the wallet the stand-in made in this browser (its key stays in the browser, as Privy's does). */
async function madeAddress(page) {
  const key = await page.evaluate((name) => JSON.parse(window.localStorage.getItem(name) ?? 'null'), STANDIN_WALLET);
  return key ? privateKeyToAccount(key).address : null;
}
const hintOf = (page) => page.evaluate((name) => JSON.parse(window.localStorage.getItem(name) ?? 'null'), HINT);
/** The run's chip in the top bar, its four ticks, and its details (opened by a press on it). */
const chipOf = (page) => page.getByRole('banner').getByRole('button', { name: /^Setup: / });
const phaseOf = (page) => page.locator('.sh-setup-chip').getAttribute('data-phase');
const ticks = (page) => page.locator('.sh-setup-chip__tick').evaluateAll((items) => items.map((item) => item.getAttribute('data-mark')));
const detailsOf = (page) => page.getByRole('banner').getByRole('group', { name: WORDS.title });
async function openDetails(page) {
  const chip = chipOf(page);
  if ((await chip.getAttribute('aria-expanded')) !== 'true') await chip.click();
  const details = detailsOf(page);
  await expect(details).toBeVisible();
  return details;
}
/** A move to another page inside the app (the run goes on: a reload would end it). */
const browse = (page, path) => page.evaluate((to) => { window.history.pushState({}, '', to); window.dispatchEvent(new PopStateEvent('popstate')); }, path);
/** Every request to our server's claim calls, in order (method and path). */
function claimCalls(page) {
  const calls = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/alpha/claim')) calls.push(`${request.method()} ${path.replace(/[0-9a-f-]{36}$/, '<id>')}`);
  });
  return calls;
}

test('the choice: an approved tester opens the app and gets one choice, a sheet over the page that moves nothing; nothing of Privy and no claim before the press', async ({ page }, testInfo) => {
  const { escaped, problems } = await alphaContext(page, testInfo, TESTERS.ada);
  const calls = claimCalls(page);
  const sheet = await approvedInApp(page, testInfo, TESTERS.ada);
  await expect(sheet.getByRole('button', { name: WORDS.start })).toBeEnabled();
  await expect(sheet.getByRole('link', { name: WORDS.manualThere })).toHaveAttribute('href', '/test-coins');
  await expect(sheet.getByRole('button', { name: WORDS.notNow })).toBeVisible();
  await expect(sheet.getByText('A wallet, test ETH and your first tETH. One press.')).toBeVisible();
  // A sheet fixed over the page: the page under it does not move when it comes, and keeps room below its end.
  expect(await sheet.evaluate((node) => getComputedStyle(node).position)).toBe('fixed');
  expect(await page.evaluate(() => getComputedStyle(document.body).paddingBottom)).not.toBe('0px');
  // What the press does waits behind a closed Details button.
  const details = sheet.getByRole('button', { name: 'Details: What happens' });
  await expect(details).toHaveAttribute('aria-expanded', 'false');
  await expect(sheet.getByText('No window opens: this press is your one confirmation.')).toBeHidden();
  await shot(page, testInfo, 'setup-choice', null, { ...RECORD, screen: true });
  // The test-coin page is one press away in the app's navigation, in the alpha's builds (F166 af2).
  await expect(page.locator('nav[aria-label="Primary"] a[href="/test-coins"]')).toHaveText('Test coins');
  // Nothing of Privy (its stand-in) loaded, no claim call, nothing in this browser's wallet memory.
  expect((await loadedScripts(page)).filter((path) => PRIVY_CODE.test(path))).toEqual([]);
  expect(calls).toEqual([]);
  expect(await madeAddress(page)).toBeNull();
  expect(await hintOf(page)).toBeNull();
  await details.click();
  await expect(sheet.getByText('No window opens: this press is your one confirmation.')).toBeVisible();
  expect(escaped.filter((host) => /privy|x\.com|twitter/.test(host))).toEqual([]);
  expect(problems).toEqual([]);
});

test('Not now: the sheet goes for this visit, on every page of it; the next visit offers it again', async ({ page }, testInfo) => {
  const { problems } = await alphaContext(page, testInfo, TESTERS.bo);
  const sheet = await approvedInApp(page, testInfo, TESTERS.bo);
  await sheet.getByRole('button', { name: WORDS.notNow }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.locator('#page-title')).toBeFocused();
  await browse(page, '/about/risks');
  await expect(page).toHaveURL(/\/about\/risks$/);
  await expect(page.getByRole('region', { name: WORDS.title })).toHaveCount(0);
  await expect(chipOf(page)).toHaveCount(0);
  expect(await hintOf(page)).toBeNull();
  await gateAnswered(page, () => page.goto('/'));
  await expect(page.getByRole('region', { name: WORDS.title }).getByRole('button', { name: WORDS.start })).toBeVisible();
  expect(problems).toEqual([]);
});

test('Set me up runs in the background: the sheet goes, the chip in the top bar shows the run while the tester browses; the sender’s dry run ends it in test mode with a toast', async ({ page }, testInfo) => {
  const { escaped, problems } = await alphaContext(page, testInfo, TESTERS.ada);
  const calls = claimCalls(page);
  const sheet = await approvedInApp(page, testInfo, TESTERS.ada);
  await sheet.getByRole('button', { name: WORDS.start }).click();
  // The sheet is gone at once; the chip took its place in the top bar, with the keyboard.
  await expect(sheet).toHaveCount(0);
  await expect(chipOf(page)).toBeFocused();
  await expect.poll(() => ticks(page)).toEqual(['done', 'done', 'active', 'todo']);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // The tester browses meanwhile: the run goes on, its chip on the next page too.
  await browse(page, '/about/risks');
  await expect(page).toHaveURL(/\/about\/risks$/);
  await expect(chipOf(page)).toBeVisible();
  await expect(chipOf(page)).toHaveAccessibleName('Setup: Setting up, 2 of 4 steps done');
  await shot(page, testInfo, 'setup-chip-running', null, { ...RECORD, screen: true });
  const details = await openDetails(page);
  await expect(details.getByRole('status')).toHaveText(WORDS.queued);
  await shot(page, testInfo, 'setup-progress', null, { ...RECORD, screen: true });
  // The one claim in the sender's queue: the made wallet's, signed over exactly our server's text.
  const made = await madeAddress(page);
  expect(made).toMatch(/^0x[0-9a-fA-F]{40}$/);
  const [claim, ...more] = await queued(page);
  expect(more).toEqual([]);
  expect(claim).toMatchObject({ v: 1, xId: TESTERS.ada.xId, address: made });
  expect(claim.message).toContain(`I link my X account @ada_builds (X ID ${TESTERS.ada.xId}) to wallet ${made}.`);
  expect(await verifyMessage({ address: made, message: claim.message, signature: claim.signature })).toBe(true);
  expect(calls.slice(0, 2)).toEqual(['GET /alpha/claim/message', 'POST /alpha/claim']);
  expect(await hintOf(page)).toEqual({ handle: 'ada_builds', state: 'started', claimId: claim.id });

  // The sender is in its dry run: test mode, said once in a toast; the run ends there (nothing more asked).
  await receipt(page, claim.id, 'dry-run');
  await expect.poll(() => phaseOf(page), { timeout: 30_000 }).toBe('test');
  await expect(page.locator('.sh-setup-toast')).toHaveText(new RegExp(`^${WORDS.testMode}`));
  await expect.poll(() => ticks(page)).toEqual(['done', 'done', 'test', 'todo']);
  await expect(details.getByRole('button', { name: WORDS.tryAgain })).toHaveCount(0);
  await expect(details.getByRole('link', { name: WORDS.coins })).toHaveAttribute('href', '/test-coins');
  // The details' presses act a moment after they open (armed): the shot shows them as they then are.
  await expect(details.getByRole('button', { name: WORDS.close })).toBeEnabled();
  await shot(page, testInfo, 'setup-dry-run', null, { ...RECORD, screen: true });
  // The dry run freed the claim: this device's setup stays open for "Finish setup".
  expect(await hintOf(page)).toEqual({ handle: 'ada_builds', state: 'started', claimId: claim.id });
  await details.getByRole('button', { name: WORDS.close }).click();
  await expect(chipOf(page)).toHaveCount(0);
  await expect(page.locator('#page-title')).toBeFocused();
  // The next visit: the chip offers "Finish setup" (the sheet does not come back).
  await gateAnswered(page, () => page.reload());
  await expect(chipOf(page)).toHaveAccessibleName(`Setup: ${WORDS.finish}`);
  await expect(page.getByRole('region', { name: WORDS.title })).toHaveCount(0);
  expect(escaped.filter((host) => /privy|x\.com|twitter/.test(host))).toEqual([]);
  expect(problems).toEqual([]);
});

test('a later visit after leaving mid-way: the chip offers “Finish setup”, nothing signed or sent on load; its press goes on from the queued claim', async ({ page }, testInfo) => {
  const { problems } = await alphaContext(page, testInfo, TESTERS.bo);
  const calls = claimCalls(page);
  const sheet = await approvedInApp(page, testInfo, TESTERS.bo);
  await sheet.getByRole('button', { name: WORDS.start }).click();
  await expect.poll(() => ticks(page)).toEqual(['done', 'done', 'active', 'todo']);
  const made = await madeAddress(page);
  // The tester leaves and comes back.
  await gateAnswered(page, () => page.reload());
  const chip = chipOf(page);
  await expect(chip).toHaveAccessibleName(`Setup: ${WORDS.finish}`);
  // Nothing resumed by itself: no second claim, no Privy loaded, the claim as it was.
  expect(calls.filter((call) => call === 'POST /alpha/claim')).toHaveLength(1);
  expect((await loadedScripts(page)).filter((path) => PRIVY_CODE.test(path))).toEqual([]);
  const [claim, ...more] = await queued(page);
  expect(more).toEqual([]);
  const details = await openDetails(page);
  await expect(details.getByRole('list', { name: 'Setup steps' })).toHaveCount(0);
  await expect(details.getByRole('button', { name: WORDS.finish })).toBeEnabled();
  await shot(page, testInfo, 'setup-finish', null, { ...RECORD, screen: true });

  // The press: the same wallet (Privy's, made before), no new claim; then the sender sends.
  await details.getByRole('button', { name: WORDS.finish }).click();
  await expect(details.getByRole('status')).toHaveText(WORDS.queued);
  await expect.poll(() => ticks(page)).toEqual(['done', 'done', 'active', 'todo']);
  expect(await madeAddress(page)).toBe(made);
  expect(calls.filter((call) => call === 'POST /alpha/claim')).toHaveLength(1);
  await receipt(page, claim.id, 'sent');
  // This suite's build has no chain source (no indexer, every request off the machine aborted): the coins step stops
  // where the chain is to be read, and says so, with Try again (the alpha-trade suite runs it on to the end).
  await expect(details.getByRole('status')).toHaveText('The site’s chain cannot be read here.', { timeout: 30_000 });
  await expect.poll(() => ticks(page)).toEqual(['done', 'done', 'failed', 'todo']);
  await expect(details.getByRole('button', { name: WORDS.tryAgain })).toBeVisible();
  expect((await hintOf(page))?.state).toBe('started');
  expect(problems).toEqual([]);
});

test('a failed step: our server’s refusal stops the run at the claim; the chip shows it, its details the line and Try again, which goes on from there', async ({ page }, testInfo) => {
  const { problems } = await alphaContext(page, testInfo, TESTERS.cy);
  const calls = claimCalls(page);
  const sheet = await approvedInApp(page, testInfo, TESTERS.cy);
  // Our server does not answer the claim text once (a restart, say).
  let refused = 0;
  await page.route('**/alpha/claim/message?**', async (route) => {
    if (refused > 0) return route.fallback();
    refused += 1;
    return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'service unavailable' }) });
  });
  await sheet.getByRole('button', { name: WORDS.start }).click();
  await expect.poll(() => phaseOf(page)).toBe('stopped');
  await expect(chipOf(page)).toHaveAccessibleName('Setup: Setup stopped, 1 of 4 steps done');
  await expect.poll(() => ticks(page)).toEqual(['done', 'failed', 'todo', 'todo']);
  // The stop is said once (a live region by the chip).
  await expect(page.getByRole('banner').getByRole('status')).toHaveText('The alpha service is not available. Try again later.');
  await shot(page, testInfo, 'setup-chip-failed', null, { ...RECORD, screen: true });
  const details = await openDetails(page);
  await expect(details.getByText('The alpha service is not available. Try again later.')).toBeVisible();
  await expect(details.getByRole('button', { name: WORDS.tryAgain })).toBeEnabled();
  await expect(details.getByRole('button', { name: WORDS.close })).toBeEnabled();
  await expect(details.getByRole('link', { name: WORDS.manualThere })).toBeVisible();
  await shot(page, testInfo, 'setup-failed', null, { ...RECORD, screen: true });
  expect(await queued(page)).toEqual([]);

  await details.getByRole('button', { name: WORDS.tryAgain }).click();
  await expect(details.getByRole('status')).toHaveText(WORDS.queued);
  const [claim, ...more] = await queued(page);
  expect(more).toEqual([]);
  expect(await verifyMessage({ address: await madeAddress(page), message: claim.message, signature: claim.signature })).toBe(true);
  // Our server: the refused text, the text again, the claim (the queued claim's own reads aside).
  expect(calls.filter((call) => !call.endsWith('<id>'))).toEqual(['GET /alpha/claim/message', 'GET /alpha/claim/message', 'POST /alpha/claim']);
  expect(problems).toEqual([]);
});

test('the manual path’s entry: “I’ll do it myself on Test coins” opens that page on today’s Claim card; this device is asked no more, there or on the app’s pages', async ({ page }, testInfo) => {
  const { problems } = await alphaContext(page, testInfo, TESTERS.ada);
  const sheet = await approvedInApp(page, testInfo, TESTERS.ada);
  await sheet.getByRole('link', { name: WORDS.manualThere }).click();
  await expect(page).toHaveURL(/\/test-coins$/);
  const card = page.getByRole('region', { name: 'Claim' });
  await expect(card.getByRole('button', { name: 'Use my wallet' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Make me a wallet' })).toBeVisible();
  await expect(card.getByRole('button', { name: WORDS.start })).toHaveCount(0);
  await shot(page, testInfo, 'setup-manual', null, { ...RECORD, screen: true });
  expect((await hintOf(page))?.state).toBe('manual');
  expect(await madeAddress(page)).toBeNull();
  // The app's pages ask no more on this device (the gate decided nothing: the trade chunk did not even load).
  await gateAnswered(page, () => page.goto('/'));
  await expect(page.getByRole('region', { name: WORDS.title })).toHaveCount(0);
  await expect(chipOf(page)).toHaveCount(0);
  expect((await loadedScripts(page)).filter((path) => TRADE_CODE.test(path))).toEqual([]);
  // The test-coin page remembers the choice on a later visit too: today's steps at once.
  await page.goto('/test-coins');
  await expect(card.getByRole('button', { name: 'Use my wallet' })).toBeVisible();
  await expect(card.getByRole('button', { name: WORDS.start })).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('the Claim card’s own entry, for a tester who opens the test-coin page first: “Set me up” first, today’s steps behind the small button', async ({ page }, testInfo) => {
  const { problems } = await alphaContext(page, testInfo, TESTERS.cy);
  await signIn(page);
  await expect(page.locator('.sh-join__big')).toHaveText('You’re on the list.');
  await decide(page, testInfo, TESTERS.cy.xId, 'approve');
  await page.goto('/test-coins');
  const card = page.getByRole('region', { name: 'Claim' });
  await expect(card.getByRole('button', { name: WORDS.start })).toBeEnabled();
  await expect(card.getByRole('button', { name: WORDS.manual })).toBeVisible();
  // The welcome sheet stays off this page (the card holds the same choice).
  await expect(page.getByRole('region', { name: WORDS.title })).toHaveCount(0);
  await shot(page, testInfo, 'setup-card-choice', null, { ...RECORD, screen: true });
  expect(problems).toEqual([]);
});
