import { expect, test } from '@playwright/test';
import { installUntouchableWallet, walletTouches } from '../box-helpers';
import { NO_TERMS_ACCEPTANCE, PRODUCTION_TERMS_VERSION } from '../terms-state';
import { evidencePath, noDemoTrace, productionChain } from './production-fixture';
import { productionTarget } from './production-target';

// SH-V2-FE7: a first visit to the production site, with no accepted Terms (the other production specs start accepted):
// the entry gate shows the production Terms (a DRAFT FOR COUNSEL, their own version) with no Demo or test-build line,
// its open items highlighted, then the feed. FE6 pinned the development draft's Demo sentence here; it is gone.
test.use({ storageState: NO_TERMS_ACCEPTANCE });
// The main site's gate. The Sepolia test site's (the test network notice, SH-TA-02) is production-test-network.spec.ts's.
test.skip(productionTarget() === 'sepolia', 'the Sepolia test site shows the test network notice instead');

const GATE = 'Before you enter Square Hole';
const CHECKBOX = 'I have read and agree to the Square Hole Terms of Use, and I confirm that I am at least 18 and not a Restricted User.';
/**
 * The line that replaced the development draft's "Right now this is a demo and test build: …" (terms-production.ts),
 * with the founder's network facts (SH-V2-FE9, F131 R45A): only box 0's mainnet addresses are still open.
 */
const NETWORK_LINE = /^At squarehole\.fun, Square Hole runs on Ethereum mainnet only\. \[FOUNDER: box 0’s mainnet addresses once deployed .*\] The Sepolia test network has a separate test site\. On a test network, tokens have no value and give no right to any future token\.$/;

test('a first visit: the production entry gate (no Demo or test-build line, open items marked), then the feed', async ({ page }, testInfo) => {
  await installUntouchableWallet(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const chain = await productionChain(page);
  await page.goto('/');
  const gate = page.getByRole('dialog', { name: GATE });
  await expect(gate).toBeVisible();
  await expect(page).toHaveTitle('Before you enter · Square Hole');
  await expect(page.locator('.sh-source-badge')).toHaveCount(0);
  await expect(gate).toContainText(`Version ${PRODUCTION_TERMS_VERSION}`);
  await noDemoTrace(page, 'the entry gate');
  const lines = await gate.evaluate((element) => (element as HTMLElement).innerText.split('\n').map((line) => line.trim()));
  expect(lines.filter((line) => /test build|demo data|right now this is/i.test(line))).toEqual([]);
  expect(lines.filter((line) => NETWORK_LINE.test(line))).toHaveLength(1);
  // The two open items (the sign-off and box 0's mainnet addresses) are highlighted, never passed off as final text.
  const marks = await gate.locator('mark').allInnerTexts();
  expect(marks.map((mark) => mark.slice(0, 30))).toEqual(['[FOUNDER + COUNSEL: delete thi', '[FOUNDER: box 0’s mainnet addr']);
  await page.screenshot({ path: evidencePath(testInfo, 'gate'), scale: 'css' });
  await gate.getByRole('checkbox', { name: CHECKBOX }).check();
  await gate.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(gate).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: 'Boxes' })).toBeVisible();
  await noDemoTrace(page, 'the feed after the gate');
  expect(await walletTouches(page)).toEqual([]);
  expect(chain.escaped).toEqual([]);
});
