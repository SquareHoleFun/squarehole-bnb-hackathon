// The built page as the site serves it: under a sub-path (`vite preview` of a `PILE_BASE=/launches/` build), opened
// at `/launches/` and a sale's address; lists every origin the page contacted and checks the
// built index.html for inline script or style. Reads the real chain (read only); nothing is sent.
// usage: node scripts/served-check.mjs <origin> <base> <launcher> [out dir for screenshots]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const [origin = 'http://127.0.0.1:5471', base = '/launches/', launcher, out] = process.argv.slice(2);
const html = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '../dist/index.html'), 'utf8');
const inlineScript = /<script(?![^>]*\bsrc=)[^>]*>/i.test(html);
const inlineStyle = /<style[\s>]/i.test(html) || /\sstyle=/i.test(html);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const origins = new Set();
const failed = [];
page.on('request', (r) => origins.add(new URL(r.url()).origin));
page.on('requestfailed', (r) => failed.push(r.url()));
const visit = async (url, testId, text) => {
  await page.goto(origin + url);
  await page.getByTestId(testId).first().waitFor({ timeout: 60_000 });
  if (text) await page.getByTestId(testId).first().filter({ hasText: text }).waitFor({ timeout: 60_000 });
};
await visit(base, 'sale-line', 'Launched');
await visit(`${base}#/flap/${launcher}`, 'sale-phase', 'Launched');
await page.getByTestId('pile-size').waitFor({ timeout: 60_000 });
if (out) {
  fs.mkdirSync(out, { recursive: true });
  await page.screenshot({ path: path.join(out, 'served-launches-sale-1440.png'), fullPage: false });
}
const result = {
  indexHtmlInlineScript: inlineScript,
  indexHtmlInlineStyle: inlineStyle,
  originsContacted: [...origins].sort(),
  failedRequests: failed,
};
console.log(JSON.stringify(result, null, 2));
await browser.close();
process.exit(inlineScript || inlineStyle ? 1 : 0);
