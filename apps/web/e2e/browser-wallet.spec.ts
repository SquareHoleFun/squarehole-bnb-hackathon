import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

// Stage C browser wallet (UI-09): a fake EIP-6963 wallet records every request and every discovery ping. Loading and
// navigating never discovers or asks it anything; the wallet menu offers the demo wallet only with the demo fixtures
// and browser wallets only on a chain data source (SH-C integration); only opening the browser-wallet window pings
// discovery; only the click on the listed wallet asks for accounts. This build's "Local chain" source is the recorded
// fixture manifest with an RPC where nothing runs (playwright.config.ts); its RPC requests are aborted here, so pages
// show "unavailable" and never data.
//
// F135 (founder 2026-10-11): after this device connected a browser wallet, a load may ping discovery for that one
// wallet and ask it `eth_accounts` and `eth_chainId`, the two methods that never open a wallet window, and show the
// visitor connected again. No account request or other prompting method on navigation, ever; after Disconnect, or
// without that memory, nothing is touched.

const ACCOUNT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const FIXTURE_RPC = 'http://127.0.0.1:8599/**';
/** The only wallet methods a load may use, and only after a remembered connect (F135): neither opens a wallet window. */
const SILENT = new Set(['eth_accounts', 'eth_chainId']);
const REMEMBERED_KEY = 'sh.wallet.connected.v1';

/** Chooses the "Local chain (anvil 31337)" data source before the app loads (as Settings would store it). */
async function chooseLocalChainSource(page: Page) {
  await page.route(FIXTURE_RPC, (route) => route.abort());
  await page.addInitScript(() => window.localStorage.setItem('squarehole.data-source.v1', JSON.stringify({ source: 'local' })));
}

async function installFakeWallet(page: Page, chainIdHex = '0x7a69') {
  await page.addInitScript(
    ({ account, chainIdHex }) => {
      const calls: string[] = [];
      const pings: number[] = [];
      Object.defineProperty(window, '__walletCalls', { value: calls });
      Object.defineProperty(window, '__walletPings', { value: pings });
      // A wallet keeps its site permission across reloads; `__fakeWalletRevoked` stands for the visitor revoking it there.
      const revoked = () => window.localStorage.getItem('__fakeWalletRevoked') === '1';
      const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
      const provider = {
        async request({ method }: { method: string }) {
          calls.push(method);
          if (method === 'eth_accounts') return revoked() ? [] : [account];
          if (method === 'eth_requestAccounts') return [account];
          if (method === 'eth_chainId') return chainIdHex;
          if (method === 'wallet_revokePermissions') return null;
          throw Object.assign(new Error('fake wallet: unsupported'), { code: 4200 });
        },
        on(event: string, listener: (...args: unknown[]) => void) {
          const set = listeners.get(event) ?? new Set();
          set.add(listener);
          listeners.set(event, set);
        },
        removeListener(event: string, listener: (...args: unknown[]) => void) {
          listeners.get(event)?.delete(listener);
        },
      };
      window.addEventListener('eip6963:requestProvider', () => {
        pings.push(Date.now());
        window.dispatchEvent(
          new CustomEvent('eip6963:announceProvider', {
            detail: Object.freeze({
              info: { uuid: '350670db-19fa-4704-a166-e52e178b59d2', name: 'E2E Test Wallet', rdns: 'org.example.e2ewallet', icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiByeD0iNiIgZmlsbD0iIzdjNWNmZiIvPjwvc3ZnPg==' },
              provider,
            }),
          }),
        );
      });
    },
    { account: ACCOUNT, chainIdHex },
  );
}

const calls = (page: Page) => page.evaluate(() => [...(window as unknown as { __walletCalls: string[] }).__walletCalls]);
const pings = (page: Page) => page.evaluate(() => (window as unknown as { __walletPings: number[] }).__walletPings.length);
const walletButton = (page: Page) => page.getByRole('banner').locator('.sh-wallet-button');

async function evidence(page: Page, testInfo: TestInfo, name: string) {
  const file =
    process.env.SH_EVIDENCE_SCREENSHOTS === '1'
      ? fileURLToPath(new URL(`../../../docs/evidence/screenshots/SH-C-${name}-${testInfo.project.name}.png`, import.meta.url))
      : testInfo.outputPath(`SH-C-${name}-${testInfo.project.name}.png`);
  await page.screenshot({ path: file });
}

for (const source of ['demo', 'local'] as const) {
  test(`UI-09: browsing never pings discovery or asks the browser wallet anything (${source} data source)`, async ({ page }) => {
    await installFakeWallet(page);
    if (source === 'local') await chooseLocalChainSource(page);
    // /rewards and /portfolio are old links now (F134 R46B): they open My Box, still without a wallet request.
    for (const route of ['/', '/my-box', '/rewards', '/portfolio', '/launch', '/settings']) {
      await page.goto(route);
      await expect(page.locator('h1')).toBeVisible();
    }
    expect(await pings(page)).toBe(0);
    expect(await calls(page)).toEqual([]);
  });
}

test('the wallet menu offers the sample wallet only on the sample data, and browser wallets only on a chain source', async ({ page }) => {
  await installFakeWallet(page);
  await page.goto('/my-box');
  await walletButton(page).click();
  const demo = page.getByRole('dialog', { name: 'Sample wallet' });
  await expect(demo).toBeVisible();
  await expect(demo.getByRole('button', { name: 'Use a browser wallet instead' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  expect(await pings(page)).toBe(0);

  await chooseLocalChainSource(page);
  await page.goto('/my-box');
  await expect(page.getByRole('banner')).toContainText('Local chain 31337');
  await walletButton(page).click();
  const chooser = page.getByRole('dialog', { name: 'Connect a browser wallet' });
  await expect(chooser).toBeVisible();
  await expect(chooser.getByRole('button', { name: /Sample wallet/ })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Sample wallet' })).toHaveCount(0);
});

test('connect a browser wallet on the local chain source: pick the wallet → connected → disconnect', async ({ page }, testInfo) => {
  await installFakeWallet(page);
  await chooseLocalChainSource(page);
  await page.goto('/my-box');
  await expect(page.locator('h1')).toBeVisible();
  expect(await pings(page)).toBe(0);
  await walletButton(page).click();
  const chooser = page.getByRole('dialog', { name: 'Connect a browser wallet' });
  await expect(chooser).toBeVisible();
  const row = chooser.getByRole('button', { name: /E2E Test Wallet/ });
  await expect(row).toBeVisible();
  expect(await pings(page)).toBeGreaterThan(0);
  expect(await calls(page)).toEqual([]);
  await evidence(page, testInfo, 'browser-wallet-chooser');
  await row.click();
  await expect(chooser).toHaveCount(0);
  await expect(walletButton(page)).toHaveAccessibleName('E2E Test Wallet 0x7099…79C8');
  expect(await calls(page)).toEqual(['eth_requestAccounts', 'eth_chainId']);
  // Disconnect from the browser-wallet window.
  await walletButton(page).click();
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: 'Disconnect' }).click();
  await expect(walletButton(page)).toHaveAccessibleName('Connect wallet');
  await expect.poll(() => calls(page)).toContain('wallet_revokePermissions');
});

test('a browser wallet on another network is marked "wrong network" in the top bar', async ({ page }) => {
  await installFakeWallet(page, '0xaa36a7');
  await chooseLocalChainSource(page);
  await page.goto('/');
  await walletButton(page).click();
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: /E2E Test Wallet/ }).click();
  await expect(walletButton(page)).toHaveAccessibleName('E2E Test Wallet 0x7099…79C8, wrong network');
  await walletButton(page).click();
  await expect(page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: 'Switch to Local anvil chain (31337)' })).toBeVisible();
});

/** Connects the fake wallet through the chooser (the person's click), on the local chain source. */
async function connectFakeWallet(page: Page) {
  await walletButton(page).click();
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: /E2E Test Wallet/ }).click();
  await expect(walletButton(page)).toHaveAccessibleName('E2E Test Wallet 0x7099…79C8');
  expect(await calls(page)).toEqual(['eth_requestAccounts', 'eth_chainId']);
}

const prompting = (methods: readonly string[]) => methods.filter((method) => !SILENT.has(method));

test('F135: a refresh keeps the browser wallet connected, asking only eth_accounts and eth_chainId; navigation never prompts', async ({ page }) => {
  await installFakeWallet(page);
  await chooseLocalChainSource(page);
  await page.goto('/my-box');
  await expect(page.locator('h1')).toBeVisible();
  await connectFakeWallet(page);
  expect(JSON.parse((await page.evaluate((key) => window.localStorage.getItem(key), REMEMBERED_KEY)) ?? 'null')).toEqual({ provider: 'eip6963:org.example.e2ewallet', address: ACCOUNT });

  await page.reload();
  await expect(walletButton(page)).toHaveAccessibleName('E2E Test Wallet 0x7099…79C8');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await calls(page)).toEqual(['eth_accounts', 'eth_chainId']);
  expect(await pings(page)).toBeGreaterThan(0);

  // Navigation inside the page, then whole new loads: still connected, never an account request or another prompt.
  const nav = page.getByRole('navigation', { name: 'Primary' });
  const menu = page.getByRole('button', { name: 'Menu' });
  for (const name of ['Settings', 'About & risks', 'Boxes', 'My Box']) {
    if (await menu.isVisible()) await menu.click();
    await nav.getByRole('link', { name, exact: true }).click();
    await expect(page.locator('h1')).toBeVisible();
    await expect(walletButton(page), name).toHaveAccessibleName('E2E Test Wallet 0x7099…79C8');
  }
  expect(prompting(await calls(page))).toEqual([]);
  for (const route of ['/', '/settings', '/create', '/box/31337/0x000000000000000000000000000000000000f17e']) {
    await page.goto(route);
    await expect(page.locator('h1')).toBeVisible();
    await expect(walletButton(page), route).toHaveAccessibleName('E2E Test Wallet 0x7099…79C8');
    expect(prompting(await calls(page)), route).toEqual([]);
  }
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('F135: after Disconnect a refresh does not touch the wallet: no discovery, no request', async ({ page }) => {
  await installFakeWallet(page);
  await chooseLocalChainSource(page);
  await page.goto('/my-box');
  await connectFakeWallet(page);
  await walletButton(page).click();
  await page.getByRole('dialog', { name: 'Connect a browser wallet' }).getByRole('button', { name: 'Disconnect' }).click();
  await expect(walletButton(page)).toHaveAccessibleName('Connect wallet');
  expect(await page.evaluate((key) => window.localStorage.getItem(key), REMEMBERED_KEY)).toBeNull();
  for (const route of ['/my-box', '/', '/settings']) {
    await page.goto(route);
    await expect(page.locator('h1')).toBeVisible();
    await page.waitForTimeout(300);
    expect(await calls(page), route).toEqual([]);
    expect(await pings(page), route).toBe(0);
    await expect(walletButton(page), route).toHaveAccessibleName('Connect wallet');
  }
});

test('F135: a wallet that shares no account (locked, or the site revoked there) stays disconnected; later loads ask it silently, and reconnect once it shares again', async ({ page }) => {
  await installFakeWallet(page);
  await chooseLocalChainSource(page);
  await page.goto('/my-box');
  await connectFakeWallet(page);
  // The wallet stops sharing accounts (the fake answers eth_accounts with none, as a locked or revoked wallet does).
  await page.evaluate(() => window.localStorage.setItem('__fakeWalletRevoked', '1'));
  for (let load = 0; load < 2; load += 1) {
    await page.reload();
    await expect(page.locator('h1')).toBeVisible();
    await expect.poll(() => calls(page)).toEqual(['eth_accounts']);
    await expect(walletButton(page)).toHaveAccessibleName('Connect wallet');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  // The memory stays (a locked wallet is not a Disconnect): once the wallet shares the address again, a load reconnects.
  expect(await page.evaluate((key) => window.localStorage.getItem(key), REMEMBERED_KEY)).not.toBeNull();
  await page.evaluate(() => window.localStorage.removeItem('__fakeWalletRevoked'));
  await page.reload();
  await expect(walletButton(page)).toHaveAccessibleName('E2E Test Wallet 0x7099…79C8');
  expect(await calls(page)).toEqual(['eth_accounts', 'eth_chainId']);
});
