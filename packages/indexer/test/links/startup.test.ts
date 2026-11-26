import { afterEach, expect, it, vi } from 'vitest';
import { idleUntilDeployed } from '../../src/core/idle';
import { startCoreService, type RunningCoreService } from '../../src/core/core-service';
import { logLine } from '../../src/service';
import { LINKS_SCHEMA_SQL } from '../../src/links/pg-links';
import type { CoreServiceConfig } from '../../src/core/core-config';
import { ERC1271_MAGIC_WORD } from '../../../chain/src/core/v2/box-links-v2';
import { CHAIN, HEAD } from './fixture';
import { requiredV2 } from '../core/scripted-core-chain';

const sql = vi.hoisted(() => ({ query: vi.fn(async () => ({ rows: [] })), end: vi.fn(async () => undefined) }));
// The picture store registers a pool error listener (SH-ARWEAVE-PICTURES-SRV), so the stand-in pool accepts on().
vi.mock('pg', () => ({ default: { Pool: class { query = sql.query; end = sql.end; on = vi.fn(); } } }));
// Only the listening address is a stand-in. Every other reader of the settings is the module's own, as on the server.
vi.mock('../../src/core/core-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/core-config')>()),
  idleOptionsOf: () => ({ port: 5391, host: '127.0.0.1', manifestPollMs: 1000 }),
}));
vi.mock('../../src/core/idle', () => ({ idleUntilDeployed: vi.fn() }));
vi.mock('../../src/core/core-service', () => ({ startCoreService: vi.fn() }));
vi.mock('../../src/history/history-service', () => ({ startHistory: async () => null }));
vi.mock('../../src/service', () => ({ logLine: vi.fn() }));
vi.mock('../../src/core/redact', () => ({ redactConsole: vi.fn(), urlRedactor: vi.fn(), redactUrl: (url: string) => new URL(url).origin }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('LINKS-SRV core_starting names the store; CLI wires an independent last-endpoint verifier and loads Postgres', async () => {
  vi.mocked(idleUntilDeployed).mockResolvedValue({ manifest: { chainId: CHAIN, network: 'sepolia' },
    httpUrls: ['https://follower.invalid/key', 'https://keyless.invalid/'], wsUrls: [], port: 5391, host: '127.0.0.1',
    pollMs: 1000, history: 'postgres', pg: { host: 'unused.invalid', database: 'unused' }, art: { gateways: [], dir: null },
    maxStreamsPerClient: 3, trustedProxies: [] } as unknown as CoreServiceConfig);
  vi.mocked(startCoreService).mockResolvedValue({ indexer: { head: () => null, boxes: new Map() }, stop: async () => undefined } as unknown as RunningCoreService);
  vi.spyOn(process, 'on').mockReturnValue(process);
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id: number; method: string };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: body.method === 'eth_getCode' ? '0x6000' : ERC1271_MAGIC_WORD }));
  }); vi.stubGlobal('fetch', fetch);
  await import('../../src/core/core-main');
  await vi.waitFor(() => expect(startCoreService).toHaveBeenCalledOnce());
  const options = requiredV2(vi.mocked(startCoreService).mock.calls[0])[0];
  try {
    expect(logLine).toHaveBeenCalledWith('core_starting', expect.objectContaining({ linksStore: 'postgres' }));
    expect(options.links?.store.kind).toBe('postgres'); expect(sql.query).toHaveBeenCalledWith(LINKS_SCHEMA_SQL, undefined);
    expect(options.pictures?.store.kind).toBe('postgres');
    expect(fetch).not.toHaveBeenCalled();
    const creator = `0x${'11'.repeat(20)}` as const;
    expect(await options.linksVerifier?.check(creator, HEAD.hash, '0x', HEAD.hash)).toBe('valid');
    expect(await options.linksVerifier?.check(creator, HEAD.hash, '0x', HEAD.hash)).toBe('valid');
    const requests = fetch.mock.calls.map(([, init]) => JSON.parse(String(init.body)) as { method: string; params: unknown[] });
    expect(requests.map(r => r.method)).toEqual(['eth_getCode', 'eth_call', 'eth_call']);
    expect(requests[0]?.params).toEqual([creator, { blockHash: HEAD.hash, requireCanonical: true }]);
    expect(fetch.mock.calls.every(([url]) => url === 'https://keyless.invalid/')).toBe(true);
  } finally { await options.links?.stop(); await options.pictures?.stop(); }
});
