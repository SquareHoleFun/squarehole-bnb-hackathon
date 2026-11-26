/**
 * F161 (4), SH-ALPHA-SITE: the founder's desk (`/desk`, behind Cloudflare Access; here the suite's edge signs the
 * Access token) over the real alpha-api: what Privy gives about each sign-up and nothing more, and the three decisions.
 */
import { expect, test } from '@playwright/test';
import { TESTERS, alphaContext, decide, shot, signUp } from './helpers.mjs';

test('the desk: each sign-up’s handle links to its X profile by X number, with its name and sign-up time, pending first; approve, remove and reset each ask once more and act at once', async ({ page }, testInfo) => {
  const { escaped, problems } = await alphaContext(page, testInfo);
  for (const tester of [TESTERS.ada, TESTERS.bo, TESTERS.cy, TESTERS.mallory]) expect((await signUp(page, tester)).status).toBe('pending');
  await decide(page, testInfo, TESTERS.cy.xId, 'approve');

  await page.goto('/desk');
  await expect(page.getByRole('heading', { level: 1, name: 'Alpha desk' })).toBeVisible();
  const list = page.getByRole('list', { name: 'Sign-ups' });
  await expect(list.getByRole('listitem')).toHaveCount(4);
  const row = (tester) => list.locator(`[data-x-id="${tester.xId}"]`);
  const ada = row(TESTERS.ada);
  const profile = ada.getByRole('link');
  // By X number, which X never gives to another account (XR-ALPHA-SITE af2); the text stays the handle.
  await expect(profile).toHaveAttribute('href', `https://x.com/i/user/${TESTERS.ada.xId}`);
  await expect(profile).toContainText('@ada_builds');
  await expect(profile).toHaveAttribute('target', '_blank');
  await expect(profile).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(ada.locator('.sh-desk__name')).toHaveText('Ada Builder');
  await expect(ada).toContainText(new RegExp(`Signed up \\d{1,2} [A-Z][a-z]{2} \\d{4}, \\d{2}:\\d{2} UTC · X ${TESTERS.ada.xId}`));
  // Pending first, then approved; the counts.
  expect(await list.getByRole('listitem').evaluateAll((items) => items.map((item) => item.dataset.status))).toEqual(['pending', 'pending', 'pending', 'approved']);
  await expect(page.locator('.sh-desk__counts')).toHaveText('Pending3Approved1Removed0');
  // Privy gives no account age or followers, and the desk shows none; no picture either.
  await expect(page.locator('main')).not.toContainText(/follower|account age|verified/i);
  await expect(page.locator('img')).toHaveCount(0);
  // Hostile profile text stays text: no element made from it, its direction and control characters taken out.
  await expect(row(TESTERS.mallory).locator('.sh-desk__name')).toHaveText('<img src=x onerror=alert(1)> evil name');
  await shot(page, testInfo, 'desk');

  // Approve asks once more; Cancel sends nothing.
  await ada.getByRole('button', { name: 'Approve @ada_builds' }).click();
  await expect(ada.getByRole('status')).toHaveText('Let @ada_builds in?');
  await shot(page, testInfo, 'desk-confirm');
  await ada.getByRole('button', { name: 'Cancel' }).click();
  await expect(ada).toHaveAttribute('data-status', 'pending');
  await ada.getByRole('button', { name: 'Approve @ada_builds' }).click();
  await ada.getByRole('button', { name: 'Confirm' }).click();
  await expect(ada).toHaveAttribute('data-status', 'approved');
  await expect(ada).toContainText(/approved \d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} UTC/);
  // Remove, then reset, each with its own question.
  await ada.getByRole('button', { name: 'Remove @ada_builds' }).click();
  await expect(ada.getByRole('status')).toHaveText('End @ada_builds’s access?');
  await ada.getByRole('button', { name: 'Confirm' }).click();
  await expect(ada).toHaveAttribute('data-status', 'removed');
  await ada.getByRole('button', { name: 'Reset @ada_builds' }).click();
  await expect(ada.getByRole('status')).toHaveText('Put @ada_builds back on the list?');
  await ada.getByRole('button', { name: 'Confirm' }).click();
  await expect(ada).toHaveAttribute('data-status', 'pending');

  // Our server recorded each decision, by X number, as the founder's Access identity, in order.
  const desk = await (await page.request.get('/desk/api/signups')).json();
  expect(desk.decisions.map(({ xId, decision, actor }) => [xId, decision, actor])).toEqual([
    [TESTERS.cy.xId, 'approve', 'founder-edge-fixture'],
    [TESTERS.ada.xId, 'approve', 'founder-edge-fixture'],
    [TESTERS.ada.xId, 'remove', 'founder-edge-fixture'],
    [TESTERS.ada.xId, 'reset', 'founder-edge-fixture'],
  ]);
  expect(escaped).toEqual([]);
  expect(problems).toEqual([]);
});

test('the desk and its API need the founder’s Access sign-in: without it, the page and every call are refused', async ({ page }, testInfo) => {
  const { baseURL } = await alphaContext(page, testInfo);
  await signUp(page, TESTERS.ada);
  await page.context().addCookies([{ name: 'edge_access', value: 'off', url: baseURL }]);
  for (const path of ['/desk', '/desk/', '/desk/index.html', '/desk/api/signups']) {
    const response = await page.request.get(path, { maxRedirects: 0 });
    expect(response.status(), path).toBe(401);
    expect(await response.json(), path).toEqual({ error: 'Access identity required' });
  }
  const decided = await page.request.post('/desk/api/decide', { data: { xId: TESTERS.ada.xId, decision: 'approve' }, headers: { origin: new URL(baseURL).origin } });
  expect(decided.status()).toBe(401);
  // A page of the desk: our server's refusal, never the list.
  await page.goto('/desk');
  await expect(page.locator('body')).toContainText('Access identity required');
  await expect(page.getByRole('heading', { name: 'Alpha desk' })).toHaveCount(0);
});
