/**
 * F161 (4), SH-ALPHA-SITE: the Claim card on the test-coin page (docs/design/alpha-access-privy.md § 2, § 5 "Embedded
 * wallets"), for an approved tester: a browser wallet with its own window, or the wallet Privy makes (here the
 * stand-in's, which signs on the card's press with no window), the exact claim text, one press, and the sender's
 * receipt. The real alpha-api checks every signature; the suite's edge writes the receipts. Since F166 the card leads
 * with "Set me up" (setup.spec.mjs); these steps are the manual path behind its "I'll do it myself", unchanged.
 */
import { expect, test } from '@playwright/test';
import { toHex, verifyMessage } from 'viem';
import { SITE_ORIGIN, TESTERS, alphaContext, browserWallet, decide, queued, receipt, shot, signIn, signInAs } from './helpers.mjs';

// SH-196/SH-198 (SH-SENDER-FLOAT, SH-ALPHA-LIMITS): the claim's real state, with its place in the sender's queue; no ETA.
const QUEUED = 'Claim queued: position 1.';
const MANUAL = 'I’ll do it myself';
const claimPath = (response) => new URL(response.url()).pathname;
/** The card's entry to today's steps (F166): the small button beside "Set me up". */
async function manualSteps(card) {
  await card.getByRole('button', { name: MANUAL }).click();
  await expect(card.getByRole('button', { name: 'Set me up' })).toHaveCount(0);
}
/**
 * An approved tester on the test-coin page, and its Claim card, on today's steps (`entry`: through "I'll do it myself";
 * without it, a card whose tester has a browser wallet connected, which goes there at once).
 */
async function approvedOnTestCoins(page, testInfo, tester, { entry = true } = {}) {
  await signIn(page);
  await expect(page.locator('.sh-join__big')).toHaveText('You’re on the list.');
  await decide(page, testInfo, tester.xId, 'approve');
  await page.goto('/test-coins');
  const card = page.getByRole('region', { name: 'Claim' });
  await expect(card.getByRole('heading', { name: 'Claim' })).toBeVisible();
  if (entry) await manualSteps(card);
  return card;
}
/** "Claim": our server's exact text for the wallet's address, as the card shows it. */
async function claimText(page, card) {
  const answer = page.waitForResponse((response) => claimPath(response) === '/alpha/claim/message');
  await card.getByRole('button', { name: 'Claim', exact: true }).click();
  const challenge = await (await answer).json();
  await expect(card.locator('[data-claim-text]')).toHaveText(challenge.message);
  return challenge;
}
/** "Sign and claim": the one press; our server's answer. */
async function signAndClaim(page, card) {
  const answer = page.waitForResponse((response) => claimPath(response) === '/alpha/claim' && response.request().method() === 'POST');
  await card.getByRole('button', { name: 'Sign and claim' }).click();
  return answer;
}
const line = (card) => card.locator('.sh-coins__line');

test('Use my wallet: the wallet’s own window, the exact claim text for its address, one press signs exactly it; queued, then sent with its two transactions', async ({ page }, testInfo) => {
  const { escaped, problems } = await alphaContext(page, testInfo, TESTERS.ada);
  const wallet = await browserWallet(page, testInfo);
  const card = await approvedOnTestCoins(page, testInfo, TESTERS.ada);
  await expect(card.getByRole('button', { name: 'Use my wallet' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Make me a wallet' })).toBeVisible();
  // Nothing asked of a wallet on the way here.
  expect(wallet.requests).toEqual([]);
  await shot(page, testInfo, 'claim-choose', card);

  await card.getByRole('button', { name: 'Use my wallet' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect a browser wallet' });
  await expect(dialog).toContainText('On this test site Square Hole asks for test trades and their exact approvals, faucet drips, your alpha claim, launches and fee claims');
  await dialog.getByRole('button', { name: /Alpha test wallet/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card.locator('dd code')).toHaveAttribute('title', wallet.account.address);

  const challenge = await claimText(page, card);
  expect(challenge.address).toBe(wallet.account.address);
  expect(challenge.message).toBe(`Square Hole alpha claim\n\nI link my X account @ada_builds (X ID ${TESTERS.ada.xId}) to wallet ${wallet.account.address}.\nI request starter SepETH on Sepolia (chain 11155111).\nClaim ID: ${challenge.id}\nTime: ${challenge.requestedAt}\nSite: ${SITE_ORIGIN}`);
  await shot(page, testInfo, 'claim-text', card);

  const asked = wallet.requests.length;
  const claimed = await signAndClaim(page, card);
  expect(claimed.status()).toBe(202);
  const { id, status } = await claimed.json();
  expect([id, status]).toEqual([challenge.id, 'queued']);
  // One signature, of exactly the text shown, for this address; the wallet was never asked to send.
  expect(wallet.requests.slice(asked).map(({ method, params }) => [method, params[0], params[1]?.toLowerCase()])).toEqual([['personal_sign', toHex(challenge.message), wallet.account.address.toLowerCase()]]);
  await expect(line(card)).toHaveText(QUEUED);
  await shot(page, testInfo, 'claim-queued', card);

  // The sender's queue holds exactly that claim, and its signature is this wallet's over this text.
  const [payload, ...more] = await queued(page);
  expect(more).toEqual([]);
  expect(payload).toMatchObject({ v: 1, id, xId: TESTERS.ada.xId, address: wallet.account.address, message: challenge.message, requestedAt: challenge.requestedAt });
  expect(await verifyMessage({ address: wallet.account.address, message: challenge.message, signature: payload.signature })).toBe(true);

  // The sender sends: the card follows the claim to its receipt, with both transactions on the explorer.
  const written = await receipt(page, id, 'sent');
  await expect(line(card)).toHaveText('Sent: your starter SepETH and tETH faucet access.', { timeout: 30_000 });
  const links = card.locator('.sh-claim__links a');
  await expect(links).toHaveCount(2);
  await expect(links.nth(0)).toHaveAttribute('href', `https://sepolia.etherscan.io/tx/${written.admitTx}`);
  await expect(links.nth(1)).toHaveAttribute('href', `https://sepolia.etherscan.io/tx/${written.sendTx}`);
  // After the claim went out, the card still leads to sign-out and the made wallet's export (XR-ALPHA-SITE af1).
  await expect(card.getByRole('link', { name: 'Sign-in and wallet' })).toHaveAttribute('href', '/join');
  await shot(page, testInfo, 'claim-sent', card);

  // Our server keeps the claim: a reload shows it again, and the card offers no second one.
  await page.reload();
  await expect(line(card)).toHaveText('Sent: your starter SepETH and tETH faucet access.');
  await expect(card.getByRole('button', { name: 'Claim', exact: true })).toHaveCount(0);
  expect(wallet.requests.filter(({ method }) => /send|transaction/i.test(method))).toEqual([]);
  expect(escaped.filter((host) => /privy|x\.com|twitter/.test(host))).toEqual([]);
  expect(problems).toEqual([]);
});

test('Make me a wallet: made on the press, it signs Sign and claim with no window, Export key stays on the card, and a dry run frees the claim', async ({ page }, testInfo) => {
  const { escaped, problems } = await alphaContext(page, testInfo, TESTERS.bo);
  const card = await approvedOnTestCoins(page, testInfo, TESTERS.bo);
  // Privy makes no wallet at sign-in: only the press does.
  expect(await page.evaluate(() => window.localStorage.getItem('sh.standin.privy.wallet.v1'))).toBeNull();
  await card.getByRole('button', { name: 'Make me a wallet' }).click();
  const shown = card.locator('dd code');
  await expect(shown).toHaveAttribute('title', /^0x[0-9a-fA-F]{40}$/);
  const made = await shown.getAttribute('title');
  await expect(card).toContainText('Wallet Privy made');
  await expect(card.getByRole('button', { name: 'Export key' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await shot(page, testInfo, 'claim-made-wallet', card);

  const challenge = await claimText(page, card);
  expect(challenge.address).toBe(made);
  const claimed = await signAndClaim(page, card);
  expect(claimed.status()).toBe(202);
  const { id } = await claimed.json();
  // No window of Privy's or the browser's: the card's press was the one confirmation.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(line(card)).toHaveText(QUEUED);
  const [payload] = await queued(page);
  expect(payload).toMatchObject({ id, xId: TESTERS.bo.xId, address: made, message: challenge.message });
  expect(await verifyMessage({ address: made, message: challenge.message, signature: payload.signature })).toBe(true);

  // A dry run sends nothing and frees the claim: the card offers it again.
  await receipt(page, id, 'dry-run');
  await expect(line(card).first()).toHaveText('Not sent: a dry run. Claim again later.', { timeout: 30_000 });
  await expect(card.getByRole('button', { name: 'Claim', exact: true })).toBeEnabled();
  await shot(page, testInfo, 'claim-dry-run', card);

  // Export key: Privy's own export of the wallet it made (the stand-in records the ask).
  await card.getByRole('button', { name: 'Export key' }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.standinExport ?? null)).toBe(made);
  // The made wallet comes back on a reload, without a press; this device chose today's steps (and claimed on them), so
  // the card opens on them again (F166 af1: the card remembers the choice), the wallet shown.
  await page.reload();
  await expect(card.locator('dd code')).toHaveAttribute('title', made);
  await expect(card.getByRole('button', { name: 'Set me up' })).toHaveCount(0);
  await expect(card).toContainText('Wallet Privy made');
  expect(escaped.filter((host) => /privy|x\.com|twitter/.test(host))).toEqual([]);
  expect(problems).toEqual([]);
});

test('a way back to the made wallet’s export (XR-ALPHA-SITE af1): after a disconnect, “Sign-in and wallet” leads to the join page, whose export asks Privy on the press', async ({ page }, testInfo) => {
  const { problems } = await alphaContext(page, testInfo, TESTERS.cy);
  const card = await approvedOnTestCoins(page, testInfo, TESTERS.cy);
  await card.getByRole('button', { name: 'Make me a wallet' }).click();
  const shown = card.locator('dd code');
  await expect(shown).toHaveAttribute('title', /^0x[0-9a-fA-F]{40}$/);
  const made = await shown.getAttribute('title');
  // The person lets the wallet go in the top bar's wallet window: the card no longer holds it, nor this device.
  await page.locator('.sh-wallet-button').click();
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: 'Disconnect' }).click();
  await expect(card.getByRole('button', { name: 'Use my wallet' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Export key' })).toHaveCount(0);
  const way = card.getByRole('link', { name: 'Sign-in and wallet' });
  await expect(way).toHaveAttribute('href', '/join');
  await shot(page, testInfo, 'claim-way-back', card);
  await way.click();
  await expect(page).toHaveURL(/\/join$/);
  await expect(page.locator('.sh-join__big')).toHaveText('You’re in.');
  await page.getByRole('button', { name: 'Export wallet key' }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.standinExport ?? null)).toBe(made);
  expect(problems).toEqual([]);
});

test('the card’s link while it asks for Privy’s sign-in again (XR-ALPHA-SITE af3): the join page offers “Sign in with X” at once, and that sign-in comes back there for the export', async ({ page }, testInfo) => {
  const { problems } = await alphaContext(page, testInfo, TESTERS.cy);
  const card = await approvedOnTestCoins(page, testInfo, TESTERS.cy);
  await card.getByRole('button', { name: 'Make me a wallet' }).click();
  const shown = card.locator('dd code');
  await expect(shown).toHaveAttribute('title', /^0x[0-9a-fA-F]{40}$/);
  const made = await shown.getAttribute('title');
  // Privy's sign-in in this browser lapses (the stand-in's own record goes); our 7-day cookie stays.
  await page.evaluate(() => window.localStorage.removeItem('sh.standin.privy.v1'));
  await page.reload();
  const way = card.getByRole('link', { name: 'Sign-in and wallet' });
  await expect(way).toHaveAttribute('href', '/join');
  await card.getByRole('button', { name: 'Export key' }).click();
  await expect(line(card)).toHaveText('Sign in with X again first, then export.');
  await expect(way).toHaveAttribute('href', '/join?then=export');
  await shot(page, testInfo, 'claim-export-signin', card);
  await way.click();
  await expect(page).toHaveURL(/\/join$/);
  await expect(page.locator('.sh-join__big')).toHaveText('You’re in.');
  const again = page.getByRole('button', { name: 'Sign in with X' });
  await expect(again).toBeVisible();
  await shot(page, testInfo, 'join-then-export');
  const session = page.waitForResponse((response) => new URL(response.url()).pathname === '/alpha/session');
  await again.click();
  expect((await session).status()).toBe(200);
  await expect(page).toHaveURL(/\/join$/);
  await expect(page.locator('.sh-join__big')).toHaveText('You’re in.');
  await expect(page.getByRole('button', { name: 'Sign in with X' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Export wallet key' }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.standinExport ?? null)).toBe(made);
  expect(problems).toEqual([]);
});

test('one claim per wallet: another X account on the same device cannot claim a wallet already claimed with', async ({ page }, testInfo) => {
  const { problems } = await alphaContext(page, testInfo, TESTERS.ada);
  const wallet = await browserWallet(page, testInfo);
  let card = await approvedOnTestCoins(page, testInfo, TESTERS.ada);
  await card.getByRole('button', { name: 'Use my wallet' }).click();
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: /Alpha test wallet/ }).click();
  await claimText(page, card);
  expect((await signAndClaim(page, card)).status()).toBe(202);
  await expect(line(card)).toHaveText(QUEUED);

  // Ada signs out; Bo signs in on the same device and the founder lets Bo in too.
  await page.goto('/join');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('Signed out.')).toBeVisible();
  await signInAs(page, testInfo, TESTERS.bo);
  // The browser wallet this device connected comes back by itself (F135): a wallet of the tester's own, so the card goes
  // to today's steps at once (F166).
  card = await approvedOnTestCoins(page, testInfo, TESTERS.bo, { entry: false });
  // The browser wallet this device connected comes back by itself (F135); its claim text is Bo's.
  await expect(card.locator('dd code')).toHaveAttribute('title', wallet.account.address);
  const challenge = await claimText(page, card);
  expect(challenge.message).toContain(`I link my X account @bo_tests (X ID ${TESTERS.bo.xId}) to wallet ${wallet.account.address}.`);
  const refused = await signAndClaim(page, card);
  expect(refused.status()).toBe(409);
  await expect(line(card)).toHaveText('This X account or wallet has claimed already.');
  await shot(page, testInfo, 'claim-refused', card);
  expect((await queued(page)).map((claim) => claim.xId)).toEqual([TESTERS.ada.xId]);
  expect(problems).toEqual([]);
});
