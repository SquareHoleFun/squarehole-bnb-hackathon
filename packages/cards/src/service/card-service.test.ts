/**
 * The card service as Caddy meets it: a box's card from the indexer gateway's answers recorded during box 0's life on a
 * local twin (apps/web/e2e/fixtures/core-local), the generic card for anything else (never an error page), long cache
 * headers only for the URL of the current state, one draw per box and state, the disk cache, and the routes' input
 * checks.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { rawCidV1 } from '@squarehole/artwork';
import { BOX_0_MISFITS } from '@squarehole/box-spec';
import { boxRowFromRecord } from '@squarehole/chain';
import { labelAddress, syntheticBox } from '@squarehole/chain/core/test-support';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shLimit } from '../../../../vitest.timeouts.mjs';
import { nodeCardAssets, nodeCardEngine } from '../engine';
import { formatUtc } from '../share-model';
import { treeText, type CardEngine, type CardNode } from '../share-render';
import type { ShareConfig, ShareReaders } from '../share-read';
import { DiskCards } from './cache';
import { CARD_SECONDS, CardService, NO_LOGO_SECONDS, type CardServiceDeps } from './card-service';
import { DEFAULT_GENERIC } from './config';
import { blankPng } from '../test-support';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '../../../../apps/web/e2e/fixtures/core-local');
const LIFE = JSON.parse(readFileSync(join(FIXTURES, 'life.json'), 'utf8')) as { token: string; stages: Record<string, { box: unknown }> };
const LOCAL_MANIFEST = JSON.parse(readFileSync(join(FIXTURES, 'manifest-11155111.json'), 'utf8')) as unknown;
const SEPOLIA_COMMITTED = JSON.parse(readFileSync(resolve(HERE, '../../../contracts/deployments/core-v1/11155111.json'), 'utf8')) as unknown;
/** A Sepolia manifest before a broadcast (the committed file is box 0's deployed version since 2026-10-21). */
const SEPOLIA_PLACEHOLDER = { schema: 'squarehole.core-deployment/v1', status: 'awaiting-broadcast', chainId: 11_155_111, network: 'sepolia' };
const TOKEN = LIFE.token.toLowerCase();
const INDEXER = 'http://indexer.test:5394';
const GENERIC = new Uint8Array(readFileSync(DEFAULT_GENERIC));
const ASSETS = nodeCardAssets();
const LOGO = `0x${'19'.repeat(32)}` as const;

const LOCAL: ShareConfig = { sepoliaManifest: SEPOLIA_COMMITTED, localManifest: LOCAL_MANIFEST, sepoliaRpcUrls: [], localRpcUrl: 'http://127.0.0.1:5386', indexerOrigin: INDEXER };

/** The indexer gateway as recorded at one stage of box 0's life (404 for any other token); counts the reads. */
function gateway(stage: () => string | null, delayMs = 0) {
  const seen: string[] = [];
  const readers: ShareReaders = {
    fetch: async (url) => {
      seen.push(url);
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      const name = stage();
      const box = name === null ? undefined : LIFE.stages[name]?.box;
      return url === `${INDEXER}/v1/boxes/11155111/${TOKEN}` && box !== undefined ? new Response(JSON.stringify(box), { status: 200 }) : new Response(null, { status: 404 });
    },
    direct: null,
    indexerTimeoutMs: 1000,
  };
  return { readers, seen };
}

/** A stand-in renderer whose "PNG" is a PNG signature and the card's words, so a test reads what was drawn; counts draws. */
function wordsEngine(): { readonly engine: CardEngine; readonly draws: () => number } {
  const satori = vi.fn(async (element: CardNode) => treeText(element).join(' | '));
  const png = (svg: string) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode(svg)]);
  return { engine: { satori, png }, draws: () => satori.mock.calls.length };
}

const FIXTURE_V1 = (LOCAL_MANIFEST as { versions: { registry: { address: `0x${string}` }; supportedTemplates: `0x${string}`[] }[] }).versions[0];
const SAMPLE_LOGO = new Uint8Array(readFileSync(resolve(HERE, '../../../../docs/design/misfits-v2/banner/final/misfits-collection-sorter-1024.png')));
const SAMPLE_LOGO_SHA = `0x${createHash('sha256').update(SAMPLE_LOGO).digest('hex')}` as const;

/**
 * A graduated box read from the chain (the indexer answering 503), with the logo hash given: a synthetic row in the
 * fixture manifest's registry and template, as the chain package's decoder makes it.
 */
function chainBox(coverSha256: `0x${string}`, collectionCoverSha256: `0x${string}` = `0x${'0'.repeat(64)}`): { readonly readers: ShareReaders; readonly token: string } {
  if (FIXTURE_V1 === undefined) throw new Error('fixture manifest without version 1');
  const synthetic = syntheticBox({ spec: { ...BOX_0_MISFITS, coverSha256, collectionCoverSha256 }, templateId: FIXTURE_V1.supportedTemplates[0], label: `cover-${coverSha256.slice(2, 10)}` });
  const row = boxRowFromRecord(synthetic.record, synthetic.encodedSpec, { chainId: 11_155_111, registry: FIXTURE_V1.registry.address, box0Registry: labelAddress('another-registry') });
  return {
    readers: {
      fetch: async () => new Response('awaiting deploy', { status: 503 }),
      direct: { box: async () => ({ row, phase: 'graduated', at: { block: 1000n, timestamp: 1_790_000_000n } }) },
      indexerTimeoutMs: 1000,
    },
    token: (row.contracts.token as string).toLowerCase(),
  };
}

function service(overrides: Partial<CardServiceDeps> & { readers: ShareReaders }): CardService {
  return new CardService({
    config: () => LOCAL,
    engine: wordsEngine().engine,
    assets: ASSETS,
    generic: GENERIC,
    gateways: [],
    fetchArt: () => Promise.reject(new Error('no art fetch expected')),
    disk: null,
    engineKind: 'test',
    ...overrides,
  });
}

const text = (body: Uint8Array | null): string => new TextDecoder().decode(body ?? new Uint8Array());
const card = (v?: string) => `/card/box/11155111/${TOKEN}.png${v === undefined ? '' : `?v=${v}`}`;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a box\'s card', () => {
  it('a real 1200 x 630 PNG for the current state at its own URL', async () => {
    const { readers } = gateway(() => 'bonding');
    const engine = await nodeCardEngine('native');
    const answer = await service({ readers, engine, engineKind: engine.kind }).handle('GET', card('2-open'));
    expect(answer.headers['x-sh-card']).toContain('box; via=indexer');
    expect(answer.status).toBe(200);
    // Box 0 uses the exact bundled FIT picture even without a configured gateway.
    expect(answer.headers).toMatchObject({ 'content-type': 'image/png', 'cache-control': `public, max-age=${CARD_SECONDS}, immutable`, 'x-sh-card': 'box; via=indexer; logo=yes; card=drawn' });
    const png = answer.body ?? new Uint8Array();
    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect([view.getUint32(16), view.getUint32(20), png.byteLength < 300_000]).toEqual([1200, 630, true]);
  }, shLimit(60_000));

  it('every state of box 0\'s life: its words, its version, and the long cache only for that version', async () => {
    let stage = 'upcoming';
    const { readers } = gateway(() => stage);
    const { engine } = wordsEngine();
    const expected: Record<string, [string, string]> = {
      window: ['2-open', 'Open now'],
      bonding: ['2-open', 'Open now'],
      closed: ['2-graduating', 'Graduating'],
      graduated: ['2-graduated', 'Graduated'],
    };
    for (const [name, [v, words]] of Object.entries(expected)) {
      stage = name;
      const answer = await service({ readers, engine }).handle('GET', card(v));
      expect([text(answer.body).includes(words), answer.headers['cache-control']], name).toEqual([true, `public, max-age=${CARD_SECONDS}, immutable`]);
    }
    stage = 'upcoming';
    const upcoming = await service({ readers, engine }).handle('GET', card('2-open'));
    // Box 0's row carries its opening time (openAt, F80): "Opens" and that time to the minute, never "about" (an open
    // block's estimate, for rows without openAt: share-read.ts `openingOf`).
    const openAt = Number((LIFE.stages.upcoming?.box as { row: { record: { openAt: string } } }).row.record.openAt);
    expect(text(upcoming.body)).toContain(`Opens | ${formatUtc(openAt)}`);
    expect(text(upcoming.body)).not.toContain('about');
    expect([upcoming.headers['cache-control'], upcoming.headers['x-sh-card']]).toEqual(['no-store', 'box; via=indexer; logo=yes; card=drawn; v=other']);
    expect(upcoming.headers['x-sh-card-version']).toBe(`2-upcoming-${openAt}`);
  });

  it('one draw per box and state, whatever `v` requests name; another `v` gets the current card, never stored', async () => {
    const { readers, seen } = gateway(() => 'bonding');
    const { engine, draws } = wordsEngine();
    const cards = service({ readers, engine });
    const answers: string[] = [];
    for (const v of ['2-open', '2-graduated', 'x1', undefined, '2-upcoming-1', 'NOT-OK', '2-open']) {
      const answer = await cards.handle('GET', card(v));
      expect(text(answer.body)).toContain('Open now');
      answers.push(answer.headers['cache-control'] ?? '');
    }
    expect(answers).toEqual([`public, max-age=${CARD_SECONDS}, immutable`, 'no-store', 'no-store', 'no-store', 'no-store', 'no-store', `public, max-age=${CARD_SECONDS}, immutable`]);
    expect([draws(), seen.length]).toEqual([1, 1]);
    const head = await cards.handle('HEAD', card('2-open'));
    expect([head.status, head.body, head.headers['content-type'], Number(head.headers['content-length']) > 0]).toEqual([200, null, 'image/png', true]);
  });

  it('many requests at once for one card: one read and one draw', async () => {
    const { readers, seen } = gateway(() => 'graduated', 20);
    const { engine, draws } = wordsEngine();
    const cards = service({ readers, engine });
    const answers = await Promise.all(Array.from({ length: 20 }, () => cards.handle('GET', card('2-graduated'))));
    expect(new Set(answers.map((a) => a.headers['x-sh-card'])).size).toBeLessThanOrEqual(2);
    expect(answers.every((a) => a.headers['content-type'] === 'image/png')).toBe(true);
    expect([draws(), seen.length]).toEqual([1, 1]);
  });

  it('the logo from a configured gateway when its bytes hash to the spec: cached long; wrong logo bytes fall through to the verified cover, an hour', async () => {
    const { readers, token } = chainBox(SAMPLE_LOGO_SHA);
    const url = `/card/box/11155111/${token}.png?v=2-graduated`;
    const art = vi.fn(async () => new Response(SAMPLE_LOGO));
    const engine = await nodeCardEngine('native');
    const shown = await service({ readers, engine, gateways: ['https://art.example'], fetchArt: art }).handle('GET', url);
    expect(art).toHaveBeenCalledWith(`https://art.example/ipfs/${rawCidV1(SAMPLE_LOGO_SHA)}`, expect.objectContaining({ headers: { accept: 'application/vnd.ipld.raw, image/*;q=0.8' } }));
    expect([shown.headers['x-sh-card'], shown.headers['cache-control']]).toEqual(['box; via=direct; logo=yes; card=drawn', `public, max-age=${CARD_SECONDS}, immutable`]);
    // Wrong bytes for a nonbundled logo still fall through to the matching cover, kept an hour.
    const wrong = vi.fn(async () => new Response(SAMPLE_LOGO));
    const other = chainBox(LOGO, SAMPLE_LOGO_SHA);
    const mismatch = await service({ readers: other.readers, gateways: ['https://art.example'], fetchArt: wrong }).handle('GET', `/card/box/11155111/${other.token}.png?v=2-graduated`);
    expect(wrong).toHaveBeenCalledWith(`https://art.example/ipfs/${rawCidV1(LOGO)}`, expect.anything());
    expect([mismatch.headers['x-sh-card'], mismatch.headers['cache-control']]).toEqual(['box; via=direct; logo=yes; card=drawn', `public, max-age=${NO_LOGO_SECONDS}`]);
  }, shLimit(60_000));

  it('SH-191: a direct registry read carries the collection cover when no logo is committed', async () => {
    const { readers, token } = chainBox(`0x${'0'.repeat(64)}`, SAMPLE_LOGO_SHA);
    const { engine } = wordsEngine();
    const answer = await service({ readers, engine, gateways: ['https://art.example'], fetchArt: async () => new Response(SAMPLE_LOGO) })
      .handle('GET', `/card/box/11155111/${token}.png?v=2-graduated`);
    expect(answer.headers['x-sh-card']).toContain('box; via=direct; logo=yes');
    expect(answer.headers['cache-control']).toBe(`public, max-age=${CARD_SECONDS}, immutable`);
  });

  it('a committed logo of a few KB that decodes to 8,000 x 8,000 px: the brand mark, never decoded (the container’s memory is limited)', async () => {
    const bomb = blankPng(8000, 8000);
    const { readers, token } = chainBox(`0x${createHash('sha256').update(bomb).digest('hex')}`);
    const art = vi.fn(async () => new Response(bomb));
    const engine = await nodeCardEngine('native');
    const before = process.memoryUsage().rss;
    const answer = await service({ readers, engine, gateways: ['https://art.example'], fetchArt: art }).handle('GET', `/card/box/11155111/${token}.png?v=2-graduated`);
    // The oversized IPFS picture is refused, then the three Arweave indexes are tried (and also return junk).
    expect(art).toHaveBeenCalledTimes(4);
    expect([answer.headers['content-type'], answer.headers['x-sh-card'], answer.headers['cache-control']]).toEqual(['image/png', 'box; via=direct; logo=missing; card=drawn', `public, max-age=${NO_LOGO_SECONDS}`]);
    // Drawn, the logo alone would take about 350 MB more (measured: docs/evidence/SH-cards-droplet.md § Review).
    expect(process.memoryUsage().rss - before).toBeLessThan(150_000_000);
  }, shLimit(60_000));

  it('no box this service can show: the generic card (the landing page\'s JPEG), status 200, never an error page', async () => {
    const { readers } = gateway(() => null);
    const cards = service({ readers });
    for (const [target, reason, cache] of [
      [card('2-open'), 'generic; unknown', 'public, max-age=60'],
      ['/card/box/11155111/0xnope.png', 'generic; invalid', 'public, max-age=86400'],
      [`/card/box/1/${TOKEN}.png`, 'generic; invalid', 'public, max-age=86400'],
      [`/card/box/31337/${TOKEN}.png`, 'generic; invalid', 'public, max-age=86400'],
      [`/card/box/11155111/${TOKEN}.png/extra`, 'generic; invalid', 'public, max-age=86400'],
      [`/card/box/11155111/${TOKEN}.svg`, 'generic; invalid', 'public, max-age=86400'],
    ] as const) {
      const answer = await cards.handle('GET', target);
      expect([answer.status, answer.headers['content-type'], answer.headers['x-sh-card'], answer.headers['cache-control']], target).toEqual([200, 'image/jpeg', reason, cache]);
      expect(answer.body).toEqual(GENERIC);
    }
  });

  it('Sepolia awaiting a broadcast (a placeholder manifest): the generic card, and no request leaves', async () => {
    const { readers, seen } = gateway(() => 'bonding');
    const answer = await service({ readers, config: () => ({ ...LOCAL, sepoliaManifest: SEPOLIA_PLACEHOLDER, localManifest: null }) }).handle('GET', card('2-open'));
    expect([answer.headers['content-type'], answer.headers['x-sh-card'], answer.headers['cache-control']]).toEqual(['image/jpeg', 'generic; unknown', 'public, max-age=60']);
    expect(seen).toEqual([]);
  });

  it('the indexer failing with no chain reader: the generic card, not stored anywhere; a read slower than 6 s: the same', async () => {
    const failing: ShareReaders = { fetch: async () => new Response('awaiting deploy', { status: 503 }), direct: null, indexerTimeoutMs: 1000 };
    const failed = await service({ readers: failing }).handle('GET', card('2-open'));
    expect([failed.headers['x-sh-card'], failed.headers['cache-control']]).toEqual(['generic; failed', 'no-store']);
    vi.useFakeTimers();
    const never: ShareReaders = { fetch: () => new Promise<Response>(() => undefined), direct: null, indexerTimeoutMs: 60_000 };
    const pending = service({ readers: never }).handle('GET', card('2-open'));
    await vi.advanceTimersByTimeAsync(6000);
    const slow = await pending;
    expect([slow.headers['x-sh-card'], slow.headers['cache-control']]).toEqual(['generic; failed', 'no-store']);
  });

  it('a renderer that throws: the generic card, not stored, and the error reported', async () => {
    const { readers } = gateway(() => 'bonding');
    const errors: string[] = [];
    const broken: CardEngine = { satori: async () => Promise.reject(new Error('boom')), png: () => new Uint8Array() };
    const answer = await service({ readers, engine: broken, onError: (what, error) => errors.push(`${what}: ${(error as Error).message}`) }).handle('GET', card('2-open'));
    expect([answer.headers['content-type'], answer.headers['x-sh-card'], answer.headers['cache-control']]).toEqual(['image/jpeg', 'generic; error', 'no-store']);
    expect(errors).toEqual(['draw: boom']);
  });
});

describe('the disk cache', () => {
  it('a finished card is written once and read back after a restart (no new draw); a card without its logo is not written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sh-cards-'));
    try {
      // No logo in this box's spec: the card is finished.
      const { readers, token } = chainBox(`0x${'0'.repeat(64)}`);
      const url = `/card/box/11155111/${token}.png?v=2-graduated`;
      const first = wordsEngine();
      const a = await service({ readers, engine: first.engine, disk: new DiskCards(dir) }).handle('GET', url);
      expect([a.headers['x-sh-card'], a.headers['cache-control']]).toEqual(['box; via=direct; logo=none; card=drawn', `public, max-age=${CARD_SECONDS}, immutable`]);
      // Wait for the atomic rename, which can take longer than 50 ms under the full suite's I/O load.
      // Policy-aware names invalidate cards made before a notice, including across restarts.
      await vi.waitFor(() => expect(readdirSync(dir)).toEqual([expect.stringMatching(new RegExp(`^11155111-${token}-[a-f0-9]{64}\\.png$`))]));
      const second = wordsEngine();
      const b = await service({ readers, engine: second.engine, disk: new DiskCards(dir) }).handle('GET', url);
      expect([b.headers['x-sh-card'], second.draws()]).toEqual(['box; via=direct; logo=none; card=disk', 0]);
      expect(b.body).toEqual(a.body);
      // A nonbundled logo no gateway has: drawn, served, not written.
      const missing = chainBox(LOGO);
      const c = await service({ readers: missing.readers, engine: wordsEngine().engine, disk: new DiskCards(dir) }).handle('GET', `/card/box/11155111/${missing.token}.png?v=2-graduated`);
      expect(c.headers['x-sh-card']).toBe('box; via=direct; logo=missing; card=drawn');
      await new Promise((r) => setTimeout(r, 50));
      expect(readdirSync(dir)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps at most `maxFiles` cards, the oldest removed first; refuses names outside the pattern', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sh-cards-'));
    try {
      const disk = new DiskCards(dir, 3);
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
      for (let i = 0; i < 5; i += 1) {
        await disk.put(`11155111-0x${String(i).repeat(40)}-2-open.png`, png);
        await new Promise((r) => setTimeout(r, 15));
      }
      expect(await disk.prune()).toBe(2);
      expect(readdirSync(dir).sort()).toEqual([2, 3, 4].map((i) => `11155111-0x${String(i).repeat(40)}-2-open.png`));
      await disk.put('../escape.png', png);
      await disk.put(`11155111-0x${'a'.repeat(40)}-2-open.png`, new Uint8Array([1, 2, 3]));
      expect(readdirSync(dir)).toHaveLength(3);
      expect(await disk.get('../../etc/passwd')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('other requests', () => {
  it('health: 200 with the renderer named; anything else outside /card/box: 404; writes: 405', async () => {
    const cards = service({ readers: gateway(() => null).readers });
    const health = await cards.handle('GET', '/card/healthz');
    expect([health.status, text(health.body), health.headers['cache-control']]).toEqual([200, '{"ok":true,"engine":"test","webp":"off"}\n', 'no-store']);
    for (const target of ['/', '/card', '/card/', '/v1/feed', '/card/healthz/x', `/card/${'x'.repeat(600)}`, 'card/box']) {
      expect((await cards.handle('GET', target)).status, target).toBe(404);
    }
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const answer = await cards.handle(method, card('2-open'));
      expect([answer.status, answer.headers.allow]).toEqual([405, 'GET, HEAD']);
    }
  });
});


describe('MF23-4: revealed item cards', () => {
  const imageHash = `0x${'12'.repeat(32)}` as const;
  const png = blankPng(512, 512);
  const pngHash = `0x${createHash('sha256').update(png).digest('hex')}` as const;
  function itemReaders(revealed: () => boolean): ShareReaders {
    const base = gateway(() => 'graduated').readers;
    return { ...base, fetch: async (url, init) => url.endsWith('/items/1') ? new Response(JSON.stringify({
      schema: 'sh.core-item.v1', chainId: 11155111, token: TOKEN, id: '1',
      asOf: { block: '100', hash: `0x${'ab'.repeat(32)}`, timestamp: '1800000000', tier: 'head' },
      revealed: revealed(), traitsPacked: revealed() ? '1' : null, traits: [],
      art: revealed() ? { image: { sha256: imageHash, cid: rawCidV1(imageHash) }, avatar: null, model: null } : null,
    })) : base.fetch(url, init) };
  }
  it('draws the PNG copy named by the operator, never the committed WebP, and does not cache a head reveal', async () => {
    const engine = wordsEngine();
    const get = vi.fn<(url: string) => Promise<Response>>(async () => new Response(png));
    const answer = await service({ readers: itemReaders(() => true), engine: engine.engine,
      itemPngs: { [imageHash]: pngHash }, gateways: ['https://pin.invalid'], fetchArt: get,
    }).handle('GET', `/card/item/11155111/${TOKEN}/1.png`);
    expect(answer.headers['x-sh-card']).toBe('item; png=yes');
    expect(answer.headers['cache-control']).toBe('no-store');
    expect(text(answer.body)).toContain('#1');
    expect(get.mock.calls[0]?.[0]).toBe(`https://pin.invalid/ipfs/${rawCidV1(pngHash)}`);
  });
  it('unrevealed items never fetch a copy, even if the private map holds one', async () => {
    const get = vi.fn<(url: string) => Promise<Response>>(async () => new Response(png));
    const answer = await service({ readers: itemReaders(() => false), itemPngs: { [imageHash]: pngHash }, fetchArt: get })
      .handle('GET', `/card/item/11155111/${TOKEN}/1.png`);
    expect(answer.headers['x-sh-card']).toContain('generic');
    expect(get).not.toHaveBeenCalled();
  });
  it('refuses wrong PNG bytes and a reveal rolled back while its copy loads', async () => {
    let revealed = true;
    const deps = { readers: itemReaders(() => revealed), itemPngs: { [imageHash]: pngHash }, gateways: ['https://pin.invalid'] };
    const wrong = await service({ ...deps, fetchArt: async () => new Response(new Uint8Array([1, 2, 3])) })
      .handle('GET', `/card/item/11155111/${TOKEN}/1.png`);
    expect(wrong.headers['x-sh-card']).toContain('generic');
    const orphan = await service({ ...deps, fetchArt: async () => { revealed = false; return new Response(png); } })
      .handle('GET', `/card/item/11155111/${TOKEN}/1.png`);
    expect(orphan.headers['x-sh-card']).toContain('generic');
  });
  it('caps simultaneous item reads before any drawing starts', async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const get = vi.fn(() => pending);
    const cards = service({ readers: { ...itemReaders(() => true), fetch: get } });
    const answers = Array.from({ length: 65 }, (_, i) => cards.handle('GET', `/card/item/11155111/${TOKEN}/${i + 1}.png`));
    // Every allowed lookup is still waiting on its first response, so the excess request cannot reach the reader.
    release(new Response(null, { status: 503 }));
    expect(get).toHaveBeenCalledTimes(64);
    expect((await answers[64])?.headers['x-sh-card']).toContain('busy');
    await Promise.all(answers);
  });
});
