/** SH-TA-11: the committed Sepolia release shape, through the real pipeline without RPCs or listeners. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { labelAddress } from '@squarehole/chain/core/test-support';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreChainIndexer } from '../../src/core/chain-indexer';
import { loadCoreConfig } from '../../src/core/core-config';
import { CoreGateway } from '../../src/core/core-gateway';
import { coreGatewaySource } from '../../src/core/core-service';
import { nativeListing, sepoliaManifestChain } from '../fixtures/sepolia-manifest-chain';
import { requiredV2, ScriptedCoreChain } from './scripted-core-chain';
import { World } from './core-synth';

const fixture = new URL('../fixtures/sepolia-manifest-11155111.json', import.meta.url);
const committed = new URL('../../../contracts/deployments/core-v1/11155111.json', import.meta.url);
const config = loadCoreConfig({ SH_CORE_MANIFEST: fileURLToPath(fixture) });
if (!('releases' in config.manifest)) throw new Error('Sepolia fixture must include releases');
const manifest = config.manifest;
const v1 = requiredV2(manifest.versions[0]);
const v2 = requiredV2(manifest.releases[0]);

afterEach(() => vi.restoreAllMocks());

async function request(gateway: CoreGateway, url: string, method = 'GET') {
  const response = { status: 0, headers: {} as Record<string, string>, body: '',
    writeHead(status: number, headers: Record<string, string>) { this.status = status; this.headers = headers; },
    end(body = '') { this.body = body; },
  };
  await gateway.route({ method, url } as IncomingMessage, response as unknown as ServerResponse);
  return { status: response.status, headers: response.headers, body: response.body, json: JSON.parse(response.body) as unknown };
}

async function follow(withRelease = true, listingBlock?: bigint) {
  const { chain, box, world } = sepoliaManifestChain(manifest, listingBlock);
  const indexer = new CoreChainIndexer({ reader: chain, manifest: withRelease ? manifest : { ...manifest, releases: [] }, auditEvery: 10_000 });
  await indexer.start();
  await indexer.idle();
  expect(indexer.metrics.errors, indexer.metrics.lastError ?? '').toBe(0);
  const { source, updated } = coreGatewaySource(indexer, chain, null, 60_000, () => 1000);
  updated();
  const gateway = new CoreGateway({ source, host: '127.0.0.1', port: 0 });
  return { chain, box, world, indexer, gateway };
}

describe('SH-TA-11 Sepolia manifest', () => {
  it('is a byte-for-byte fixture of the committed manifest and loads both start blocks', () => {
    expect(readFileSync(fixture)).toEqual(readFileSync(committed));
    expect(manifest.chainId).toBe(11155111);
    expect(manifest.network).toBe('sepolia');
    expect(v1.startBlock).toBe('11960339');
    expect(v2.startBlock).toBe('11973601');
  });

  it.each([false, true])('backfills each registry from its own manifest start block (relocated release: %s)', async relocated => {
    const release = relocated ? { ...v2, startBlock: String(BigInt(v2.startBlock) + 100n),
      registry: { ...v2.registry, address: labelAddress('ta11:another-registry') },
      listingRegistry: { ...v2.listingRegistry, address: labelAddress('ta11:another-listing-registry') },
    } : v2;
    const input = { ...manifest, releases: [release] };
    const world = new World('sepolia-manifest');
    world.block(BigInt(v1.startBlock));
    world.to(BigInt(manifest.evidence.block.number));
    const chain = new ScriptedCoreChain(manifest.chainId, world.headers, world.logs);
    const range = vi.spyOn(chain, 'rangeLogs');
    const indexer = new CoreChainIndexer({ reader: chain, manifest: input });
    try {
      await indexer.start();
      await indexer.idle();
      expect(indexer.metrics.errors).toBe(0);
      expect(indexer.head()?.number).toBe(chain.tip);
      for (const [address, start] of [
        [v1.registry.address, v1.startBlock],
        [release.registry.address, release.startBlock],
        [release.listingRegistry.address, release.startBlock],
      ] as const) {
        const calls = range.mock.calls.filter(([, , filter]) => filter.addresses.some(a => a.toLowerCase() === address.toLowerCase()));
        expect(calls.length).toBeGreaterThan(0);
        expect(calls[0]?.[0], address).toBe(BigInt(start));
        expect(calls.every(([from]) => from >= BigInt(start))).toBe(true);
      }
    } finally { indexer.stop(); }
  });

  it('serves an empty sh.core-feed.v2 and the ETH listing through the real gateway routes', async () => {
    const { indexer, gateway, chain, box } = await follow();
    try {
      expect(indexer.allRows().map(({ row, verdict }) => [row.boxId, verdict.classification])).toEqual([[0n, 'shown']]);
      expect(indexer.boxesV2.size).toBe(0);
      const feed = await request(gateway, '/v2/feed?chain=11155111');
      expect(feed.status).toBe(200);
      expect(feed.json).toMatchObject({ schema: 'sh.core-feed.v2', chainId: 11155111, cards: [], hidden: [],
        asOf: { block: String(chain.tip), hash: chain.header(chain.tip).hash },
        platform: [{ registry: v2.registry.address.toLowerCase() }],
      });
      expect(feed.headers['Content-Type']).toBe('application/json; charset=utf-8');
      expect(feed.headers['Access-Control-Allow-Origin']).toBe('*');
      const listings = await request(gateway, `/v2/listings/11155111/${v2.registry.address}`);
      expect(listings.status).toBe(200);
      expect(listings.json).toEqual({ schema: 'sh.core-listings.v2', chainId: 11155111,
        registry: v2.registry.address.toLowerCase(), asOf: indexer.asOf(),
        listings: [{ id: 0, token: nativeListing.token, class: 'NATIVE', kind: 'LISTED', raise: '4206980085000000000',
          detail: { id: 0, token: nativeListing.token, class: 'NATIVE', kind: 'LISTED', decimals: 18,
            listedAt: '1792721424', raise: '4206980085000000000',
            q: { bootstrapQ: '1500000000000000', batchMinQ: '1', tipMaxQ: '1', swapStepMinQ: '1' } },
        }],
      });
      expect((await request(gateway, '/v2/feed?chain=1')).status).toBe(404);
      expect((await request(gateway, `/v2/listings/1/${v2.registry.address}`)).status).toBe(404);
      expect((await request(gateway, `/v2/listings/11155111/${v1.registry.address}`)).status).toBe(404);
      expect((await request(gateway, `/v2/listings/11155111/${v2.listingRegistry.address}`)).status).toBe(404);
      expect((await request(gateway, `/v2/boxes/11155111/${box.row.contracts.token}`)).status).toBe(404);
    } finally { indexer.stop(); }
  });

  it('keeps the v1 box 0 feed, detail, activity and candles identical with and without the release', async () => {
    const mixed = await follow();
    const old = await follow(false);
    try {
      const token = requiredV2(mixed.box.row.contracts.token ?? undefined);
      const base = `/v1/boxes/11155111/${token}`;
      for (const path of ['/v1/feed?chain=11155111', base, `${base}/activity`, `${base}/candles?interval=1m`]) {
        const got = await request(mixed.gateway, path);
        expect(got.status, path).toBe(200);
        expect(got).toEqual(await request(old.gateway, path));
      }
      expect((await request(mixed.gateway, base)).json).toMatchObject({ schema: 'sh.core-box.v1',
        row: { registry: v1.registry.address, isBox0: true, record: { boxId: '0', creationBlock: v1.startBlock } }, supply: { total: '1000000000000000000000000000' } });
      expect((await request(mixed.gateway, base, 'POST')).status).toBe(405);
      expect((await request(mixed.gateway, `/v1/boxes/1/${token}`)).status).toBe(404);
    } finally { mixed.indexer.stop(); old.indexer.stop(); }
  });

  it('does not poll future release registries, then discovers the listing on the release start block', async () => {
    const start = BigInt(v2.startBlock);
    const { chain } = sepoliaManifestChain(manifest, start);
    chain.tip = start - 2n;
    const range = vi.spyOn(chain, 'rangeLogs');
    const hashes = vi.spyOn(chain, 'logsByHash');
    const indexer = new CoreChainIndexer({ reader: chain, manifest, auditEvery: 10_000 });
    const future = [v2.registry.address, v2.listingRegistry.address].map(a => a.toLowerCase());
    try {
      await indexer.start();
      chain.tip = start - 1n;
      await indexer.enqueue(chain.header(chain.tip));
      expect(indexer.metrics.errors).toBe(0);
      const filters = [...range.mock.calls.map(([, , filter]) => filter), ...hashes.mock.calls.map(([, filter]) => filter)];
      expect(filters.every(f => f.addresses.every(a => !future.includes(a.toLowerCase())))).toBe(true);
      expect(indexer.listingsV2(v2.registry.address).listings).toEqual([]);
      chain.tip = start;
      await indexer.enqueue(chain.header(start));
      expect(indexer.metrics.errors).toBe(0);
      expect(hashes.mock.calls.some(([hash, filter]) => hash === chain.header(start).hash
        && future.every(a => filter.addresses.some(address => address.toLowerCase() === a)))).toBe(true);
      expect(indexer.listingsV2(v2.registry.address).listings).toMatchObject([{ id: 0, class: 'NATIVE' }]);
      // A later long gap resumes every active registry after the retained head, without replaying its deployment.
      range.mockClear();
      chain.tip = BigInt(manifest.evidence.block.number);
      await indexer.enqueue(chain.header(chain.tip));
      expect(indexer.head()?.number).toBe(chain.tip);
      expect(indexer.metrics.errors).toBe(0);
      const resumed = range.mock.calls.filter(([, , filter]) => filter.addresses.includes(v1.registry.address));
      expect(resumed).toHaveLength(1);
      expect(resumed[0]?.[0]).toBe(start + 1n);
      expect(resumed[0]?.[2].addresses).toEqual([v1.registry.address, v2.registry.address, v2.listingRegistry.address]);
    } finally { indexer.stop(); }
  });

  it('publishes neither registry on a failed release range read and retries with the same anchors', async () => {
    const { chain } = sepoliaManifestChain(manifest);
    const read = chain.rangeLogs.bind(chain);
    let failRelease = true;
    const range = vi.spyOn(chain, 'rangeLogs').mockImplementation(async (from, to, filter, anchors) => {
      if (failRelease && filter.addresses.includes(v2.registry.address)) throw new Error('release range unavailable');
      return read(from, to, filter, anchors);
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const indexer = new CoreChainIndexer({ reader: chain, manifest, auditEvery: 10_000 });
    try {
      await indexer.start();
      expect(indexer.metrics.errors).toBe(1);
      expect(errors).toHaveBeenCalledWith(expect.stringContaining('release range unavailable'));
      expect(indexer.head()).toBeNull();
      expect(indexer.allRows()).toEqual([]);
      expect(indexer.listingsV2(v2.registry.address).listings).toEqual([]);
      expect(range.mock.calls).toHaveLength(2);
      const first = requiredV2(range.mock.calls[0]);
      const second = requiredV2(range.mock.calls[1]);
      expect(second[0]).toBe(BigInt(v2.startBlock));
      expect(second[1]).toBe(first[1]);
      expect(second[3]).toEqual([{ number: first[1], hash: chain.header(first[1]).hash }]);
      expect(second[3]).toEqual(first[3]);
      failRelease = false;
      await indexer.enqueue(chain.header(chain.tip));
      expect(indexer.head()?.number).toBe(chain.tip);
      expect(indexer.metrics.errors).toBe(1); // no additional error on retry
      expect(indexer.allRows().map(({ row }) => row.boxId)).toEqual([0n]);
      expect(indexer.listingsV2(v2.registry.address).listings).toMatchObject([{ id: 0, class: 'NATIVE' }]);
    } finally { indexer.stop(); }
  });
});
