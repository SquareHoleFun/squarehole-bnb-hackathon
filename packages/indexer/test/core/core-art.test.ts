/**
 * BC-082's picture part since SH-NO-PICTURE-GATE (founder 2026-10-24): pictures never decide a listing (the listing
 * check, its wait list and retries are gone; no-picture-gate.test.ts shows boxes listed without them). What stays is
 * the hash check: a committed picture is asked by its raw CIDv1 (the sha256 IS the CID's digest), only bytes that hash
 * to the commitment are served or kept, and kept ones are stored for good. Against a stub gateway; nothing leaves the
 * machine. Box 0's full art on Arweave and open-art reveal lists wait (the art lane, S11).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { boxCollectionAbi } from '@squarehole/chain/abi';
import { CoreGateway, type CoreGatewaySource } from '../../src/core/core-gateway';
import { coreGatewaySource } from '../../src/core/core-service';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOX_0_MISFITS } from '@squarehole/box-spec';
import type { Address, Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DirArtStore, MemoryArtStore, rawCid, loadArt } from '../../src/core/art';
import { loadCoreConfig } from '../../src/core/core-config';
import { CoreChainIndexer } from '../../src/core/chain-indexer';
import { parseItemView } from '../../src/core/core-views';
import { event, synthBox, synthManifest, World } from './core-synth';

const sha = (bytes: Uint8Array): Hex => `0x${createHash('sha256').update(bytes).digest('hex')}`;
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const LOGO = utf8('<svg xmlns="http://www.w3.org/2000/svg">a logo</svg>');
const COVER = utf8('a collection cover, as PNG bytes would be');
const OTHER = utf8('some other picture');

/** A stub IPFS gateway: `/ipfs/<cid>` answers the bytes registered for that CID; anything else 404. */
const gateway = 'https://fake-gateway.invalid';
const served = new Map<string, Uint8Array>();
const asked: string[] = [];
const fakeFetch: typeof fetch = async (input) => {
  const url = new URL(String(input));
  asked.push(url.pathname);
  const body = served.get(url.pathname.slice('/ipfs/'.length));
  return body ? new Response(new Uint8Array(body)) : new Response(null, { status: 404 });
};

describe('BC-082: committed pictures by raw CID, sha256 checked, stored for good', () => {
  it('BC-082: the raw CIDv1 of a sha256 is the art lane\'s (box 0\'s collection cover, the Sorter)', () => {
    expect(rawCid(BOX_0_MISFITS.collectionCoverSha256)).toBe('bafkreicbz6dp3c7ux4mfknchpy24uanydazrnloji6us7hb5rez2sdyr7m');
  });

  it('BC-082: checked pictures are kept for good in SH_CORE_ART_DIR; a later read needs no gateway', async () => {
    served.clear(); asked.length = 0;
    served.set(rawCid(sha(LOGO)), LOGO);
    served.set(rawCid(sha(COVER)), COVER);
    const dir = mkdtempSync(join(tmpdir(), 'sh-art-'));
    expect(await loadArt(sha(LOGO), { fetch: fakeFetch, gateways: [gateway], store: new DirArtStore(dir) })).toEqual(LOGO);
    expect(await loadArt(sha(COVER), { fetch: fakeFetch, gateways: [gateway], store: new DirArtStore(dir) })).toEqual(COVER);
    expect(asked).toEqual([`/ipfs/${rawCid(sha(LOGO))}`, `/ipfs/${rawCid(sha(COVER))}`]);
    expect(readdirSync(dir).sort()).toEqual([sha(LOGO).slice(2), sha(COVER).slice(2)].sort());
    // Stored for good: with the gateway gone, the folder answers (a new store on it, as after a restart).
    served.clear();
    expect(await loadArt(sha(LOGO), { fetch: fakeFetch, gateways: ['http://127.0.0.1:9'], store: new DirArtStore(dir) })).toEqual(LOGO);
    expect(asked).toHaveLength(2);
  });

  it('BC-082: bytes that do not hash to the commitment, or that no gateway has, are never served or stored', async () => {
    served.clear();
    served.set(rawCid(sha(LOGO)), OTHER);
    const store = new MemoryArtStore();
    expect(await loadArt(sha(LOGO), { fetch: fakeFetch, gateways: [gateway], store })).toBeNull();
    expect(await loadArt(sha(COVER), { fetch: fakeFetch, gateways: [gateway], store })).toBeNull();
    expect(await store.get(sha(LOGO))).toBeNull();
    expect(await store.get(sha(COVER))).toBeNull();
    // A store whose file was altered on disk is refused too (re-checked on read).
    const dir = mkdtempSync(join(tmpdir(), 'sh-art-'));
    writeFileSync(join(dir, sha(LOGO).slice(2)), OTHER);
    expect(await new DirArtStore(dir).get(sha(LOGO))).toBeNull();
    expect(await loadArt(sha(LOGO), { fetch: fakeFetch, gateways: [gateway], store: new DirArtStore(dir) })).toBeNull();
  });

  it('BC-082: the service reads pictures only from configured gateways (keyless http(s) origins), and keeps them in SH_CORE_ART_DIR', () => {
    const manifest = readFileSync(fileURLToPath(new URL('../../../../apps/web/e2e/fixtures/core-local/manifest-11155111.json', import.meta.url)), 'utf8');
    const env = { SH_CORE_MANIFEST: 'm.json', SH_CORE_HTTP_URLS: 'http://127.0.0.1:8562' };
    expect(loadCoreConfig(env, () => manifest).manifest).toHaveProperty('releases.0.safes');
    expect(loadCoreConfig(env, () => manifest).art).toEqual({ gateways: [], dir: null });
    expect(loadCoreConfig({ ...env, SH_CORE_ART_GATEWAYS: 'https://a.example, http://127.0.0.1:8080', SH_CORE_ART_DIR: '/srv/art' }, () => manifest).art).toEqual({ gateways: ['https://a.example', 'http://127.0.0.1:8080'], dir: '/srv/art' });
    expect(() => loadCoreConfig({ ...env, SH_CORE_ART_GATEWAYS: 'https://user:pw@a.example' }, () => manifest)).toThrow(/art gateways/);
    expect(() => loadCoreConfig({ ...env, SH_CORE_ART_GATEWAYS: 'ftp://a.example' }, () => manifest)).toThrow(/art gateways/);
  });
});


describe('MF23-2: revealed art bytes', () => {
  it('refuses wrong bytes, including a corrupt cache entry', async () => {
    const store = new MemoryArtStore();
    await store.put(sha(LOGO), OTHER);
    const get = vi.fn(async () => new Response(new Uint8Array(OTHER)));
    expect(await loadArt(sha(LOGO), { gateways: [gateway], store, fetch: get })).toBeNull();
  });
  it('skips a gateway whose body does not finish within 3 seconds', async () => {
    vi.useFakeTimers();
    try {
      const get = vi.fn(async (input: string | URL | Request) => String(input).includes('slow')
        ? new Response(new ReadableStream({ start() { /* never finishes */ } }))
        : new Response(new Uint8Array(LOGO)));
      const pending = loadArt(sha(LOGO), { gateways: ['https://slow.invalid', gateway], store: new MemoryArtStore(), fetch: get });
      await vi.advanceTimersByTimeAsync(3000);
      expect(await pending).toEqual(LOGO);
      expect(get).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
});

it('MF23-3: item parsing binds hashes and CIDs to the row, and drops art from unrevealed answers', () => {
  const { row } = synthBox({ boxId: 0n, creationBlock: 12n });
  const ref = { sha256: sha(LOGO), cid: rawCid(sha(LOGO)) };
  const item = {
    schema: 'sh.core-item.v1', chainId: row.chainId, token: row.contracts.token, id: '1',
    asOf: { block: '14', hash: `0x${'ab'.repeat(32)}`, timestamp: '1800000000', tier: 'head' },
    revealed: true, traitsPacked: '1', traits: [{ trait_type: 'Untrusted label', value: 'not the table' }],
    art: { image: ref, avatar: ref, model: ref },
  };
  expect(parseItemView(item, row).traits).not.toEqual(item.traits);
  expect(parseItemView(item, row).art?.image).toEqual(ref);
  expect(parseItemView({ ...item, revealed: false }, row)).toMatchObject({ art: null, traitsPacked: null, traits: [] });
  expect(() => parseItemView({ ...item, chainId: 1 }, row)).toThrow('wrong item');
  expect(() => parseItemView({ ...item, art: { ...item.art, image: { ...ref, cid: rawCid(sha(OTHER)) } } }, row)).toThrow('art CID mismatch');
});


it('MF23-3: the API serves verified reveal art only, including after a reorg during a fetch', async () => {
  const w = new World('art');
  const box = synthBox({ boxId: 0n, creationBlock: 12n });
  const token = box.row.contracts.token as string;
  w.block(10n); w.block(12n, [w.created(box)]); w.to(13n);
  const chain = w.chain([box]);
  const indexer = new CoreChainIndexer({ reader: chain, manifest: synthManifest() });
  await indexer.start();
  let requests = 0;
  let duringFetch = async () => {};
  const { source } = coreGatewaySource(indexer, chain, null, 60000, () => 0, {
    itemArt: async () => { requests++; await duringFetch(); return LOGO; },
  });
  const gateway = new CoreGateway({ source, host: 'fake', port: 0 });
  const call = async (path: string) => {
    let status = 0; let body: unknown;
    const res = { writeHead(code: number) { status = code; }, end(value: unknown) { body = value; } } as unknown as ServerResponse;
    await gateway.route({ method: 'GET', url: `/v1/boxes/11155111/${token}/items/1${path}` } as IncomingMessage, res);
    return { status, body };
  };
  expect((await call('')).status).toBe(200);
  expect(JSON.parse(String((await call('')).body))).toMatchObject({ revealed: false, art: null });
  expect((await call('/art/image')).status).toBe(404);
  expect(requests).toBe(0);
  w.block(14n, [[event(boxCollectionAbi, box.row.contracts.collection as Address, 'Revealed', { id: 1n, traitsPacked: 1n, imageHash: sha(LOGO), avatarHash: sha(COVER), modelHash: sha(OTHER) })]]);
  chain.setBranch(w.headers.filter((h) => h.number > 13n), w.logs.filter((l) => l.blockNumber > 13n));
  await indexer.enqueue(chain.header(14n));
  expect((await call('/art/image')).body).toEqual(LOGO);
  duringFetch = async () => {
    const fork = w.fork(13n, 'no-art'); fork.to(15n);
    chain.setBranch(fork.headers.filter((h) => h.number > 13n), []);
    await indexer.enqueue(chain.header(15n));
  };
  expect((await call('/art/image')).status).toBe(404);
  indexer.stop();
});

it('MF23-3 with v2 paths (CQ11-0 merge): item routes are v1 only; a /v2 box path never reaches the v1 item store', async () => {
  const token = `0x${'c0'.repeat(20)}`;
  const asOf = { block: '14', hash: `0x${'ab'.repeat(32)}`, timestamp: '1800000000', tier: 'head' };
  const item = vi.fn(() => ({ id: '1', revealed: true }));
  const items = vi.fn(() => [{ id: '1', revealed: true }]);
  const itemArt = vi.fn(async () => LOGO);
  const source = { chainId: 11_155_111, box: () => ({ asOf }), v2Box: () => ({ asOf }), item, items, itemArt } as unknown as CoreGatewaySource;
  const gateway = new CoreGateway({ source, host: 'fake', port: 0 });
  const call = async (path: string) => {
    let status = 0;
    const res = { writeHead(code: number) { status = code; }, end() {} } as unknown as ServerResponse;
    await gateway.route({ method: 'GET', url: path } as IncomingMessage, res);
    return status;
  };
  const subs = ['/items', '/items/1', '/items/1/art/image'];
  for (const sub of subs) expect(await call(`/v2/boxes/11155111/${token}${sub}`), sub).toBe(404);
  expect([item, items, itemArt].map((f) => f.mock.calls.length)).toEqual([0, 0, 0]);
  for (const sub of subs) expect(await call(`/v1/boxes/11155111/${token}${sub}`), sub).toBe(200);
  expect([item, items, itemArt].map((f) => f.mock.calls.length)).toEqual([2, 1, 1]);
});
