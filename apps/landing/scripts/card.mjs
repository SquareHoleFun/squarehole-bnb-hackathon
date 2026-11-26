// Composes the 1200 x 630 link-preview card: the centre of the picture with the horizontal lockup (mark + wordmark)
// and the slogan over its darker top-left sky. Called by art.sh; renders with the workspace's Playwright Chromium,
// because the mark's glow is an SVG blur filter that ImageMagick's own SVG renderer does not draw.
//
//   node apps/landing/scripts/card.mjs <background.png 1200x630> <out.png>
//
// Every brand piece comes from public/ as it is served (brand kit files, unchanged): brand/mark.svg,
// brand/wordmark.svg and the Plus Jakarta Sans file. The lockup is placed with the brand kit's horizontal proportions
// (squarehole-branding scripts/lib/compose.mjs: wordmark cap height 0.38 of the mark, gap 0.25 of the mark, wordmark
// centred on the mark), and the slogan is set like the kit's taglines (weight 550, tracking -0.005 em).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, '..', 'public');
const { chromium } = createRequire(join(HERE, '..', '..', 'web', 'package.json'))('@playwright/test');

const [background, out] = process.argv.slice(2);
if (!background || !out) {
  console.error('usage: node card.mjs <background.png> <out.png>');
  process.exit(2);
}

const WIDTH = 1200;
const HEIGHT = 630;

/** The mark's side in px; everything in the lockup is sized from it. */
const M = 92;
/** The wordmark file's geometry (viewBox 758.26 x 128.46: cap height 100, ink top 101.61 above the baseline). */
const WORDMARK = { width: 758.26, height: 128.46, cap: 100, ascent: 101.61 };
const scale = (0.38 * M) / WORDMARK.cap;
const lockup = {
  wordmarkLeft: 1.25 * M,
  wordmarkTop: M / 2 + (0.38 * M) / 2 - WORDMARK.ascent * scale,
  wordmarkWidth: WORDMARK.width * scale,
  wordmarkHeight: WORDMARK.height * scale,
};

const dataUrl = (file, type) => `data:${type};base64,${readFileSync(join(PUBLIC, file)).toString('base64')}`;
const px = (value) => `${Math.round(value * 100) / 100}px`;

const html = `<!doctype html>
<meta charset="utf-8">
<style>
  @font-face {
    font-family: 'Plus Jakarta Sans';
    font-weight: 200 800;
    src: url('${dataUrl('fonts/plus-jakarta-sans-latin-wght-normal.woff2', 'font/woff2')}') format('woff2');
  }
  html, body { margin: 0; width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; background: #080d16; }
  .card { position: relative; width: ${WIDTH}px; height: ${HEIGHT}px; }
  .card > img { position: absolute; inset: 0; width: ${WIDTH}px; height: ${HEIGHT}px; }
  /* Deepens the top-left sky behind the words, so they stay legible at the small size a timeline shows the card. */
  .scrim {
    position: absolute; inset: 0;
    background: radial-gradient(ellipse 620px 360px at 0 0, rgba(8, 13, 22, 0.82) 0%, rgba(8, 13, 22, 0.55) 45%, rgba(8, 13, 22, 0) 100%);
  }
  .words { position: absolute; left: 60px; top: 56px; }
  .lockup { position: relative; width: ${px(lockup.wordmarkLeft + lockup.wordmarkWidth)}; height: ${px(M)}; }
  .lockup img { position: absolute; display: block; }
  .lockup .mark { left: 0; top: 0; width: ${px(M)}; height: ${px(M)}; }
  .lockup .wordmark { left: ${px(lockup.wordmarkLeft)}; top: ${px(lockup.wordmarkTop)}; width: ${px(lockup.wordmarkWidth)}; height: ${px(lockup.wordmarkHeight)}; }
  .slogan {
    margin: 24px 0 0;
    color: #f3f5fb;
    font: 550 34px/1.2 'Plus Jakarta Sans', sans-serif;
    letter-spacing: -0.005em;
  }
</style>
<div class="card">
  <img src="${`data:image/png;base64,${readFileSync(background).toString('base64')}`}" alt="">
  <div class="scrim"></div>
  <div class="words">
    <div class="lockup">
      <img class="mark" src="${dataUrl('brand/mark.svg', 'image/svg+xml')}" alt="">
      <img class="wordmark" src="${dataUrl('brand/wordmark.svg', 'image/svg+xml')}" alt="">
    </div>
    <p class="slogan">Different shapes.<br>Same hole.</p>
  </div>
</div>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  const faces = await page.evaluate(async () => (await document.fonts.load("550 34px 'Plus Jakarta Sans'")).length);
  if (faces !== 1) throw new Error('Plus Jakarta Sans did not load');
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: out, type: 'png' });
} finally {
  await browser.close();
}
