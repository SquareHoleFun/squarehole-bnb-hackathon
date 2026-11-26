import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SECURITY_HEADERS } from '../functions/_middleware.js';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const SLOGAN = 'Different shapes. Same hole.';
const BUDGET_BYTES = 250 * 1024;

const read = (path) => readFileSync(join(PUBLIC, path), 'utf8');
const size = (path) => statSync(join(PUBLIC, path)).size;

function listFiles(dir = PUBLIC) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(path) : [relative(PUBLIC, path)];
  });
}

const FILES = listFiles();
const PAGES = ['index.html', '404.html'];
/** Every text file that is part of the site. fonts/OFL.txt is the font's licence, required word for word. */
const TEXT_FILES = FILES.filter((file) => file === '_headers' || (/\.(html|css|svg|txt|webmanifest)$/.test(file) && file !== 'fonts/OFL.txt'));

/** Words the page and its metadata must not carry (the founder's brief and the brand kit's safe-wording rules). */
const FORBIDDEN = [
  /\bfit\b/i,
  /misfit/i,
  /\btokens?\b/i,
  /\btrad(e|es|ed|er|ers|ing)\b/i,
  /\bprices?\b/i,
  /\bbuy/i,
  /\bsell/i,
  /\bwallets?\b/i,
  /\blaunch/i,
  /\bdemo\b/i,
  /\bswap/i,
  /\bcoins?\b/i,
  /\bcrypto/i,
  /\bnfts?\b/i,
  /\bethereum\b/i,
  /\bblockchain\b/i,
  /\bon-?chain\b/i,
  /\bvault/i,
  /\bcurve\b/i,
  /\bmint/i,
  /\bairdrop/i,
  /\bbanner/i,
  /\b(soon|early|presale|whitelist|allowlist)\b/i,
  /\b(earn|yield|profit|invest)/i,
];

/** The one link out (DECISION-LOG F81 XK5): the account on X, from the home page only. */
const X_ACCOUNT = 'https://x.com/squarehole_';
const X_ACCOUNT_HREF = /(<a\b[^>]*?)\shref="https:\/\/x\.com\/squarehole_"/;

const MONTHS = /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t|tember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/i;

/** The words a visitor or a link preview can see: text between tags plus alt, title and content attributes. */
function visibleText(html) {
  const attributes = [...html.matchAll(/\s(?:alt|title|content)="([^"]*)"/g)].map((m) => m[1]);
  const text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  return `${text} ${attributes.join(' ')}`.replace(/\s+/g, ' ').trim();
}

function meta(html, key) {
  const match = html.match(new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)"`));
  return match ? match[1] : null;
}

/** Local paths a page asks for: src, href, srcset entries and CSS url(). */
function localReferences(text) {
  const refs = [
    ...[...text.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((m) => m[1]),
    ...[...text.matchAll(/\ssrcset="([^"]+)"/g)].flatMap((m) => m[1].split(',').map((part) => part.trim().split(/\s+/)[0])),
    ...[...text.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)].map((m) => m[1]),
  ];
  return refs.filter((ref) => ref.startsWith('/'));
}

/**
 * Every address in a file that points off this site. With `linkOut`, the first `<a href>` to the X account is let
 * through and nothing else: a second link to it, the account in a `<link>`, a longer x.com path or any other host stays
 * in the list.
 */
function offSiteUrls(text, { linkOut = false } = {}) {
  const scanned = linkOut ? text.replace(X_ACCOUNT_HREF, '$1') : text;
  return [...scanned.matchAll(/(?:[a-z]+:)?\/\/[^\s"'<>)]+/gi)].map((m) => m[0]).filter((url) => !/^https:\/\/squarehole\.fun\//.test(url));
}

/** The page's links: each `<a>` with its attributes and the text it shows. */
function anchors(html) {
  return [...html.matchAll(/<a\s([^>]*)>([\s\S]*?)<\/a>/g)].map(([, attributes, inner]) => {
    const attr = (name) => attributes.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1] ?? null;
    return {
      href: attr('href'),
      rel: attr('rel'),
      target: attr('target'),
      label: attr('aria-label'),
      inner,
      text: inner.replace(/<svg[\s\S]*?<\/svg>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    };
  });
}

function headerBlocks(text) {
  const blocks = {};
  let current = null;
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      current = line.trim();
      blocks[current] = {};
      continue;
    }
    const at = line.indexOf(':');
    blocks[current][line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return blocks;
}

function pngSize(path) {
  const bytes = readFileSync(join(PUBLIC, path));
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

function jpegSize(path) {
  const bytes = readFileSync(join(PUBLIC, path));
  let at = 2;
  while (at < bytes.length) {
    const marker = bytes[at + 1];
    const length = bytes.readUInt16BE(at + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return [bytes.readUInt16BE(at + 7), bytes.readUInt16BE(at + 5)];
    }
    at += 2 + length;
  }
  throw new Error(`no frame header in ${path}`);
}

describe('landing page: content stays minimal', () => {
  it.each(TEXT_FILES)('%s carries none of the excluded words', (file) => {
    const text = read(file);
    for (const word of FORBIDDEN) expect(text, `${file}: ${word}`).not.toMatch(word);
  });

  it('no file is named after any of the excluded words', () => {
    for (const file of FILES) {
      for (const word of FORBIDDEN) expect(file.replace(/[-_./]/g, ' '), `${file}: ${word}`).not.toMatch(word);
    }
  });

  it.each(PAGES)('%s shows no date', (page) => {
    const text = visibleText(read(page));
    expect(text).not.toMatch(/\b(19|20)\d\d\b/);
    expect(text).not.toMatch(MONTHS);
  });

  it('the home page says the slogan and at most one more short line', () => {
    const html = read('index.html');
    const paragraphs = [...html.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g)].map((m) => m[1].trim());
    expect(paragraphs[0]).toBe(SLOGAN);
    expect(paragraphs.length).toBeLessThanOrEqual(2);
    expect(paragraphs.slice(1).every((line) => line.length <= 40)).toBe(true);
    expect(html.match(/<h1[\s\S]*?<\/h1>/)[0]).toContain('alt="Square Hole"');
  });

  it('the home page has one link, to the account on X, named for screen readers', () => {
    const links = anchors(read('index.html'));
    expect(links).toHaveLength(1);
    const [x] = links;
    expect(x.href).toBe(X_ACCOUNT);
    expect(x.rel.split(/\s+/).sort()).toEqual(['me', 'noopener']);
    expect(x.target).toBeNull();
    expect(x.text).toBe('@squarehole_');
    // The accessible name says where the link goes and contains the words on screen (WCAG 2.5.3).
    expect(x.label).toBe('@squarehole_ on X');
    expect(x.label).toContain(x.text);
    // The X glyph is decoration drawn inline: hidden from screen readers, nothing fetched.
    expect(x.inner).toMatch(/<svg [^>]*aria-hidden="true"/);
    expect(x.inner).not.toMatch(/\s(?:src|href|xlink:href)=/);
  });

  it('the 404 page links only home', () => {
    expect(anchors(read('404.html')).map((a) => a.href)).toEqual(['/']);
  });

  it('picks the 2:1 picture and its rounded card with one media query', () => {
    const html = read('index.html');
    const cropMedia = [...html.matchAll(/<source media="([^"]+)"[^>]*srcset="\/art\/stage-crop-/g)].map((m) => m[1]);
    expect(cropMedia).toHaveLength(3);
    expect(new Set(cropMedia).size).toBe(1);
    expect(cropMedia[0]).toMatch(/orientation: portrait/);
    const css = read('styles.css');
    const at = css.indexOf(`@media ${cropMedia[0]} {`);
    expect(at, `styles.css has no @media ${cropMedia[0]}`).toBeGreaterThanOrEqual(0);
    const block = css.slice(at, css.indexOf('\n}', at));
    expect(block).toMatch(/\.stage img \{[^}]*border-radius/);
  });

  it('the picture has alt text that describes it', () => {
    const html = read('index.html');
    const alt = html.match(/<picture[\s\S]*?<img [^>]*alt="([^"]+)"/)[1];
    expect(alt.length).toBeGreaterThan(40);
    expect(alt).toMatch(/cube/);
    expect(alt).toMatch(/hole/);
  });
});

describe('landing page: metadata', () => {
  const html = read('index.html');

  it('names the page and describes it with the slogan', () => {
    expect(html).toMatch(/<title>Square Hole<\/title>/);
    expect(meta(html, 'description')).toBe(SLOGAN);
    expect(meta(html, 'og:title')).toBe('Square Hole');
    expect(meta(html, 'og:description')).toBe(SLOGAN);
    expect(meta(html, 'twitter:title')).toBe('Square Hole');
    expect(meta(html, 'twitter:description')).toBe(SLOGAN);
    expect(meta(html, 'theme-color')).toBe('#080d16');
    expect(meta(html, 'robots')).toBe('index, follow');
  });

  it('shares the picture as a 1200 x 630 card that exists', () => {
    expect(meta(html, 'twitter:card')).toBe('summary_large_image');
    const image = meta(html, 'og:image');
    expect(meta(html, 'twitter:image')).toBe(image);
    expect(image).toMatch(/^https:\/\/squarehole\.fun\//);
    const path = new URL(image).pathname.slice(1);
    expect(existsSync(join(PUBLIC, path))).toBe(true);
    expect(jpegSize(path)).toEqual([1200, 630]);
    expect([meta(html, 'og:image:width'), meta(html, 'og:image:height')]).toEqual(['1200', '630']);
    // Some chat apps skip preview pictures over about 300 KB.
    expect(size(path)).toBeLessThan(300 * 1024);
  });

  it('describes the card, which names the site and carries the slogan', () => {
    const alt = meta(html, 'og:image:alt');
    expect(meta(html, 'twitter:image:alt')).toBe(alt);
    expect(alt).toContain('Square Hole');
    expect(alt).toContain(SLOGAN);
  });

  it('links the brand kit favicon set', () => {
    for (const file of ['favicon.ico', 'favicon.svg', 'apple-touch-icon.png', 'site.webmanifest']) {
      expect(html).toContain(`href="/${file}"`);
    }
    const manifest = JSON.parse(read('site.webmanifest'));
    expect(manifest.name).toBe('Square Hole');
    for (const icon of manifest.icons) expect(existsSync(join(PUBLIC, icon.src)), icon.src).toBe(true);
  });

  it('allows robots', () => {
    expect(read('robots.txt')).toMatch(/User-agent: \*\s+Allow: \//);
  });

  it('keeps the 404 page out of search results', () => {
    expect(meta(read('404.html'), 'robots')).toBe('noindex');
  });

  it('keeps the PNG fallbacks at their sizes', () => {
    expect(pngSize('art/stage-1600x400.png')).toEqual([1600, 400]);
    expect(pngSize('art/stage-crop-800x400.png')).toEqual([800, 400]);
  });
});

describe('landing page: no third parties, no scripts', () => {
  it.each(PAGES)('%s has no script, inline style, frame or form', (page) => {
    const html = read(page);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/\sstyle="/i);
    expect(html).not.toMatch(/\son[a-z]+="/i);
    expect(html).not.toMatch(/<(iframe|form|embed|object)/i);
  });

  // Off-site addresses: none, except the home page's one link to the account on X (a navigation, not a request).
  it.each([...PAGES, 'styles.css', 'site.webmanifest'])('%s asks only this site for anything', (file) => {
    const text = read(file);
    expect(offSiteUrls(text, { linkOut: file === 'index.html' }), file).toEqual([]);
    expect(text).not.toMatch(/@import/);
  });

  it('lets through exactly the one link to X and refuses any other address', () => {
    const page = read('index.html');
    const link = `<a href="${X_ACCOUNT}" rel="me noopener">@squarehole_</a>`;
    expect(offSiteUrls(page, { linkOut: true })).toEqual([]);
    expect(offSiteUrls(page)).toEqual([X_ACCOUNT]);
    expect(offSiteUrls(link, { linkOut: true })).toEqual([]);
    const planted = [
      [link, [X_ACCOUNT]], // a second link to the account
      ['<a href="https://discord.gg/squarehole">chat</a>', ['https://discord.gg/squarehole']],
      ['<a href="https://t.me/squarehole">chat</a>', ['https://t.me/squarehole']],
      [`<link rel="me" href="${X_ACCOUNT}" />`, [X_ACCOUNT]],
      [`<a href="${X_ACCOUNT}/status/1">post</a>`, [`${X_ACCOUNT}/status/1`]],
      ['<a href="http://x.com/squarehole_">x</a>', ['http://x.com/squarehole_']],
      ['<a href="//x.com/squarehole_">x</a>', ['//x.com/squarehole_']],
      ['<img src="https://pbs.twimg.com/profile.png" alt="" />', ['https://pbs.twimg.com/profile.png']],
    ];
    for (const [html, found] of planted) expect(offSiteUrls(`${page}${html}`, { linkOut: true }), html).toEqual(found);
  });

  it.each([...PAGES, 'styles.css'])('every file %s refers to exists', (file) => {
    for (const ref of localReferences(read(file))) {
      expect(existsSync(join(PUBLIC, ref.split(/[?#]/)[0])), `${file} -> ${ref}`).toBe(true);
    }
  });
});

describe('landing page: response headers', () => {
  const blocks = headerBlocks(read('_headers'));
  const all = blocks['/*'];

  it('sets the same security headers as the middleware', () => {
    expect(all).toEqual({ ...SECURITY_HEADERS });
  });

  it('has a strict Content-Security-Policy', () => {
    const csp = all['Content-Security-Policy'];
    const directives = Object.fromEntries(csp.split(';').map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
    expect(directives['default-src']).toEqual(["'none'"]);
    expect(directives['frame-ancestors']).toEqual(["'none'"]);
    expect(directives['base-uri']).toEqual(["'none'"]);
    expect(directives['form-action']).toEqual(["'none'"]);
    expect(directives['script-src']).toBeUndefined();
    for (const [name, values] of Object.entries(directives)) {
      for (const value of values) expect(["'self'", "'none'"], `${name} ${value}`).toContain(value);
    }
  });

  it('asks for HTTPS for a modest time and is not preloaded', () => {
    const hsts = all['Strict-Transport-Security'];
    const maxAge = Number(hsts.match(/max-age=(\d+)/)[1]);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(604800);
    expect(hsts).not.toMatch(/preload/i);
  });

  it('sends the other hardening headers', () => {
    expect(all['X-Content-Type-Options']).toBe('nosniff');
    expect(all['Referrer-Policy']).toBe('no-referrer');
    expect(all['Permissions-Policy']).toMatch(/camera=\(\)/);
    expect(all['X-Frame-Options']).toBe('DENY');
  });
});

describe('landing page: weight', () => {
  // What a first visit loads: the page, its stylesheet, the font, the wordmark, both favicons and one picture (the
  // largest modern variant the layout can pick: WebP, which is larger than AVIF here).
  const shared = ['index.html', 'styles.css', 'fonts/plus-jakarta-sans-latin-wght-normal.woff2', 'brand/wordmark.svg', 'favicon.svg', 'favicon.ico'];
  const scenarios = {
    'wide screen, 1x': 'art/stage-1600x400.webp',
    'wide screen, 2x': 'art/stage-2800x700.webp',
    'phone, 2x': 'art/stage-crop-800x400.webp',
    'phone, 3x': 'art/stage-crop-1200x600.webp',
  };

  it.each(Object.entries(scenarios))('%s stays under 250 KB', (_, picture) => {
    const total = [...shared, picture].reduce((sum, file) => sum + size(file), 0);
    expect(total).toBeLessThan(BUDGET_BYTES);
  });
});
