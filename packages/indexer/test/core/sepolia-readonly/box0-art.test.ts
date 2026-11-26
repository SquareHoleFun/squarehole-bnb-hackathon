/**
 * Box 0 on the Sepolia test site. SH-BOX0-ART-TEST-SITE found it hidden: box 0's spec commits the FIT icon (an SVG) as
 * its logo, and the indexer's listing check asked our own picture route, which serves raster blocks only (415 for
 * anything else, infra/server/ipfs/gateway.mjs), so the logo was "missing" forever. That fix had the release carry both
 * public pictures for the check. Since SH-NO-PICTURE-GATE (founder 2026-10-24) no picture decides a listing at all:
 * box 0 is listed by its code checks, as every box is, and the feed is still the recorded one. The site draws its two
 * pictures from its own bundle once their bytes hash to the commitment (apps/web bundled-pictures.ts); the indexer's
 * item route still never answers with bytes our route refuses.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadArt, MemoryArtStore, rawCid } from '../../../src/core/art';
import { CoreChainIndexer } from '../../../src/core/chain-indexer';
import { coreGatewaySource } from '../../../src/core/core-service';
import { toJson } from '../../../src/model';
import { sepoliaWorld } from './sepolia-world';

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
// The deployed spec bytes (the registry holds their hash), decoded.
const DEPLOYED = sepoliaWorld().row.spec;
const LOGO = DEPLOYED.coverSha256.toLowerCase() as `0x${string}`;
/** The recorded answers the app's read-only e2e uses (sepolia-readonly.test.ts writes them). */
const SEPOLIA_READONLY_FIXTURE = join(REPO_ROOT, 'apps/web/e2e/fixtures/sepolia-readonly/indexer-answers.json');
const FIT_ICON = join(REPO_ROOT, 'packages/design/art/fit/fit-icon.svg');
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Our picture route as it answers: a pinned raster block, 415 for a pinned block of any other type, 404 for none.
 * `pinned` maps a raw CID to its bytes.
 */
function pictureRoute(pinned: ReadonlyMap<string, Uint8Array>) {
  const asked: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    asked.push(url.pathname);
    const bytes = pinned.get(url.pathname.slice('/ipfs/'.length));
    if (!bytes) return new Response('not found', { status: 404 });
    const raster = PNG.every((b, i) => bytes[i] === b);
    return raster ? new Response(bytes.slice(), { status: 200, headers: { 'content-type': 'image/png' } }) : new Response('unsupported', { status: 415 });
  }) as unknown as typeof fetch;
  return { fetcher, asked };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('box 0’s pictures on the Sepolia test site (SH-BOX0-ART-TEST-SITE, SH-NO-PICTURE-GATE)', () => {
  it('box 0 is listed by its code checks alone: nothing is fetched for its pictures, and the feed is the recorded one', async () => {
    const route = pictureRoute(new Map());
    vi.stubGlobal('fetch', route.fetcher);
    const world = sepoliaWorld();
    const indexer = new CoreChainIndexer({ reader: world.chain, manifest: world.manifest as never, auditEvery: 1_000_000_000 });
    await indexer.start();
    await indexer.idle();
    const head = indexer.head();
    if (!head) throw new Error('the indexer applied no block');
    const nowMs = Number(head.timestamp) * 1000;
    const { source, updated } = coreGatewaySource(indexer, world.chain, null, 60_000, () => nowMs);
    updated();
    const feed = JSON.parse(toJson(source.feed())) as { cards: unknown[] };
    expect(indexer.feedView().hidden).toEqual([]);
    expect(route.asked).toEqual([]);
    const recorded = JSON.parse(readFileSync(SEPOLIA_READONLY_FIXTURE, 'utf8')) as { answers: { '/v1/feed': unknown } };
    expect(feed).toEqual(recorded.answers['/v1/feed']);
    indexer.stop();
  });

  it('the item route never answers with box 0’s logo, an SVG our picture route refuses even when pinned', async () => {
    const svg = new Uint8Array(readFileSync(FIT_ICON));
    const route = pictureRoute(new Map([[rawCid(LOGO), svg]]));
    expect(await loadArt(LOGO, { gateways: ['https://api.squarehole.fun'], store: new MemoryArtStore(), fetch: route.fetcher })).toBeNull();
    expect(route.asked).toEqual([`/ipfs/${rawCid(LOGO)}`]);
  });
});
