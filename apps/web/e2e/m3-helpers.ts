import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';

// The picker offers Never held and the two box wallets (SH-V2-FE11); the old pairs' holders stay for the skipped legacy specs.
export type Persona = 'Current holder' | 'Past holder' | 'Never held' | 'Box wallet A' | 'Box wallet B';

/** A fake injected wallet whose every property READ is recorded (UI-09: the sample wallet never touches it). */
/** UI-09 with F135: no browser wallet is remembered in these specs, so loading and navigating touch no wallet at all. */
export async function installUntouchableWallet(page: Page) {
  await page.addInitScript(() => {
    const touches: string[] = [];
    Object.defineProperty(window, '__walletTouches', { value: touches });
    const provider = new Proxy(
      {},
      {
        get(_target, key) {
          touches.push(`provider.${String(key)}`);
          return () => Promise.reject(new Error('untouchable wallet'));
        },
      },
    );
    Object.defineProperty(window, 'ethereum', {
      configurable: true,
      get() {
        touches.push('window.ethereum');
        return provider;
      },
    });
  });
}

export const walletTouches = (page: Page) => page.evaluate(() => [...(window as unknown as { __walletTouches: string[] }).__walletTouches]);

export const main = (page: Page) => page.getByRole('main');
export const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Connects through the page's own "Connect wallet" button (or the top bar when `via` is 'banner'). */
export async function connectAs(page: Page, persona: Persona, { wrongNetwork = false, via = 'main' as 'main' | 'banner' } = {}) {
  const opener =
    via === 'main'
      ? main(page).getByRole('button', { name: 'Connect wallet' })
      : page.getByRole('banner').getByRole('button', { name: /wallet/i });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Sample wallet' });
  await dialog.getByRole('radio', { name: persona }).check();
  const check = dialog.getByRole('checkbox', { name: 'Simulate wrong network' });
  if ((await check.isChecked()) !== wrongNetwork) await check.click();
  await dialog.getByRole('button', { name: /^(Connect|Update) sample wallet$/ }).click();
  await expect(dialog).toHaveCount(0);
}

export async function disconnect(page: Page) {
  await page.getByRole('banner').getByRole('button', { name: /^Wallet 0x/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Disconnect' }).click();
}

export const card = (page: Page, name: string): Locator =>
  main(page).locator('article').filter({ has: page.getByRole('heading', { level: 3, name: new RegExp(`^${name}\\b`) }) });
export const figure = (scope: Locator, name: string) => scope.locator(`[data-figure="${name}"] dd`);
export const claimButton = (scope: Locator) => scope.getByTestId('claim-button');
export const txPanel = (scope: Locator) => scope.locator('[data-tx-status]');

export async function chooseScenario(page: Page, label: string) {
  await main(page).getByRole('combobox', { name: 'Scenario' }).selectOption({ label });
}

/**
 * Records every `data-tx-status` value a claim card's panel takes (a MutationObserver in the page), so short states
 * such as a reorg's return to pending are captured even if a poll would miss them.
 */
export async function recordStatuses(page: Page, pairId: string) {
  await page.evaluate((id) => {
    const seen: string[] = [];
    Object.defineProperty(window, '__txStatuses', { value: seen, configurable: true });
    const push = () => {
      const panel = document.querySelector(`article[data-pair-id="${id}"] [data-tx-status]`);
      const status = panel?.getAttribute('data-tx-status') ?? 'idle';
      if (seen[seen.length - 1] !== status) seen.push(status);
    };
    push();
    new MutationObserver(push).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-tx-status'] });
  }, pairId);
}

export const recordedStatuses = (page: Page) => page.evaluate(() => [...(window as unknown as { __txStatuses: string[] }).__txStatuses]);

/** Saves a screenshot: into docs/evidence/screenshots with SH_EVIDENCE_SCREENSHOTS=1, else into the test output. */
export async function evidence(page: Page, testInfo: TestInfo, name: string, options: { fullPage?: boolean; locator?: Locator; style?: string } = {}) {
  const suffix = testInfo.project.name === 'desktop' ? '' : `-${testInfo.project.name}`;
  const fileName = `${name}${suffix}.png`;
  const path =
    process.env.SH_EVIDENCE_SCREENSHOTS === '1'
      ? fileURLToPath(new URL(`../../../docs/evidence/screenshots/${fileName}`, import.meta.url))
      : testInfo.outputPath(fileName);
  if (options.locator) await options.locator.screenshot({ path, style: options.style });
  else await page.screenshot({ path, fullPage: options.fullPage ?? false });
}

export const ORCHARD_ID = '31337:0x0000000000000000000000000000000000000066';
export const FRAMES_ID = '31337:0x000000000000000000000000000000000000006a';
export const ROUND_ID = '31337:0x0000000000000000000000000000000000000067';
