// @vitest-environment node
/** The preview tags injected into the SPA's own index.html for a box page. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { boxMeta, cardPath, escapeHtml, genericMeta, injectMeta } from './share-meta';
import type { ShareBox } from '@squarehole/cards';

/** Box 0's address on the local twin (public; a neutral name keeps the secret scanner's keyword rule quiet). */
const BOX_ADDRESS = '0xbd0a48c997121b66299e558db15b282485495c4a';
const INDEX = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.html'), 'utf8');
const ORIGIN = 'https://squarehole.fun';
/** The card service on the droplet (Caddy at api.squarehole.fun/card/...). */
const CARDS = 'https://api.squarehole.fun';
const BOX: ShareBox = {
  chainId: 11_155_111,
  token: BOX_ADDRESS,
  chainLabel: 'Sepolia',
  name: 'The Misfits',
  ticker: 'FIT',
  demo: false,
  state: { kind: 'upcoming', opensAt: 1_791_734_400, approx: false },
  logoSha256: null,
};

/** Every `<meta …>` content by its name or property, and the canonical link. */
function tags(html: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of html.matchAll(/<meta\s+(?:name|property)="([^"]+)"\s+content="([^"]*)"\s*\/?>/g)) out.set(m[1] as string, [...(out.get(m[1] as string) ?? []), m[2] as string]);
  for (const m of html.matchAll(/<link\s+rel="canonical"\s+href="([^"]*)"\s*\/?>/g)) out.set('canonical', [...(out.get('canonical') ?? []), m[1] as string]);
  return out;
}
const one = (map: Map<string, string[]>, key: string): string | undefined => {
  const values = map.get(key) ?? [];
  expect(values, key).toHaveLength(1);
  return values[0];
};

describe('a box page', () => {
  const html = injectMeta(INDEX, boxMeta(BOX, ORIGIN, CARDS));
  const t = tags(html);

  it('title = the box name, og:image = its card on the card service, canonical = the chain + address URL on the site', () => {
    expect(html).toContain('<title>The Misfits (FIT) · Square Hole</title>');
    expect(one(t, 'og:title')).toBe('The Misfits');
    expect(one(t, 'twitter:title')).toBe('The Misfits');
    expect(one(t, 'og:image')).toBe(`${CARDS}/card/box/11155111/0xbd0a48c997121b66299e558db15b282485495c4a.png?v=2-upcoming-1791734400`);
    expect(one(t, 'twitter:image')).toBe(one(t, 'og:image'));
    expect(one(t, 'canonical')).toBe(`${ORIGIN}/box/11155111/0xbd0a48c997121b66299e558db15b282485495c4a`);
    expect(one(t, 'og:url')).toBe(one(t, 'canonical'));
    expect(one(t, 'twitter:card')).toBe('summary_large_image');
    expect([one(t, 'og:image:width'), one(t, 'og:image:height'), one(t, 'og:image:type')]).toEqual(['1200', '630', 'image/png']);
  });

  it('a short neutral description with the chain and the full address, the same for every reader', () => {
    expect(one(t, 'description')).toBe(`FIT · Opens 11 Oct 2026, 16:00 UTC · Sepolia · ${BOX_ADDRESS}`);
    expect(one(t, 'og:description')).toBe(one(t, 'description'));
    expect(one(t, 'twitter:description')).toBe(one(t, 'description'));
    expect(one(t, 'og:image:alt')).toBe(`The Misfits (FIT) on Square Hole: Opens 11 Oct 2026, 16:00 UTC. Sepolia · ${BOX_ADDRESS}.`);
    expect(one(t, 'twitter:image:alt')).toBe(one(t, 'og:image:alt'));
  });

  it('replaces the page\'s own description; the body (the app) is untouched', () => {
    expect(html).not.toContain('a feed-first launchpad prototype');
    expect(html.slice(html.indexOf('<body>'))).toBe(INDEX.slice(INDEX.indexOf('<body>')));
    expect(html.match(/<title>/g)).toHaveLength(1);
  });

  it('injecting twice leaves one set of tags', () => {
    const twice = tags(injectMeta(html, boxMeta(BOX, ORIGIN, CARDS)));
    for (const key of ['description', 'og:title', 'og:image', 'twitter:card', 'canonical']) expect(twice.get(key), key).toHaveLength(1);
  });

  it('no card service (none configured, or it does not answer): the box\'s own words with the generic picture', () => {
    const plain = boxMeta(BOX, ORIGIN, null);
    expect([plain.ogTitle, plain.description]).toEqual(['The Misfits', `FIT · Opens 11 Oct 2026, 16:00 UTC · Sepolia · ${BOX_ADDRESS}`]);
    expect([plain.image, plain.imageType]).toEqual([`${ORIGIN}/share/square-hole-1200x630.jpg`, 'image/jpeg']);
    expect(plain.imageAlt).toBe(genericMeta(ORIGIN, null).imageAlt);
  });

  it('a sample box says no Demo in its title, description or alt text (F130)', () => {
    const demo = boxMeta({ ...BOX, demo: true, chainId: 31_337, chainLabel: 'Local chain', name: 'Paper Kites', ticker: 'KITE', state: { kind: 'upcoming', opensAt: null, approx: false } }, ORIGIN, CARDS);
    expect(demo.ogTitle).toBe('Paper Kites');
    expect(demo.description).toBe(`KITE · Upcoming · Local chain · ${BOX_ADDRESS}`);
    expect(demo.title).toBe('Paper Kites (KITE) · Square Hole');
    expect(JSON.stringify(demo)).not.toMatch(/demo/i);
  });
});

describe('untrusted names in the head', () => {
  it('are escaped: no tag, attribute or replacement pattern gets through', () => {
    const name = '"><script>alert(1)</script> & $& $1';
    const html = injectMeta(INDEX, boxMeta({ ...BOX, name, ticker: "A'B<" }, ORIGIN, CARDS));
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; $&amp; $1');
    expect(html).toContain('A&#39;B&lt;');
    expect(html.match(/<script/g)).toHaveLength(INDEX.match(/<script/g)?.length ?? 0);
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});

describe('the generic preview', () => {
  it('the landing page\'s card, words and alt text; canonical only for a well-formed box path', () => {
    const generic = tags(injectMeta(INDEX, genericMeta(ORIGIN, '/box/11155111/0xbd0a48c997121b66299e558db15b282485495c4a')));
    expect(one(generic, 'og:image')).toBe(`${ORIGIN}/share/square-hole-1200x630.jpg`);
    expect(one(generic, 'og:image:type')).toBe('image/jpeg');
    expect(one(generic, 'og:title')).toBe('Square Hole');
    expect(one(generic, 'description')).toBe('Different shapes. Same hole.');
    expect(one(generic, 'canonical')).toBe(`${ORIGIN}/box/11155111/0xbd0a48c997121b66299e558db15b282485495c4a`);
    expect(tags(injectMeta(INDEX, genericMeta(ORIGIN, null))).has('canonical')).toBe(false);
  });

  it('the card URL carries the design and the state', () => {
    expect(cardPath({ ...BOX, state: { kind: 'graduated' } })).toBe('/card/box/11155111/0xbd0a48c997121b66299e558db15b282485495c4a.png?v=2-graduated');
  });

  it('a page without </head> is returned unchanged', () => {
    expect(injectMeta('<p>no head</p>', genericMeta(ORIGIN, null))).toBe('<p>no head</p>');
  });
});
