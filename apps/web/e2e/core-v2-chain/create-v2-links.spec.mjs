// LINKS-WEB 8 (docs/design/box-links-v2.md § 7): on the local chain, the page creates a box with links typed in the
// Create draft, the creator signs them once after Create, and the box page shows them after a reload; the creator's
// Edit links changes them with a second signature; a second account sees no Edit; no navigation asks a wallet.
// The suite runs its files in name order and core-v2-art / core-v2-live count the nine example boxes, so this spec
// (which adds a box) is named create-v2-links, after them, rather than box-links.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { hashTypedData, recoverTypedDataAddress } from 'viem';
import { makePng } from '../../../../packages/artwork/src/test-support/images.ts';
import { ROOT, rpc } from '../../../../packages/chain/scripts/lib/core-v2-local-runtime.mjs';
import { sha256Hex, writeExampleArt } from '../../../../packages/chain/scripts/lib/core-v2-local-example-art.mjs';
import { boxLinksDigest } from '../../../../packages/chain/src/core/v2/box-links-v2.ts';
import { TERMS_ACCEPTED } from '../terms-state.ts';
import { boxPath, decoded, description, read, testWallet } from './helpers.mjs';

test.describe.configure({ mode: 'serial' });
const SHOTS = join(ROOT, '.cache/core-v2-local/links-web');
// The stack's catalogue for pictures a page-created box commits (scripts/dev-core-v2-local.mjs, --e2e).
const CREATED_ART = join(ROOT, '.cache/core-v2-local/run/created-art');
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
/** The same view at 1280 px and 390 px (the evidence's two widths), back at 1280 px afterwards. */
async function shots(page, name) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}-1280.png`), fullPage: true });
  await page.setViewportSize(PHONE);
  await page.screenshot({ path: join(SHOTS, `${name}-390.png`), fullPage: true });
  await page.setViewportSize(DESKTOP);
}
const PROMPTING = ['eth_requestAccounts', 'eth_sendTransaction', 'eth_signTypedData_v4', 'wallet_switchEthereumChain', 'wallet_addEthereumChain'];

/**
 * The helpers' test wallet (its one unlocked local account, zero-value box calls only), which also signs EIP-712 for that
 * account: the anvil node signs it, nothing leaves the machine. Every signature request is recorded with its typed data.
 */
async function signingWallet(page, chain) {
  const wallet = await testWallet(page, chain, { create: true });
  const typed = []; const signatures = []; const posts = [];
  await page.exposeFunction('linksLocalSign', async ({ params = [] }) => {
    wallet.requests.push('eth_signTypedData_v4');
    const [from, text] = params;
    if (typeof from !== 'string' || from.toLowerCase() !== chain.accounts.actor.toLowerCase() || typeof text !== 'string') throw new Error('the links test wallet signs only for its one account');
    typed.push(JSON.parse(text));
    const signature = await rpc(chain.rpcUrl, 'eth_signTypedData_v4', [from, text]);
    signatures.push(signature);
    return signature;
  });
  // Every links POST the page sends, as the indexer receives it.
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/v2\/boxes\/[0-9]+\/0x[0-9a-fA-F]{40}\/links$/.test(request.url())) posts.push({ url: request.url(), type: request.headers()['content-type'], body: JSON.parse(request.postData() ?? 'null') });
  });
  await page.addInitScript(() => {
    const provider = window.coreV2TestWallet;
    const forward = provider.request;
    provider.request = (request) => (request.method === 'eth_signTypedData_v4' ? window.linksLocalSign(request) : forward(request));
  });
  return { ...wallet, typed, signatures, posts };
}

/** A second visitor's wallet: another local account; it can connect, and answers nothing that signs or sends. */
async function viewerWallet(page, chain, account) {
  const requests = [];
  await page.exposeFunction('linksViewerRequest', async ({ method }) => {
    requests.push(method);
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
    if (method === 'eth_chainId') return rpc(chain.rpcUrl, 'eth_chainId');
    throw new Error(`the viewer wallet does not answer ${method}`);
  });
  await page.addInitScript(() => {
    const provider = { request: (request) => window.linksViewerRequest(request), on() {}, removeListener() {} };
    window.localStorage.setItem('squarehole.data-source.v1', JSON.stringify({ source: 'local' }));
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
      detail: { info: { uuid: '6b0f2ad8-4c3e-4b8e-9d55-8b2f0c1a7e11', name: 'Local viewer wallet', rdns: 'org.example.core-v2-viewer', icon: 'data:image/svg+xml;base64,PHN2Zy8+' }, provider },
    })));
  });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (route) => route.abort());
  return requests;
}

async function connectToCreate(page) {
  await page.getByRole('button', { name: 'Connect to create' }).click();
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: 'Local v2 test wallet' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

/** The row's links: text, target and the exact attributes LINKS-WEB 2 pins. */
async function expectRow(row, expected) {
  await expect(row).toHaveText(expected.map((link) => link.text).join(' · '));
  const anchors = row.getByRole('link');
  await expect(anchors).toHaveCount(expected.length);
  for (const [index, link] of expected.entries()) {
    const anchor = anchors.nth(index);
    await expect(anchor).toHaveText(link.text);
    await expect(anchor).toHaveAttribute('href', link.href);
    await expect(anchor).toHaveAttribute('title', link.href);
    await expect(anchor).toHaveAttribute('target', '_blank');
    await expect(anchor).toHaveAttribute('rel', 'noopener noreferrer nofollow ugc');
    await expect(anchor).toHaveAttribute('referrerpolicy', 'no-referrer');
  }
}

/** The EIP-712 object the page asked to sign: the pinned domain and types, this box, and the digest the server checks. */
async function expectTyped(typed, chain, token, links) {
  expect(typed.domain).toEqual({ name: 'Square Hole', version: '1', chainId: chain.chainId });
  expect(typed.primaryType).toBe('BoxLinks');
  expect(Object.keys(typed.types)).toEqual(['EIP712Domain', 'BoxLinks']);
  expect(typed.types.BoxLinks.map((field) => `${field.name}:${field.type}`)).toEqual(['token:address', 'website:string', 'x:string', 'telegram:string', 'issuedAt:uint64']);
  expect(typed.message.token.toLowerCase()).toBe(token.toLowerCase());
  expect(typed.message).toMatchObject(links);
  expect(typed.message.issuedAt).toMatch(/^[1-9][0-9]*$/);
  const typedBig = { ...typed, domain: { ...typed.domain, chainId: BigInt(typed.domain.chainId) }, message: { ...typed.message, issuedAt: BigInt(typed.message.issuedAt) } };
  expect(hashTypedData(typedBig)).toBe(boxLinksDigest(chain.chainId, token, links, typed.message.issuedAt));
  return BigInt(typed.message.issuedAt);
}

test('LINKS-WEB 8 create with links, sign once, see them after a reload; Edit for the creator only; no wallet request on navigation', async ({ page, browser }) => {
  page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
  const chain = description();
  const gateway = `http://127.0.0.1:${chain.ports.gatewayPort}`;
  const wallet = await signingWallet(page, chain);
  await page.setViewportSize(DESKTOP);
  const registry = await read(chain, 'BoxFactoryV2', chain.factory, 'registry');
  const before = await read(chain, 'BoxRegistryV2', registry, 'boxCount');

  // 1. A token box priced in ETH, its three links typed on Basics (under "Links"), in the forms people paste.
  await page.goto('/create/v2-basics');
  await page.getByRole('group', { name: /^Priced in/ }).getByRole('radio', { name: /^ETH\b/ }).check();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Local Links');
  await page.getByRole('textbox', { name: 'Ticker' }).fill('LINKS');
  await page.locator('#create-logo').setInputFiles({ name: 'links.png', mimeType: 'image/png', buffer: Buffer.from(makePng({ width: 512, height: 512, decodable: true })) });
  await expect(page.locator('#create-logo-action')).toHaveText('Change');
  await page.locator('summary').filter({ hasText: /^Links/ }).click();
  await page.getByRole('textbox', { name: 'Website' }).fill('https://made.fun/');
  await page.getByRole('textbox', { name: 'X', exact: true }).fill('@made_box');
  await page.getByRole('textbox', { name: 'Telegram' }).fill('https://t.me/made_box');
  const next = () => page.getByRole('button', { name: 'Next', exact: true }).click();
  await next(); await page.getByRole('radio', { name: /^Token/ }).check();
  await next(); await next(); await next();
  await page.getByRole('checkbox', { name: 'I hold the rights. No impersonation.' }).check(); await next();
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Launch a box, step 6 of 6: Overview');
  expect(wallet.requests, 'navigation never asks the wallet').toEqual([]);

  // The creator publishes the logo the page processed (the BoxSpec file carries it); here the local gateway serves it.
  const logo = Buffer.from(await page.evaluate(async () => {
    const { currentDraft } = await import('/src/features/create/draft.ts');
    return currentDraft().cover?.data ?? '';
  }), 'base64');
  writeExampleArt(CREATED_ART, 'links', [{ role: 'logo', sha256: sha256Hex(logo), bytes: logo }]);

  // 2. Create through the page's own buttons.
  await connectToCreate(page);
  await expect(page.locator('[data-links-card]'), 'no card before the box exists').toHaveCount(0);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('[data-create-status]')).toHaveText(/^Created · (\d+)\/\1$/, { timeout: 120_000 });
  expect(await read(chain, 'BoxRegistryV2', registry, 'boxCount')).toBe(before + 1n);
  expect(wallet.sent.map((tx) => { try { return decoded('BoxFactoryV2', tx).functionName; } catch { return 'other'; } })).toContain('createBox');
  const coordinator = await read(chain, 'BoxRegistryV2', registry, 'coordinatorOf', [before]);
  expect((await read(chain, 'BoxCoordinatorV2', coordinator, 'creator')).toLowerCase()).toBe(chain.accounts.actor.toLowerCase());
  const token = await read(chain, 'BoxCoordinatorV2', coordinator, 'token');

  // 3. The links step: the draft's links read-only (canonical forms), and one signature for them.
  const card = page.locator('[data-links-card]');
  const links = { website: 'https://made.fun', x: 'made_box', telegram: 'made_box' };
  await expectRow(card.locator('.sh-v2-links'), [
    { text: 'made.fun', href: 'https://made.fun' }, { text: '@made_box', href: 'https://x.com/made_box' }, { text: 't.me/made_box', href: 'https://t.me/made_box' },
  ]);
  await expect(card.getByRole('textbox')).toHaveCount(0);
  expect(wallet.requests.filter((method) => method === 'eth_signTypedData_v4'), 'nothing signed before the click').toEqual([]);
  await card.scrollIntoViewIfNeeded();
  await shots(page, 'links-step');
  await card.getByRole('button', { name: 'Sign links · free' }).click();
  await expect(card.locator('[data-links-status="saved"]')).toHaveText('Saved', { timeout: 90_000 });
  expect(wallet.typed).toHaveLength(1);
  const firstAt = await expectTyped(wallet.typed[0], chain, token, links);
  expect(await recoverTypedDataAddress({ ...wallet.typed[0], domain: { ...wallet.typed[0].domain, chainId: BigInt(chain.chainId) }, message: { ...wallet.typed[0].message, issuedAt: firstAt },
    signature: wallet.signatures[0] })).toBe(chain.accounts.actor);
  // One POST (the box was in the feed by then), text/plain, exactly the five strings, the wallet's own signature.
  expect(wallet.posts).toHaveLength(1);
  expect(wallet.posts[0]).toEqual({ url: `${gateway}/v2/boxes/${chain.chainId}/${token.toLowerCase()}/links`, type: 'text/plain', body: { ...links, issuedAt: firstAt.toString(), signature: wallet.signatures[0] } });
  const kept = await (await fetch(`${gateway}/v2/boxes/${chain.chainId}/${token.toLowerCase()}/links`)).json();
  expect(kept).toMatchObject({ schema: 'sh.box-links.v1', chainId: chain.chainId, token: token.toLowerCase(), creator: chain.accounts.actor.toLowerCase(),
    record: { ...links, issuedAt: firstAt.toString(), signerKind: 'eoa' } });
  await shots(page, 'links-step-saved');

  // 4. The box page after a reload: the row under the header, from the feed; Edit links for the creator.
  await page.getByRole('link', { name: 'Open your box' }).click();
  await expect(page).toHaveURL(new RegExp(`${boxPath(chain, token)}$`));
  const atNavigation = wallet.requests.length;
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Local Links', { timeout: 30_000 });
  const row = page.locator('.sh-v2-page .sh-v2-links');
  await expectRow(row, [
    { text: 'made.fun', href: 'https://made.fun' }, { text: '@made_box', href: 'https://x.com/made_box' }, { text: 't.me/made_box', href: 'https://t.me/made_box' },
  ]);
  expect(await row.evaluate((node) => getComputedStyle(node).overflowWrap)).toBe('anywhere');
  expect(await row.locator('a').first().evaluate((node) => [getComputedStyle(node).textOverflow, getComputedStyle(node).whiteSpace])).toEqual(['clip', 'normal']);
  // The connected creator, reconnected after the reload without opening the wallet (F135: `eth_accounts` and
  // `eth_chainId` only), sees Edit links; loading asked nothing that prompts.
  const edit = page.getByRole('button', { name: 'Edit links' });
  const resumed = await edit.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false);
  const onLoad = wallet.requests.slice(atNavigation);
  expect(onLoad.filter((method) => PROMPTING.includes(method)), 'navigation never prompts the wallet').toEqual([]);
  for (const method of onLoad) expect(['eth_accounts', 'eth_chainId']).toContain(method);
  if (!resumed) {
    await page.getByRole('button', { name: /^Connect wallet/ }).first().click();
    await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: 'Local v2 test wallet' }).click();
  }
  await expect(edit).toBeVisible();
  await expect(page.getByRole('main')).not.toContainText(/\b(verified|trusted|official)\b/i);
  await shots(page, 'box-page-links');

  // 5. The creator's edit form: the saved links in it; removing Telegram signs a second record, newer than the first.
  await edit.click();
  const editor = page.locator('[data-links-editor]');
  await expect(editor.getByRole('textbox', { name: 'Website' })).toHaveValue('https://made.fun');
  await expect(editor.getByRole('textbox', { name: 'X', exact: true })).toHaveValue('@made_box');
  await expect(editor.getByRole('textbox', { name: 'Telegram' })).toHaveValue('t.me/made_box');
  await shots(page, 'edit-form');
  await editor.getByRole('textbox', { name: 'Telegram' }).fill('');
  await editor.getByRole('button', { name: 'Sign links · free' }).click();
  await expect(editor).toHaveCount(0, { timeout: 90_000 });
  await expectRow(row, [{ text: 'made.fun', href: 'https://made.fun' }, { text: '@made_box', href: 'https://x.com/made_box' }]);
  expect(wallet.typed).toHaveLength(2);
  const secondAt = await expectTyped(wallet.typed[1], chain, token, { ...links, telegram: '' });
  expect(secondAt > firstAt).toBe(true);
  expect(wallet.posts.map((post) => post.body.signature)).toEqual(wallet.signatures);
  await page.reload();
  await expectRow(page.locator('.sh-v2-page .sh-v2-links'), [{ text: 'made.fun', href: 'https://made.fun' }, { text: '@made_box', href: 'https://x.com/made_box' }]);
  expect((await (await fetch(`${gateway}/v2/boxes/${chain.chainId}/${token.toLowerCase()}/links`)).json()).record).toMatchObject({ ...links, telegram: '', issuedAt: secondAt.toString() });

  // 6. A second account, in its own browser: the links show; no Edit or Add links, before or after it connects.
  const other = await browser.newContext({ storageState: TERMS_ACCEPTED, viewport: DESKTOP });
  try {
    const viewer = await other.newPage();
    const requests = await viewerWallet(viewer, chain, chain.accounts.backup);
    await viewer.goto(boxPath(chain, token));
    await expect(viewer.getByRole('heading', { level: 1 })).toHaveText('Local Links', { timeout: 30_000 });
    await expectRow(viewer.locator('.sh-v2-page .sh-v2-links'), [{ text: 'made.fun', href: 'https://made.fun' }, { text: '@made_box', href: 'https://x.com/made_box' }]);
    expect(requests, 'navigation never touches the wallet').toEqual([]);
    await viewer.getByRole('button', { name: /^Connect wallet/ }).first().click();
    await viewer.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: 'Local viewer wallet' }).click();
    await expect(viewer.getByRole('dialog')).toHaveCount(0);
    expect(requests).toContain('eth_requestAccounts');
    await expect(viewer.getByRole('button', { name: 'Edit links' })).toHaveCount(0);
    await expect(viewer.getByRole('button', { name: 'Add links' })).toHaveCount(0);
    const connected = requests.length;
    await viewer.reload();
    await expect(viewer.locator('.sh-v2-page .sh-v2-links')).toHaveText('made.fun · @made_box');
    await expect(viewer.getByRole('button', { name: 'Edit links' })).toHaveCount(0);
    expect(requests.slice(connected).filter((method) => PROMPTING.includes(method))).toEqual([]);
  } finally {
    await other.close();
  }
});
