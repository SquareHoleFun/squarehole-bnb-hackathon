/**
 * The Cloudflare Pages Function behind shared box links (apps/web/functions/box/[chain]/[address].ts): the box page's
 * index.html with the box's preview tags. Only `/box/:chain/:address` reaches this code; every other path is served by
 * Pages as before.
 *
 * The picture is drawn on the droplet (F81 CF1): the card service (packages/cards, behind Caddy at
 * https://api.squarehole.fun/card/box/<chain>/<address>.png?v=<version>). This function only names it, so it stays on
 * the Workers Free plan: a box page costs about a millisecond of CPU, where drawing a card costs hundreds
 * (docs/evidence/SH-share-cards.md, SH-cards-droplet.md). Nothing is drawn here.
 *
 * Configuration (Pages project → Settings → Variables; all optional):
 * - `SH_CARD_ORIGIN`: the card service (default https://api.squarehole.fun; `none`: always the generic picture).
 * - `SH_INDEXER_ORIGIN`: the indexer gateway (default https://api.squarehole.fun; `none` reads the chain only).
 * - `SH_SEPOLIA_RPC_URLS`: comma-separated keyless RPC URLs (default: the chain package's public list).
 * - `SH_CORE_LOCAL_MANIFEST`, `SH_CORE_LOCAL_RPC_URL`: local testing against a local twin only; never set in production.
 * - `SH_BUILD=production` (SH-V2-FE6): the production site's function knows no Demo box (a Demo chain link gets the
 *   generic tags). The site's own bundle drops the Demo at build time; this function is built by Pages, not Vite, so
 *   it also goes by the index.html it serves: the production build stamps it (src/share/build-stamp.ts), and a stamped
 *   page gets no Demo box with or without the variable.
 *
 * The picture: a chain box gets the card service's URL while the service answers its health check (`/card/healthz`,
 * asked at most about once a minute per data centre, alongside the box read and within the same wait); otherwise, and
 * for the Demo boxes (no chain to draw them from), the generic picture (the landing page's card) with the box's words.
 *
 * Waiting: a link-preview service (`isPreviewAgent`) gets the box page once the box is read, up to 2.5 s; anyone else
 * waits at most 0.3 s and otherwise gets the generic tags (the app is the same either way). A read goes on after the
 * answer and is kept when it lands, so the next request finds it. The box's facts are kept in the data centre's cache
 * (Cache API) for five minutes, a graduated box's for a week, an unknown box's for a minute.
 */
import { CARD_DESIGN, cacheSeconds, chainShareReader, originOf, rpcUrlsOf, type ShareConfig, type ShareLookup, type ShareReaders } from '@squarehole/cards';
import { DEMO_CHAIN_ID } from '@squarehole/domain';
import SEPOLIA_CORE_MANIFEST from '../../../../packages/contracts/deployments/core-v1/11155111.json';
import { boxPath, formatBoxId, parseBoxRoute } from '../features/boxes/box-id';
import { isProductionPage } from './build-stamp';
import { loadShareBox } from './share-data';
import { SPA_SECURITY_HEADERS } from './share-headers';
import { boxMeta, genericMeta, injectMeta } from './share-meta';

export const DEFAULT_INDEXER_ORIGIN = 'https://api.squarehole.fun';
export const DEFAULT_CARD_ORIGIN = 'https://api.squarehole.fun';

export interface ShareEnv {
  readonly ASSETS: { fetch(input: Request | string): Promise<Response> };
  readonly SH_CARD_ORIGIN?: string;
  readonly SH_INDEXER_ORIGIN?: string;
  readonly SH_SEPOLIA_RPC_URLS?: string;
  readonly SH_CORE_LOCAL_MANIFEST?: string;
  readonly SH_CORE_LOCAL_RPC_URL?: string;
  readonly SH_BUILD?: string;
}

/**
 * Link-preview services and search crawlers (X, Telegram, Discord, Facebook and iMessage, WhatsApp and Signal, Slack,
 * LinkedIn, Skype and Teams, Mastodon, Bluesky, Embedly, Iframely, …): they read only the head, so they wait for the box.
 * A browser's agent names none of these. The agent is anyone's to set; it only decides how long a page waits.
 */
const PREVIEW_AGENT = /bot|crawl|spider|preview|facebookexternalhit|whatsapp|mastodon|bluesky|cardyb|embedly|iframely|vkshare|viber|tumblr/i;
export const isPreviewAgent = (agent: string | null): boolean => agent !== null && PREVIEW_AGENT.test(agent);

/** What Pages passes a function (the parts used here). */
export interface ShareContext {
  readonly request: Request;
  readonly env: ShareEnv;
  readonly params: Readonly<Record<string, string | readonly string[] | undefined>>;
  waitUntil(promise: Promise<unknown>): void;
}

/** Budgets: a preview service waits for the box; a person hardly at all. */
const PAGE_BUDGET_MS = 2500;
const PERSON_BUDGET_MS = 300;
const INDEXER_TIMEOUT_MS = 2000;
const RPC_TIMEOUT_MS = 3000;
const UNKNOWN_CACHE_SECONDS = 60;
const INVALID_CACHE_SECONDS = 86_400;
/** The card service's health check: its own timeout, and how long its answer is believed. */
const PROBE_TIMEOUT_MS = 1500;
const PROBE_UP_SECONDS = 60;
const PROBE_DOWN_SECONDS = 30;

function jsonOrNull(raw: string | undefined): unknown {
  if (raw === undefined || raw.trim() === '') return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { invalid: true };
  }
}

export function configOf(env: ShareEnv): ShareConfig {
  const indexer = env.SH_INDEXER_ORIGIN?.trim();
  return {
    sepoliaManifest: SEPOLIA_CORE_MANIFEST,
    localManifest: jsonOrNull(env.SH_CORE_LOCAL_MANIFEST),
    sepoliaRpcUrls: rpcUrlsOf(env.SH_SEPOLIA_RPC_URLS),
    localRpcUrl: originOf(env.SH_CORE_LOCAL_RPC_URL),
    indexerOrigin: indexer === 'none' ? null : originOf(indexer || DEFAULT_INDEXER_ORIGIN),
  };
}

/** The card service's origin (https, or http on loopback for local testing), or null: `none`, or not a safe origin. */
export function cardOriginOf(env: ShareEnv): string | null {
  const raw = env.SH_CARD_ORIGIN?.trim();
  return raw === 'none' ? null : originOf(raw || DEFAULT_CARD_ORIGIN);
}

const param = (value: string | readonly string[] | undefined): string | undefined => (typeof value === 'string' ? value : undefined);

/** The data centre's cache, where the runtime has one (custom domains; not *.pages.dev, not node). */
function edgeCache(): Cache | null {
  const store = (globalThis as { caches?: { default?: Cache } }).caches;
  return store?.default ?? null;
}

const dataKey = (chain: string, token: string): string => `https://share-cache.invalid/${CARD_DESIGN}/box/${chain}/${token}`;
const probeKey = (cardOrigin: string): string => `https://share-cache.invalid/card-service/${encodeURIComponent(cardOrigin)}`;

/** A read that did not finish within the budget: never kept (the read itself is, when it lands). */
const TIMED_OUT: Extract<ShareLookup, { status: 'unknown' }> = Object.freeze({ status: 'unknown', reason: 'the box was not read in time', failed: true });
/** How long a read that failed is kept (it may work at the next one). */
const FAILED_CACHE_SECONDS = 30;
/** What a read that failed outright says. */
const READ_FAILED: Extract<ShareLookup, { status: 'unknown' }> = Object.freeze({ status: 'unknown', reason: 'the box could not be read', failed: true });

function lookupSeconds(lookup: ShareLookup): number {
  if (lookup.status === 'box') return cacheSeconds(lookup.box.state);
  if (lookup.status === 'invalid') return INVALID_CACHE_SECONDS;
  return lookup.failed ? FAILED_CACHE_SECONDS : UNKNOWN_CACHE_SECONDS;
}

function readersOf(): ShareReaders {
  return { fetch: (url, init) => fetch(url, init), direct: chainShareReader(RPC_TIMEOUT_MS), indexerTimeoutMs: INDEXER_TIMEOUT_MS };
}

/** Resolves to `fallback` once `ms` pass (the work goes on in the background, unused). */
function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/**
 * The box a link names: from the edge cache, else read. The caller waits at most `budgetMs` (then TIMED_OUT); the read
 * goes on and is kept for its lifetime when it lands, even after the answer has gone (so a person's visit warms the
 * cache for the preview service after it). Each read ends by itself: the indexer and every RPC call have their own
 * timeouts. Never a read that failed or ran out of time stands for the box for long: those are kept 30 s at most.
 */
async function lookupBox(context: ShareContext, chain: string | undefined, address: string | undefined, budgetMs: number, readers: ShareReaders, demo: boolean): Promise<ShareLookup> {
  const parsed = parseBoxRoute(chain, address);
  if (parsed === null) return { status: 'invalid' };
  const cache = edgeCache();
  const key = dataKey(String(parsed.chainId), parsed.token);
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return (await hit.json()) as ShareLookup;
    } catch {
      // A cache miss in effect.
    }
  }
  const read = loadShareBox(String(parsed.chainId), parsed.token, configOf(context.env), readers, { demo }).catch((): ShareLookup => READ_FAILED);
  if (cache) {
    const keep = (lookup: ShareLookup) => cache.put(key, new Response(JSON.stringify(lookup), { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${lookupSeconds(lookup)}` } }));
    context.waitUntil(read.then(keep).catch(() => undefined));
  }
  return within(read, budgetMs, TIMED_OUT);
}

/** The last health check per card service origin, in this isolate (the Cache API shares it across the data centre). */
const probes = new Map<string, { readonly up: boolean; readonly until: number }>();

/** Forgets the health checks this isolate remembers (tests). */
export function forgetCardProbes(): void {
  probes.clear();
}

/**
 * Whether the card service answers: `GET <origin>/card/healthz` is 200 with `{"ok":true}` within 1.5 s. Believed for a
 * minute when up, 30 s when down (in this isolate and in the data centre's cache), so a page costs one more subrequest
 * about once a minute. Never throws.
 */
async function cardServiceUp(context: ShareContext, cardOrigin: string, readers: ShareReaders): Promise<boolean> {
  const now = Date.now();
  const known = probes.get(cardOrigin);
  if (known !== undefined && known.until > now) return known.up;
  const cache = edgeCache();
  const key = probeKey(cardOrigin);
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) {
        const up = (await hit.text()) === 'up';
        probes.set(cardOrigin, { up, until: now + (up ? PROBE_UP_SECONDS : PROBE_DOWN_SECONDS) * 1000 });
        return up;
      }
    } catch {
      // A cache miss in effect.
    }
  }
  let up: boolean;
  try {
    const response = await readers.fetch(`${cardOrigin}/card/healthz`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), headers: { accept: 'application/json' } });
    up = response.ok && ((await response.json()) as { readonly ok?: unknown }).ok === true;
  } catch {
    up = false;
  }
  const seconds = up ? PROBE_UP_SECONDS : PROBE_DOWN_SECONDS;
  probes.set(cardOrigin, { up, until: now + seconds * 1000 });
  if (cache) context.waitUntil(cache.put(key, new Response(up ? 'up' : 'down', { headers: { 'cache-control': `public, max-age=${seconds}` } })).catch(() => undefined));
  return up;
}

/** A fresh GET of the SPA's index.html (no conditional headers, so never a bodyless 304). */
function indexRequest(request: Request): Request {
  return new Request(new URL('/', request.url).toString(), { method: 'GET', headers: { accept: 'text/html' } });
}

/**
 * `/box/:chain/:address`: index.html with the box's preview tags (generic ones when it names no box shown here), the
 * picture the card service's card while that service answers.
 */
export async function handleBoxPage(context: ShareContext, readers: ShareReaders = readersOf()): Promise<Response> {
  const { request, env, params } = context;
  const chain = param(params.chain);
  const address = param(params.address);
  const page = await env.ASSETS.fetch(indexRequest(request));
  if (!page.ok) return page;
  const index = await page.text();
  // The production site knows no Demo box: its index.html carries the production stamp, or the project says so.
  const demo = env.SH_BUILD?.trim() !== 'production' && !isProductionPage(index);
  const origin = new URL(request.url).origin;
  const budget = isPreviewAgent(request.headers.get('user-agent')) ? PAGE_BUDGET_MS : PERSON_BUDGET_MS;
  const parsed = parseBoxRoute(chain, address);
  const cardOrigin = cardOriginOf(env);
  // The health check only for a box the service could draw (a chain box), alongside the read and within the same wait.
  const probe = parsed !== null && parsed.chainId !== DEMO_CHAIN_ID && cardOrigin !== null ? cardServiceUp(context, cardOrigin, readers) : null;
  if (probe !== null) context.waitUntil(probe);
  const [lookup, serviceUp] = await Promise.all([lookupBox(context, chain, address, budget, readers, demo), probe === null ? false : within(probe, budget, false)]);
  const card = lookup.status === 'box' && lookup.via !== 'demo' && serviceUp ? cardOrigin : null;
  const meta = lookup.status === 'box' ? boxMeta(lookup.box, origin, card) : genericMeta(origin, parsed ? boxPath(formatBoxId(parsed.chainId, parsed.token)) : null);
  const html = injectMeta(index, meta);
  const share = lookup.status === 'box' ? `box; via=${lookup.via}; card=${card === null ? 'generic' : 'service'}` : lookup.status;
  const headers = new Headers({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=0, must-revalidate', 'x-sh-share': share });
  for (const [name, value] of Object.entries(SPA_SECURITY_HEADERS)) headers.set(name, value);
  return new Response(request.method === 'HEAD' ? null : html, { status: 200, headers });
}
