import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// SH-281 step 3: a Flap rules launch whose rules pay the creator's stake, on lane f's stake stand
// (scripts/rules-holders-fork.sh): the rules panel names the stake "Holders" (proven on chain against the deployment
// file's stake factory), the other payee stays "Paid to <address>"; the holders panel names the sale's coin as the
// page does; the two panels do not overlap at 1440 and 390.
const here = path.dirname(fileURLToPath(import.meta.url));
const stand = JSON.parse(fs.readFileSync(path.join(here, '../public/local/holders.json'), 'utf8')) as { launcher: string; stake: string };
const SHOTS = process.env.PILE_SHOTS ?? path.join(here, '../../../hackathon/evidence/SH-281');

test('the rules panel names the stake "Holders", the holders panel says the page\'s coin, no overlap', async ({ page }) => {
  test.setTimeout(180_000);
  for (const [w, h] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`/?addresses=local/addresses.json#/flap/${stand.launcher}`);
    const rules = page.getByTestId('rules-panel');
    const holders = page.getByTestId('holders-panel');
    await expect(rules).toBeVisible({ timeout: 90_000 });
    await expect(holders).toBeVisible({ timeout: 90_000 });
    // the stand's rules: a payee that is not the sale's creator 10%, pile 30%, the creator's stake 40%, buy back 20%
    await expect(rules.locator('[data-testid$="-name"]')).toHaveText(['Paid to', 'Pile', 'Holders', 'Buy back and burn'], { timeout: 30_000 });
    await expect(holders.locator('[data-testid="holders-paying"], [data-testid="holders-leftover"]').locator('.amount').first()).toHaveAttribute('title', / USDT \(test\)$/);
    const a = (await rules.boundingBox())!;
    const b = (await holders.boundingBox())!;
    const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    console.log(`LOOK ${w}: rules ${JSON.stringify(a)} holders ${JSON.stringify(b)} overlap ${overlap}`);
    expect(overlap).toBe(false);
    await page.screenshot({ path: path.join(SHOTS, `rules-with-holders-${w}.png`), fullPage: true });
  }
});
