// @vitest-environment node
/**
 * The box page's Pages Function as a crawler meets it (User-Agent Twitterbot): index.html with the box's tags from the
 * recorded gateway answers, the picture on the card service (the droplet, F81 CF1) while it answers its health check and
 * the generic one otherwise; links that name no box get the generic preview, never an error page. Also: a person's
 * browser does not wait for the box. Nothing is drawn here (packages/cards draws on the droplet).
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rpcUrlsOf, type ShareReaders } from '@squarehole/cards';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_BOXES } from '../features/boxes/demo-boxes';
import { cardOriginOf, configOf, DEFAULT_CARD_ORIGIN, DEFAULT_INDEXER_ORIGIN, forgetCardProbes, handleBoxPage, isPreviewAgent, type ShareContext, type ShareEnv } from './share-edge';
import { productionIndexHtml } from '../../deployments-plugin';
import { SPA_SECURITY_HEADERS } from './share-headers';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = readFileSync(join(HERE, '..', '..', 'index.html'), 'utf8');
const FIXTURES = resolve(HERE, '../../e2e/fixtures/core-local');
const LIFE = JSON.parse(readFileSync(join(FIXTURES, 'life.json'), 'utf8')) as { token: string; stages: Record<string, { box: unknown }> };
// These remain v1 sharing tests; the browser fixture now also carries a v2 release.
const { releases: _releases, ...v1Manifest } = JSON.parse(readFileSync(join(FIXTURES, 'manifest-11155111.json'), 'utf8')) as Record<string, unknown>;
void _releases;
const MANIFEST = JSON.stringify(v1Manifest);
const TOKEN = LIFE.token.toLowerCase();
const INDEXER = 'http://127.0.0.1:5399';
/** The card service (Caddy's /card/* on api.squarehole.fun in production). */
const CARDS = 'http://127.0.0.1:5395';
const TWITTERBOT = 'Twitterbot/1.0';
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const GENERIC_IMAGE = 'https://squarehole.fun/share/square-hole-1200x630.jpg';

/** The deployment's static files, as the ASSETS binding serves them. */
const ASSETS: ShareEnv['ASSETS'] = {
  async fetch(input) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.pathname === '/') return new Response(INDEX, { headers: { 'content-type': 'text/html' } });
    return new Response('not found', { status: 404 });
  },
};
const ENV: ShareEnv = { ASSETS, SH_INDEXER_ORIGIN: INDEXER, SH_CARD_ORIGIN: CARDS, SH_CORE_LOCAL_MANIFEST: MANIFEST, SH_CORE_LOCAL_RPC_URL: 'http://127.0.0.1:8562' };

interface Visit {
  readonly userAgent?: string;
  /** Collects what the function hands `waitUntil` (cache writes), so a test can wait for them. */
  readonly pending?: Promise<unknown>[];
}
function context(path: string, params: Record<string, string>, env: ShareEnv = ENV, visit: Visit = {}): ShareContext {
  return {
    request: new Request(`https://squarehole.fun${path}`, { headers: { 'user-agent': visit.userAgent ?? TWITTERBOT } }),
    env,
    params,
    waitUntil: (promise) => void visit.pending?.push(promise),
  };
}

type Health = 'up' | 'down' | 'error' | 'hang';
/** The indexer gateway at one recorded stage, and the card service's health check; every URL asked is listed. */
function stageReaders(stage: string | null, options: { readonly delayMs?: number; readonly health?: Health; readonly seen?: string[] } = {}): ShareReaders {
  return {
    fetch: async (url) => {
      options.seen?.push(url);
      if (url === `${CARDS}/card/healthz`) {
        const health = options.health ?? 'up';
        if (health === 'hang') return new Promise<Response>(() => undefined);
        if (health === 'error') throw new TypeError('fetch failed');
        return health === 'up' ? new Response('{"ok":true,"engine":"native"}', { status: 200 }) : new Response('bad gateway', { status: 502 });
      }
      if ((options.delayMs ?? 0) > 0) await new Promise((r) => setTimeout(r, options.delayMs));
      const box = stage === null ? undefined : LIFE.stages[stage]?.box;
      return url === `${INDEXER}/v1/boxes/11155111/${TOKEN}` && box !== undefined ? new Response(JSON.stringify(box), { status: 200 }) : new Response(null, { status: 404 });
    },
    direct: null,
    indexerTimeoutMs: 1000,
  };
}

/** A data centre's cache (`caches.default`) in memory, keyed by URL, honouring each entry's `max-age` on a clock the test moves. */
function fakeCache() {
  let now = 0;
  const store = new Map<string, { readonly body: ArrayBuffer; readonly status: number; readonly headers: [string, string][]; readonly until: number }>();
  const urlOf = (key: Request | string): string => (typeof key === 'string' ? key : key.url);
  const cache = {
    async match(key: Request | string): Promise<Response | undefined> {
      const entry = store.get(urlOf(key));
      if (entry === undefined || entry.until <= now) return undefined;
      return new Response(entry.body.slice(0), { status: entry.status, headers: entry.headers });
    },
    async put(key: Request | string, response: Response): Promise<void> {
      const seconds = Number(/max-age=(\d+)/.exec(response.headers.get('cache-control') ?? '')?.[1] ?? 0);
      store.set(urlOf(key), { body: await response.arrayBuffer(), status: response.status, headers: [...response.headers], until: now + seconds });
    },
  };
  vi.stubGlobal('caches', { default: cache });
  return { advance: (seconds: number) => void (now += seconds) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  forgetCardProbes();
});
const meta = (html: string, key: string): string | undefined => new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)"`).exec(html)?.[1];
const page = (env: ShareEnv = ENV, visit: Visit = {}) => context(`/box/11155111/${TOKEN}`, { chain: '11155111', address: TOKEN }, env, visit);

describe('the box page, as a crawler fetches it', () => {
  it('index.html with the box\'s title, description, its card on the card service and canonical URL; the app\'s security headers', async () => {
    const response = await handleBoxPage(context(`/box/11155111/${TOKEN}`, { chain: '11155111', address: TOKEN }), stageReaders('bonding'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('x-sh-share')).toBe('box; via=indexer; card=service');
    for (const [name, value] of Object.entries(SPA_SECURITY_HEADERS)) expect(response.headers.get(name)).toBe(value);
    const html = await response.text();
    expect(meta(html, 'og:title')).toBe('The Misfits');
    expect(meta(html, 'og:description')).toBe(`FIT · Open now · Local chain · ${TOKEN}`);
    expect(meta(html, 'og:image')).toBe(`${CARDS}/card/box/11155111/${TOKEN}.png?v=2-open`);
    expect(meta(html, 'og:image:type')).toBe('image/png');
    expect(meta(html, 'twitter:card')).toBe('summary_large_image');
    expect(html).toContain(`<link rel="canonical" href="https://squarehole.fun/box/11155111/${TOKEN}" />`);
    expect(html).toContain('<div id="root"></div>');
  });

  it('a link in another spelling gets the canonical (lowercase) URL', async () => {
    const upper = `0x${TOKEN.slice(2).toUpperCase()}`;
    const html = await (await handleBoxPage(context(`/box/11155111/${upper}`, { chain: '11155111', address: upper }), stageReaders('graduated'))).text();
    expect(html).toContain(`<link rel="canonical" href="https://squarehole.fun/box/11155111/${TOKEN}" />`);
    expect(meta(html, 'og:description')).toBe(`FIT · Graduated · Local chain · ${TOKEN}`);
  });

  it('a box this site does not show, or a link that is no box: the generic preview, status 200', async () => {
    const unknown = await handleBoxPage(context(`/box/11155111/${TOKEN}`, { chain: '11155111', address: TOKEN }), stageReaders(null));
    expect([unknown.status, unknown.headers.get('x-sh-share')]).toEqual([200, 'unknown']);
    const html = await unknown.text();
    expect(meta(html, 'og:image')).toBe(GENERIC_IMAGE);
    expect(meta(html, 'og:title')).toBe('Square Hole');
    const invalid = await handleBoxPage(context('/box/1/nope', { chain: '1', address: 'nope' }), stageReaders('bonding'));
    expect([invalid.status, invalid.headers.get('x-sh-share')]).toEqual([200, 'invalid']);
    expect(await invalid.text()).not.toContain('rel="canonical"');
  });

  it('Sepolia as committed (box 0 deployed), with no local manifest: only Sepolia\'s indexer is asked; unknown there, the generic preview', async () => {
    const seen: string[] = [];
    const response = await handleBoxPage(context(`/box/11155111/${TOKEN}`, { chain: '11155111', address: TOKEN }, { ASSETS, SH_CARD_ORIGIN: CARDS }), stageReaders('bonding', { seen }));
    expect(response.headers.get('x-sh-share')).toBe('unknown');
    // The card service's health check (asked alongside, for a chain box) and the default indexer; no RPC is named.
    expect([...seen].sort()).toEqual([`${CARDS}/card/healthz`, `${DEFAULT_INDEXER_ORIGIN}/v1/boxes/11155111/${TOKEN}`].sort());
  });

  it('a box not read within 2.5 s: the generic preview then (the page never hangs on a slow indexer or RPC)', async () => {
    vi.useFakeTimers();
    try {
      const never: ShareReaders = { fetch: () => new Promise<Response>(() => undefined), direct: null, indexerTimeoutMs: 1000 };
      const pending = handleBoxPage(context(`/box/11155111/${TOKEN}`, { chain: '11155111', address: TOKEN }), never);
      await vi.advanceTimersByTimeAsync(2499);
      let settled = false;
      void pending.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const response = await pending;
      expect([response.status, response.headers.get('x-sh-share')]).toEqual([200, 'unknown']);
      expect(meta(await response.text(), 'og:image')).toBe(GENERIC_IMAGE);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a sample box says no Demo (F130), with the generic picture (the card service draws chain boxes only); no health check', async () => {
    const token = DEMO_BOXES.find((b) => b.ticker === 'KITE')?.token ?? '';
    const seen: string[] = [];
    const response = await handleBoxPage(context(`/box/31337/${token}`, { chain: '31337', address: token }), stageReaders(null, { seen }));
    const html = await response.text();
    expect(meta(html, 'og:title')).toBe('Paper Kites');
    expect(meta(html, 'og:description')).toBe(`KITE · Upcoming · Local chain · ${token}`);
    expect(html).not.toMatch(/\bdemo\b/i);
    expect([meta(html, 'og:image'), response.headers.get('x-sh-share'), seen]).toEqual([GENERIC_IMAGE, 'box; via=demo; card=generic', []]);
  });

  it('the production site’s function (SH_BUILD=production, SH-V2-FE6) knows no Demo box: the generic tags, no Demo word', async () => {
    const token = DEMO_BOXES.find((b) => b.ticker === 'KITE')?.token ?? '';
    const response = await handleBoxPage(context(`/box/31337/${token}`, { chain: '31337', address: token }, { ...ENV, SH_BUILD: 'production' }), stageReaders(null));
    const html = await response.text();
    expect(meta(html, 'og:title')).toBe('Square Hole');
    expect(html).not.toMatch(/Demo|Paper Kites/);
  });

  it('the production site’s own index.html (stamped by the production build) is enough: no Demo box without SH_BUILD', async () => {
    const token = DEMO_BOXES.find((b) => b.ticker === 'KITE')?.token ?? '';
    const stamped: ShareEnv['ASSETS'] = { fetch: async () => new Response(productionIndexHtml(INDEX), { headers: { 'content-type': 'text/html' } }) };
    const response = await handleBoxPage(context(`/box/31337/${token}`, { chain: '31337', address: token }, { ...ENV, ASSETS: stamped }), stageReaders(null));
    const html = await response.text();
    expect([meta(html, 'og:title'), response.headers.get('x-sh-share')]).toEqual(['Square Hole', 'unknown']);
    expect(html).not.toMatch(/Demo|Paper Kites/);
  });
});

describe('the box page, as a person\'s browser fetches it', () => {
  it('link-preview services wait for the box; browsers do not', () => {
    for (const agent of [
      TWITTERBOT,
      'TelegramBot (like TwitterBot)',
      'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
      'facebookexternalhit/1.1 Facebot Twitterbot/1.0',
      'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      'WhatsApp/2.23.20.0 A',
      'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
      'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mastodon/4.3.0 (http.rb/5.2.0; +https://mastodon.social/) Bot',
      'Bluesky Cardyb/1.1',
      'Mozilla/5.0 (Windows NT 6.1; WOW64) SkypeUriPreview Preview/0.5 skype-url-preview@microsoft.com',
      'Iframely/1.3.1 (+https://iframely.com/docs/about)',
      'Mozilla/5.0 (compatible; Embedly/0.2; +http://support.embed.ly/)',
    ]) {
      expect(isPreviewAgent(agent), agent).toBe(true);
    }
    for (const agent of [BROWSER, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1', 'Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0', null, '']) {
      expect(isPreviewAgent(agent), String(agent)).toBe(false);
    }
  });

  it('a browser gets index.html within 0.3 s even when nothing answers (a crawler waits up to 2.5 s)', async () => {
    vi.useFakeTimers();
    const never: ShareReaders = { fetch: () => new Promise<Response>(() => undefined), direct: null, indexerTimeoutMs: 1000 };
    const pending = handleBoxPage(page(ENV, { userAgent: BROWSER }), never);
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(299);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const response = await pending;
    expect([response.status, response.headers.get('x-sh-share')]).toEqual([200, 'unknown']);
    expect(await response.text()).toContain('<div id="root"></div>');
  });

  it('the read a browser did not wait for still lands in the cache, so the crawler after it gets the box at once', async () => {
    vi.useFakeTimers();
    fakeCache();
    const pending: Promise<unknown>[] = [];
    const visit = (userAgent: string, readers: ShareReaders) => handleBoxPage(context(`/box/11155111/${TOKEN}`, { chain: '11155111', address: TOKEN }, ENV, { userAgent, pending }), readers);
    // The indexer takes 1 s: the person is answered at 0.3 s with the generic tags...
    const person = visit(BROWSER, stageReaders('bonding', { delayMs: 1000 }));
    await vi.advanceTimersByTimeAsync(300);
    expect((await person).headers.get('x-sh-share')).toBe('unknown');
    // ...and the read, finished in the background, is kept (not the 0.3 s stand-in).
    await vi.advanceTimersByTimeAsync(700);
    await Promise.all(pending);
    const seen: string[] = [];
    const crawler = await visit(TWITTERBOT, stageReaders(null, { seen }));
    expect(crawler.headers.get('x-sh-share')).toBe('box; via=indexer; card=service');
    expect(meta(await crawler.text(), 'og:image')).toBe(`${CARDS}/card/box/11155111/${TOKEN}.png?v=2-open`);
    // Neither the box nor the health check is asked again (both kept).
    expect(seen).toEqual([]);
    // A browser with the box in the cache gets its tags too.
    expect((await visit(BROWSER, stageReaders(null, { seen }))).headers.get('x-sh-share')).toBe('box; via=indexer; card=service');
  });
});

describe('the picture: the card service while it answers', () => {
  it('its health check failing in any way (an error status, no answer, not reachable): the generic picture with the box\'s own words', async () => {
    for (const health of ['down', 'error'] as const) {
      forgetCardProbes();
      const response = await handleBoxPage(page(), stageReaders('bonding', { health }));
      const html = await response.text();
      expect([response.headers.get('x-sh-share'), meta(html, 'og:image'), meta(html, 'og:image:type'), meta(html, 'og:title')], health).toEqual(['box; via=indexer; card=generic', GENERIC_IMAGE, 'image/jpeg', 'The Misfits']);
      expect(meta(html, 'og:description')).toBe(`FIT · Open now · Local chain · ${TOKEN}`);
    }
  });

  it('a health check with no answer: the generic picture, the page no later than the crawler\'s 2.5 s', async () => {
    vi.useFakeTimers();
    const pending = handleBoxPage(page(), stageReaders('bonding', { health: 'hang' }));
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(2499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const response = await pending;
    expect(response.headers.get('x-sh-share')).toBe('box; via=indexer; card=generic');
  });

  it('asked about once a minute (30 s after a failure), not for every page', async () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const health = { now: 'down' as Health };
    const reader = () => {
      const base = stageReaders('bonding', { seen });
      return { ...base, fetch: (url: string, init?: RequestInit) => (url === `${CARDS}/card/healthz` ? stageReaders('bonding', { health: health.now, seen }).fetch(url, init) : base.fetch(url, init)) };
    };
    const checks = () => seen.filter((url) => url.endsWith('/card/healthz')).length;
    expect((await handleBoxPage(page(), reader())).headers.get('x-sh-share')).toBe('box; via=indexer; card=generic');
    health.now = 'up';
    await vi.advanceTimersByTimeAsync(29_000);
    expect((await handleBoxPage(page(), reader())).headers.get('x-sh-share')).toBe('box; via=indexer; card=generic');
    expect(checks()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await handleBoxPage(page(), reader())).headers.get('x-sh-share')).toBe('box; via=indexer; card=service');
    for (let i = 0; i < 5; i += 1) await handleBoxPage(page(), reader());
    expect(checks()).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    await handleBoxPage(page(), reader());
    expect(checks()).toBe(3);
  });

  it('SH_CARD_ORIGIN=none (or an unsafe origin): the generic picture, and no health check', async () => {
    for (const origin of ['none', 'http://cards.example', 'https://cards.example/path']) {
      const seen: string[] = [];
      const response = await handleBoxPage(page({ ...ENV, SH_CARD_ORIGIN: origin }), stageReaders('bonding', { seen }));
      expect([response.headers.get('x-sh-share'), meta(await response.text(), 'og:image')], origin).toEqual(['box; via=indexer; card=generic', GENERIC_IMAGE]);
      expect(seen.some((url) => url.endsWith('/card/healthz')), origin).toBe(false);
    }
  });

  it('a link that is no box: no health check either', async () => {
    const seen: string[] = [];
    await handleBoxPage(context('/box/1/nope', { chain: '1', address: 'nope' }), stageReaders('bonding', { seen }));
    expect(seen).toEqual([]);
  });

  it('the health check is shared through the data centre\'s cache (a fresh isolate does not ask again)', async () => {
    fakeCache();
    const pending: Promise<unknown>[] = [];
    const seen: string[] = [];
    await handleBoxPage(page(ENV, { pending }), stageReaders('bonding', { seen }));
    await Promise.all(pending);
    forgetCardProbes();
    const response = await handleBoxPage(page(ENV, { pending }), stageReaders('bonding', { seen }));
    expect(response.headers.get('x-sh-share')).toBe('box; via=indexer; card=service');
    expect(seen.filter((url) => url.endsWith('/card/healthz'))).toHaveLength(1);
  });
});

describe('configuration', () => {
  it('the card service at api.squarehole.fun by default; `none` turns it off; only https (or http on loopback)', () => {
    expect(DEFAULT_CARD_ORIGIN).toBe('https://api.squarehole.fun');
    expect(cardOriginOf({ ASSETS })).toBe(DEFAULT_CARD_ORIGIN);
    expect(cardOriginOf({ ASSETS, SH_CARD_ORIGIN: ' none ' })).toBeNull();
    expect(cardOriginOf({ ASSETS, SH_CARD_ORIGIN: 'http://127.0.0.1:5395' })).toBe('http://127.0.0.1:5395');
    expect(cardOriginOf({ ASSETS, SH_CARD_ORIGIN: 'http://cards.example' })).toBeNull();
  });

  it('the indexer gateway by default; `none` reads the chain only; an unsafe origin is ignored', () => {
    expect(configOf({ ASSETS }).indexerOrigin).toBe(DEFAULT_INDEXER_ORIGIN);
    expect(configOf({ ASSETS, SH_INDEXER_ORIGIN: 'none' }).indexerOrigin).toBeNull();
    expect(configOf({ ASSETS, SH_INDEXER_ORIGIN: 'http://indexer.example' }).indexerOrigin).toBeNull();
    expect(configOf({ ASSETS, SH_INDEXER_ORIGIN: 'https://api.example/path' }).indexerOrigin).toBeNull();
  });

  it('keyless https RPCs (the public list by default); a local manifest only when given', () => {
    expect(rpcUrlsOf(undefined)).toEqual(['https://ethereum-sepolia-rpc.publicnode.com', 'https://sepolia.gateway.tenderly.co']);
    expect(rpcUrlsOf('https://rpc.example/v1, http://plain.example, https://u:p@x.example, https://k.example/?key=1')).toEqual(['https://rpc.example/v1']);
    expect(configOf({ ASSETS }).localManifest).toBeNull();
    expect(configOf({ ASSETS, SH_CORE_LOCAL_MANIFEST: '{nope' }).localManifest).toEqual({ invalid: true });
  });
});
