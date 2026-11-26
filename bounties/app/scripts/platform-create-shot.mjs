// Screenshots of the platform's Create page with "Launch on", at 1440 and 390, from a running platform build (the
// BNB Chain testnet profile). Accepts the site's notice the way a visitor does (its button), then shoots the visual
// Create and the steps. Also checks the two links. Nothing is sent anywhere.
// usage: node scripts/platform-create-shot.mjs <base url> <out dir>
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const [base = 'http://127.0.0.1:5471', out = '.'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const result = {};
for (const [name, route] of [
  ['platform-create-visual', '/create/v2-picture'],
  ['platform-create-steps', '/create/v2-basics'],
]) {
  await page.goto(base + route);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const accept = page.getByRole('button', { name: 'Accept', exact: true }).first();
  if (await accept.isVisible().catch(() => false)) {
    const box = page.getByRole('checkbox').first();
    if (await box.isVisible().catch(() => false)) await box.check();
    await accept.click();
    await page.goto(base + route);
  }
  const group = page.getByRole('group', { name: 'Launch on' });
  await group.waitFor({ timeout: 30_000 });
  result[name] = {
    text: (await group.textContent())?.trim(),
    flap: await group.getByRole('link', { name: 'Flap' }).getAttribute('href'),
    four: await group.getByRole('link', { name: 'Four.meme' }).getAttribute('href'),
  };
  for (const [w, h] of [
    [1440, 900],
    [390, 844],
  ]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(out, `${name}-${w}.png`), fullPage: false });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}
console.log(JSON.stringify(result, null, 2));
await browser.close();
