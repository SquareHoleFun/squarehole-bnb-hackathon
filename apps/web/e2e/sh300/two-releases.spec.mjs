/**
 * SH-300: the BNB Chain testnet site with TWO v2 releases (the live one first, then the one whose card shop also takes a
 * ten-minute wait), on a stand (not committed: a fork of chain 97 with lane c's second release replayed onto it, the
 * indexer over it with the two-release manifest, the BNB site on Vite's dev server). Run only with SH300_STAND.
 * - the Boxes list shows boxes of both releases;
 * - the second release's card shop box: its page, the shop's wait in minutes, the buy and sell box;
 * - a first-release box keeps its buy and sell box (with two releases it used to lose it);
 * - Create reads the first release's options and price coins only.
 * Pictures at 1440 and 390.
 */
import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { localChain, problemsReport, tradeBox } from '../alpha-bnb/helpers.mjs';

test.skip(!process.env.SH300_STAND, 'needs the two-release stand (SH300_STAND)');
test.describe.configure({ mode: 'serial' });

const S = { rpcUrl: process.env.SH300_RPC ?? 'http://127.0.0.1:8579' };
const SHOTS = process.env.SH300_SHOTS ?? '/tmp/sh300-shots';
const FIRST = { factory: '0xb954a0db33a6351e76e519b4830489531c39d4f0', registry: '0xf77ef448bbc61d559ee8f657ce3a0b59f1af0daf' };
const SECOND = { factory: '0x5730e48cbc79beeb4983f2da3eac7bef80a59f3b', registry: '0x8b4eefaed20a49b9139881963aa1d4b0825df5d3' };
const feed = () => JSON.parse(readFileSync(process.env.SH300_FEED ?? '', 'utf8'));
const cardsOf = (registry) => feed().cards.filter((c) => String(c.row?.registry).toLowerCase() === registry);
const nameOf = (card) => String(card.row?.spec?.collectionName || card.row?.spec?.tokenName || '');

/** The page reads the test network (not the Demo), its chain routed to the stand's fork (as e2e/alpha-bnb does). */
async function testnet(page) {
  await page.addInitScript(() => window.localStorage.setItem('squarehole.data-source.v1', JSON.stringify({ source: 'sepolia' })));
  await wallet(page);
  return localChain(page, S);
}

/** A browser wallet (EIP-6963) for the stand: an anvil development account; everything but the account and chain is
 * answered by the stand's fork (loopback). */
const ACCOUNT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
async function wallet(page) {
  await page.addInitScript(({ rpc, account }) => {
    let id = 0;
    const provider = {
      async request({ method, params }) {
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [account];
        if (method === 'eth_chainId') return '0x61';
        if (method === 'wallet_revokePermissions' || method === 'wallet_switchEthereumChain') return null;
        const reply = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params ?? [] }) });
        const body = await reply.json();
        if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
        return body.result;
      },
      on() {}, removeListener() {},
    };
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
      detail: Object.freeze({ info: { uuid: '6d2f3c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f', name: 'Stand Wallet', rdns: 'org.example.standwallet', icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=' }, provider }),
    })));
  }, { rpc: S.rpcUrl, account: ACCOUNT });
}
async function connect(page) {
  await page.getByRole('banner').locator('.sh-wallet-button').click();
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: /Stand Wallet/ }).click();
}
/** A quote stands in the box's buy and sell box: an amount typed, "You get ≈ <number>" read from the stand's chain. */
async function quote(page, amount) {
  const box = tradeBox(page);
  await box.getByRole('textbox').first().fill(amount);
  await expect.poll(async () => /You get\s*≈\s*\d/.test(await box.innerText()), { timeout: 120_000 }).toBe(true);
  return (await box.innerText()).replace(/\s+/g, ' ').match(/You get ≈ [^ ]+ [^ ]+/)?.[0];
}
const link = (page, token) => page.locator(`a[href="/box/97/${String(token).toLowerCase()}"]`);

async function both(page, name, check) {
  mkdirSync(SHOTS, { recursive: true });
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await check();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(w);
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(SHOTS, `${name}-${w}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test.afterEach(async ({ page }, info) => { if (info.status !== info.expectedStatus) process.stdout.write(`${problemsReport(page)}\n`); });

test('the Boxes list shows boxes of both releases', async ({ page }) => {
  const first = cardsOf(FIRST.registry);
  const second = cardsOf(SECOND.registry);
  process.stdout.write(`feed: ${first.length} boxes of the first release, ${second.length} of the second (${second.map(nameOf).join(', ')})\n`);
  expect(first.length).toBeGreaterThan(0);
  expect(second.length).toBeGreaterThan(0);
  await testnet(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Boxes', level: 1 })).toBeVisible({ timeout: 120_000 });
  // Each release's box by its own token link (two different cards, never one card matched twice).
  expect(String(first[0].token).toLowerCase()).not.toBe(String(second[0].token).toLowerCase());
  await expect(link(page, second[0].token).first()).toBeVisible({ timeout: 120_000 });
  await expect(link(page, first[0].token).first()).toBeVisible();
  await both(page, 'sh300-boxes', async () => { await expect(link(page, second[0].token).first()).toBeVisible(); });
});

test('the second release\'s card shop box: its page, the wait in minutes, the buy and sell box', async ({ page }) => {
  const box = cardsOf(SECOND.registry)[0];
  await testnet(page);
  await page.goto(`/box/97/${String(box.token).toLowerCase()}`);
  await expect(page.getByRole('heading', { name: nameOf(box) }).first()).toBeVisible({ timeout: 120_000 });
  const shop = page.getByRole('region', { name: 'Shop' });
  await expect(shop).toContainText('10 minutes before a new entry accepts gives.', { timeout: 120_000 });
  await expect(shop).not.toContainText(/0\.00\d+ days/);
  await expect(tradeBox(page)).toBeVisible({ timeout: 120_000 });
  await expect(tradeBox(page)).not.toContainText('Trading is not set up on this chain.');
  await connect(page);
  process.stdout.write(`release-2 box quote: ${await quote(page, '0.01')}\n`);
  process.stdout.write(`release-2 box ${nameOf(box)}: shop says ${(await shop.innerText()).replace(/\s+/g, ' ').slice(0, 300)}\n`);
  await both(page, 'sh300-second-box', async () => { await expect(shop).toBeVisible(); });
});

test('a first-release box keeps its buy and sell box', async ({ page }) => {
  const box = cardsOf(FIRST.registry).find((c) => c.graduated) ?? cardsOf(FIRST.registry)[0];
  await testnet(page);
  await page.goto(`/box/97/${String(box.token).toLowerCase()}`);
  await expect(page.getByRole('heading', { name: nameOf(box) }).first()).toBeVisible({ timeout: 120_000 });
  await expect(tradeBox(page)).toBeVisible({ timeout: 120_000 });
  await expect(tradeBox(page)).not.toContainText('Trading is not set up on this chain.');
  await connect(page);
  process.stdout.write(`release-1 box quote: ${await quote(page, '0.001')}\n`);
  await both(page, 'sh300-first-box', async () => { await expect(tradeBox(page)).toBeVisible(); });
});

test('Create reads the first release\'s options and price coins, never the second\'s', async ({ page }) => {
  await testnet(page);
  const asked = [];
  page.on('request', (r) => { if (/\/v2\/(create-options|listings)\//.test(r.url())) asked.push(new URL(r.url()).pathname); });
  await page.goto('/create');
  await expect.poll(() => asked.some((p) => p.includes(`/v2/create-options/97/${FIRST.factory}`)), { timeout: 120_000 }).toBe(true);
  await expect.poll(() => asked.some((p) => p.includes(`/v2/listings/97/${FIRST.registry}`)), { timeout: 120_000 }).toBe(true);
  await page.waitForTimeout(3_000);
  process.stdout.write(`Create asked: ${[...new Set(asked)].join(' ')}\n`);
  expect(asked.filter((p) => p.includes(SECOND.factory) || p.includes(SECOND.registry))).toEqual([]);
  await both(page, 'sh300-create', async () => { await expect(page.locator('main')).toBeVisible(); });
});

