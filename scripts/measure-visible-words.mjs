// Visible-word counter for a page of the web app (text-diet evidence, docs/evidence/SH-V2-misfits-text-diet.md).
// Serves a built dist folder through Playwright request interception (no port is opened, nothing else is fetched),
// loads the page with the Demo data at 1440x900 and 390x844 (Pixel 7), and counts the words a reader sees at first
// load: rendered text nodes only, excluding closed <details>, [hidden] info panels, display:none / visibility:hidden,
// visually hidden (1 px clipped) screen-reader text and off-canvas text. A word is a token with a letter in it; tokens
// of digits only are counted apart as numbers. It writes <label>-counts.json, the visible text and screenshots.
//
// Build first, e.g.: pnpm --filter @squarehole/web exec vite build --outDir /tmp/dist-after
// Usage: node scripts/measure-visible-words.mjs <distDir> <label> <outDir> [path, default /fit-pair] [ready selector]
// The ready selector is what marks the page as loaded: by default the FIT pair page's freshness chip (the FIT pair page
// moved from /misfits to /fit-pair in SH-BOX-UI-launch; /misfits now redirects to the box), which must also name its
// first block; the box pages pass their own (the feed `.sh-box-card--featured[data-state]`, the box page
// `.sh-box-head[data-state]`, a wallet box `.sh-box-head`), each waited for with a known state (not "unavailable").
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { collectWords, summarise } from './lib/visible-words.mjs';

const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { chromium, devices } = require('@playwright/test');

const [, , dist, label, outDir, path = '/fit-pair', ready = '.sh-fit-chip'] = process.argv;
if (!dist || !label || !outDir) throw new Error('usage: node scripts/measure-visible-words.mjs <distDir> <label> <outDir> [path]');
mkdirSync(outDir, { recursive: true });

const ORIGIN = 'http://misfits.test';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary', '.map': 'application/json' };
// The accepted-Terms cookie the browser suites use (apps/web/e2e/terms-state.ts; the version must match terms.ts).
const TERMS = encodeURIComponent(JSON.stringify({ version: '2026-09-30-draft-5', acceptedAt: '2026-09-30T00:00:00.000Z' }));

const VIEWPORTS = [
  { name: 'desktop', options: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  { name: 'phone', options: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
];

const browser = await chromium.launch();
const results = {};
try {
  for (const { name, options } of VIEWPORTS) {
    const context = await browser.newContext({ ...options, baseURL: ORIGIN });
    await context.addCookies([{ name: 'squarehole.terms', value: TERMS, domain: 'misfits.test', path: '/', sameSite: 'Lax' }]);
    await context.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url());
      let file = join(dist, decodeURIComponent(url.pathname));
      if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
      await route.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
    });
    // Anything else (fonts, live services) is refused: the Demo stream reads no network.
    await context.route((url) => !url.href.startsWith(ORIGIN), (route) => route.abort());
    const page = await context.newPage();
    await page.goto(path);
    await page.locator(ready).first().waitFor();
    if (ready === '.sh-fit-chip') {
      // The first block has arrived: the chip names it in its text (before the text diet) or in its title (after).
      await page.waitForFunction(() => {
        const chip = document.querySelector('.sh-fit-chip');
        return /block/i.test(`${chip?.textContent ?? ''} ${chip?.getAttribute('title') ?? ''}`);
      });
    } else {
      // A box page: its live state has arrived (the element names a state other than "unavailable").
      await page.waitForFunction((selector) => {
        const element = document.querySelector(selector);
        return element !== null && element.getAttribute('data-state') !== 'unavailable';
      }, ready);
    }
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.waitForTimeout(400);
    await page.evaluate(() => window.scrollTo(0, 0));
    const { words, lines } = await page.evaluate(collectWords);
    results[name] = summarise(words);
    writeFileSync(join(outDir, `${label}-${name}-visible-text.txt`), `${lines.join('\n')}\n`);
    await page.screenshot({ path: join(outDir, `${label}-${name}-first-screen.png`), scale: 'css' });
    await page.screenshot({ path: join(outDir, `${label}-${name}-full.png`), fullPage: true, scale: 'css' });
    await context.close();
  }
} finally {
  await browser.close();
}
writeFileSync(join(outDir, `${label}-counts.json`), `${JSON.stringify(results, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ label, path, results }, null, 2)}\n`);
