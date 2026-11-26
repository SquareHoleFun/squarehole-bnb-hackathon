import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { CoreChainIndexer } from '../../src/core/chain-indexer';
import { loadCoreConfig } from '../../src/core/core-config';
import { CoreGateway, type ActivityPage, type CoreGatewaySource } from '../../src/core/core-gateway';
import { coreGatewaySource } from '../../src/core/core-service';
import { MemoryHistory } from '../../src/history/memory-history';
import { HistoryWriter } from '../../src/history/writer';
import { toJson } from '../../src/model';
import { sepoliaManifestChain } from '../fixtures/sepolia-manifest-chain';
import { World } from '../core/core-synth';
import { boxLogsV2, eventV2, serviceBoxV2, serviceChainV2, synthManifestV2, V2 } from '../core/scripted-core-chain';
import { required } from './fixture';

// Preserve the pre-cache route transport used by the Sepolia and set pipeline tests.
async function request(gateway: CoreGateway, url: string) {
  let status = 0, body = '';
  const headers: Record<string, string> = {};
  await gateway.route({ method: 'GET', url } as IncomingMessage, {
    writeHead(code: number, values: Record<string, string>) { status = code; Object.assign(headers, values); },
    end(value = '') { body = String(value); },
  } as unknown as ServerResponse);
  return { status, body: JSON.parse(body) as unknown, headers };
}

function withoutAsOf(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'asOf'));
}

async function fixture(v2: boolean, persisted: boolean) {
  const store = new MemoryHistory(), writer = new HistoryWriter(store);
  const setup = () => {
    if (!v2) {
      const { manifest } = loadCoreConfig({ SH_CORE_MANIFEST: fileURLToPath(new URL('../fixtures/sepolia-manifest-11155111.json', import.meta.url)) });
      if (!('releases' in manifest)) throw new Error('Sepolia fixture must include releases');
      const { chain, box } = sepoliaManifestChain(manifest);
      return { chain, manifest, token: required(box.row.contracts.token) };
    }
    const box = serviceBoxV2(), token = required(box.record.contracts[1]);
    const world = new World('cache-compatibility');
    world.block(10n); world.block(100n, [boxLogsV2(box)]);
    world.block(101n, [eventV2('poolManager', 'Swap', V2.poolManager, { id: box.record.poolId,
      sender: box.record.creator, amount0: 200n, amount1: -100n, sqrtPriceX96: 2n ** 96n, liquidity: 1_000n, tick: 0, fee: 10_000 })]);
    world.to(105n);
    return { chain: serviceChainV2(world, [box]), manifest: synthManifestV2(), token };
  };
  const { chain, manifest, token } = setup();
  const indexer = new CoreChainIndexer({ reader: chain, manifest, auditEvery: 10_000, onHistory: persisted ? writer.accept : undefined });
  await indexer.start(); await indexer.idle(); await writer.flush();
  expect(indexer.metrics.errors).toBe(0);
  const { source, updated } = coreGatewaySource(indexer, chain, persisted ? store : null, 60_000, () => 1000);
  updated();
  return { source, token, async stop() { indexer.stop(); await writer.stop(); await store.close(); } };
}

describe('CC-AF1: pre-cache status and serialized body compatibility', () => {
  for (const v2 of [false, true]) for (const persisted of [false, true]) {
    it.each(['both', 'asOf only', 'version only', 'neither'])(`v${v2 ? 2 : 1} boxes, history=${persisted}, getters=%s`, async getters => {
      const f = await fixture(v2, persisted);
      try {
        const source = { ...f.source };
        if (getters === 'version only' || getters === 'neither') delete source.asOf;
        if (getters === 'asOf only' || getters === 'neither') delete source.dataVersion;
        // These routes never needed the feed to answer. A legacy source need not support that extra read.
        const feed = vi.spyOn(source, 'feed').mockImplementation(() => { throw new Error('unexpected feed fallback'); });
        const box = vi.spyOn(source, v2 ? 'v2Box' : 'box');
        const gateway = new CoreGateway({ source, host: 'localhost', port: 0 });
        const mixed = `0x${f.token.slice(2).split('').map((c, i) => i % 2 ? c.toUpperCase() : c.toLowerCase()).join('')}`;
        for (const token of [f.token, mixed, f.token.toLowerCase(), mixed]) {
          const base = `/v${v2 ? 2 : 1}/boxes/${source.chainId}/${token}`;
          for (const query of ['', '?kind=trade&limit=1', '?before=00101-00000&limit=2']) {
            const params = new URLSearchParams(query);
            const page = await source.activity(token.toLowerCase(), { kind: params.get('kind'), before: params.get('before'), limit: Number(params.get('limit') ?? '50') });
            const response = await request(gateway, `${base}/activity${query}`);
            expect(response.status).toBe(page ? 200 : 404);
            expect(withoutAsOf(response.body)).toEqual(withoutAsOf(JSON.parse(toJson(page ?? { error: 'no activity' }))));
          }
          const candles = await source.candles(token.toLowerCase(), '1m', 1000);
          const response = await request(gateway, `${base}/candles?interval=1m`);
          expect(response.status).toBe(candles ? 200 : 404);
          expect(withoutAsOf(response.body)).toEqual(withoutAsOf(JSON.parse(toJson(candles ? { ...candles, interval: '1m' } : { error: 'no candles' }))));
        }
        expect(feed).not.toHaveBeenCalled();
        expect(box).toHaveBeenCalledTimes(16); // One existing admission read per request, no new fallback reads.
      } finally { await f.stop(); }
    });
  }

  it('keeps extra source fields on box pages and candles, and missing box pages remain 404', async () => {
    const f = await fixture(false, false);
    try {
      const activity = required(await f.source.activity(f.token, { kind: null, before: null, limit: 50 }));
      const candles = required(await f.source.candles(f.token, '1h'));
      const source = { ...f.source,
        activity: async () => ({ ...activity, sourceField: { amount: 12345678901234567890n } }),
        candles: async () => ({ ...candles, sourceField: 'retained' }),
      };
      const gateway = new CoreGateway({ source, host: 'localhost', port: 0 });
      const path = `/v1/boxes/${source.chainId}/${f.token}`;
      for (let i = 0; i < 2; i++) {
        expect(withoutAsOf((await request(gateway, `${path}/activity`)).body)).toEqual(withoutAsOf(JSON.parse(toJson(await source.activity()))));
        expect(withoutAsOf((await request(gateway, `${path}/candles`)).body)).toEqual(withoutAsOf(JSON.parse(toJson({ ...await source.candles(), interval: '1h' }))));
      }
      const missing = new CoreGateway({ source: { ...f.source, activity: async () => null, candles: async () => null }, host: 'localhost', port: 0 });
      for (const route of ['activity', 'candles']) expect(await request(missing, `${path}/${route}`)).toMatchObject({ status: 404, body: { error: `no ${route}` } });
    } finally { await f.stop(); }
  });

  it('passes every set activity shape through, including null, without a history version change', async () => {
    const f = await fixture(false, false);
    try {
      let page: unknown;
      const source: CoreGatewaySource = { ...f.source, setBox: token => f.source.box(token) as never,
        dataVersion: () => 1n, activity: async () => page as ActivityPage | null };
      const gateway = new CoreGateway({ source, host: 'localhost', port: 0 });
      const path = `/v2/sets/${source.chainId}/${f.token}/activity?before=00010-00002&kind=trade`;
      const read = vi.spyOn(source, 'activity');
      for (page of [
        { asOf: null, items: [{ amount: 999999999999999999n }], next: '10-2', extra: 'keep' },
        { schema: 'set-page', events: [{ id: 'replacement' }] }, [], null,
        { items: [], next: null },
      ]) {
        const expected = JSON.parse(toJson(await source.activity(f.token.toLowerCase(), { kind: null, before: '00010-00002', limit: 50 })));
        for (let i = 0; i < 2; i++) expect(await request(gateway, path)).toMatchObject({ status: 200, body: expected, headers: { 'Cache-Control': 'no-store' } });
      }
      expect(read).toHaveBeenCalledTimes(15);
      expect(read.mock.calls.every(([token, options]) => token === f.token.toLowerCase() && options.before === '00010-00002' && options.kind === null)).toBe(true);
    } finally { await f.stop(); }
  });
});
