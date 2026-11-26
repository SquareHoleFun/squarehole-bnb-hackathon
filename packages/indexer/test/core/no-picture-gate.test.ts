/**
 * SH-NO-PICTURE-GATE (founder 2026-10-24, answer 1: "remove the manual picture gate on our site"). The service as the
 * CLI composes it (core-main.ts, with the server's picture gateway configured, as infra/server/indexer.env does): a v2
 * box that passes the code checks is listed at its first sighting whether or not any gateway has its logo and
 * collection cover, and a restarted process lists it again with no picture reachable. Nothing is fetched to decide a
 * listing. Before this change the CLI handed the service a listing check, so these boxes waited off the feed ("art not
 * available") and a restart started the wait again. The page checks each picture's bytes (apps/web box-pictures.ts).
 *
 * Each "process" imports core-main afresh; `startCoreService` is replaced by the real `createCoreService` on a scripted
 * chain (no RPC, no port, nothing leaves the machine), and `fetch` is a stub gateway.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rawCid } from '../../src/core/art';
import type { CoreServiceOptions } from '../../src/core/core-service';
import type { CoreReader } from '../../src/core/core-reader';
import { World } from './core-synth';
import { boxLogsV2, requiredV2, serviceChainV2, synthManifestV2 } from './scripted-core-chain';
import { synthBoxV2 } from '../../../chain/src/core/v2/test-support/synth-v2';

const harness = vi.hoisted(() => ({
  reader: null as CoreReader | null,
  options: [] as CoreServiceOptions[],
  services: [] as { indexer: { stop(): void } ; source: { v2Feed?: () => { cards: readonly { token: string }[] } } }[],
}));

// Only the listening address is a stand-in. Every other reader of the settings is the module's own, as on the server.
vi.mock('../../src/core/core-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/core-config')>()),
  idleOptionsOf: () => ({ port: 5391, host: '127.0.0.1', manifestPollMs: 1000 }),
}));
vi.mock('../../src/core/idle', () => ({ idleUntilDeployed: vi.fn() }));
vi.mock('../../src/history/history-service', () => ({ startHistory: async () => null }));
vi.mock('../../src/service', () => ({ logLine: vi.fn() }));
vi.mock('../../src/core/redact', () => ({ redactConsole: vi.fn(), urlRedactor: vi.fn(), redactUrl: (url: string) => url }));
vi.mock('../../src/core/core-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/core-service')>();
  return {
    ...actual,
    // The real service on the scripted chain: the pipeline only (no gateway port, no head feed).
    startCoreService: vi.fn(async (options: CoreServiceOptions) => {
      harness.options.push(options);
      const service = actual.createCoreService({ ...options, reader: harness.reader as CoreReader, port: 0 });
      await service.indexer.start();
      await service.indexer.idle();
      harness.services.push(service);
      return service;
    }),
  };
});

const sha = (bytes: Uint8Array): Hex => `0x${createHash('sha256').update(bytes).digest('hex')}`;
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const LOGO = utf8('the first box logo, as PNG bytes would be');
const COVER = utf8('the first box collection cover');
const LOGO_B = utf8('the second box logo');
const OTHER = utf8('some other picture');

const GATEWAY = 'https://art.invalid';
const served = new Map<string, Uint8Array>();
const asked: string[] = [];
const gatewayFetch = vi.fn(async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  asked.push(url.pathname);
  const body = url.origin === GATEWAY ? served.get(url.pathname.slice('/ipfs/'.length)) : undefined;
  return body ? new Response(body.slice()) : new Response(null, { status: 404 });
});

/** Two v2 boxes: no gateway has the first one's pictures; a gateway answers the second one's logo with other bytes. */
function world() {
  const missing = synthBoxV2({ boxId: 8n, specOf: (s) => ({ ...s, coverSha256: sha(LOGO), collectionCoverSha256: sha(COVER) }) });
  const mismatched = synthBoxV2({ boxId: 9n, specOf: (s) => ({ ...s, coverSha256: sha(LOGO_B) }) });
  const w = new World('no-picture-gate');
  w.block(10n); w.block(100n, [boxLogsV2(missing), boxLogsV2(mismatched)]); w.to(105n);
  const tokens = [missing, mismatched].map((b) => requiredV2(b.record.contracts[1]).toLowerCase()).sort();
  return { chain: serviceChainV2(w, [missing, mismatched]), tokens };
}

/** One process start: core-main from a fresh module registry, with the configuration the server would load. */
async function startProcess(artDir: string) {
  vi.resetModules();
  const { idleUntilDeployed } = await import('../../src/core/idle');
  vi.mocked(idleUntilDeployed).mockResolvedValue({
    manifest: synthManifestV2(), httpUrls: ['http://127.0.0.1:9'], wsUrls: [], port: 5391, host: '127.0.0.1', pollMs: 1000,
    history: 'off', pg: { host: undefined, port: undefined, database: 'x', user: undefined },
    art: { gateways: [GATEWAY], dir: artDir }, maxStreamsPerClient: 3, trustedProxies: [],
  } as unknown as Awaited<ReturnType<typeof idleUntilDeployed>>);
  const before = harness.services.length;
  await import('../../src/core/core-main');
  await vi.waitFor(() => expect(harness.services).toHaveLength(before + 1), { timeout: 10_000 });
  const service = harness.services[before] as (typeof harness.services)[number];
  const options = harness.options[before] as CoreServiceOptions;
  const listed = () => (service.source.v2Feed?.().cards ?? []).map((c) => c.token.toLowerCase()).sort();
  return { service, options, listed };
}

beforeEach(() => {
  served.clear(); asked.length = 0; harness.options.length = 0; harness.services.length = 0;
  vi.stubGlobal('fetch', gatewayFetch);
  // Import the actual CLI without installing process handlers in the test worker.
  vi.spyOn(process, 'on').mockReturnValue(process);
});
afterEach(() => {
  for (const s of harness.services) s.indexer.stop();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('SH-NO-PICTURE-GATE: pictures never decide a listing; only matching bytes are ever served', () => {
  it('BC-082: a box whose pictures no gateway has, or answers with other bytes, is listed at its first sighting; nothing is fetched to decide it', async () => {
    const { chain, tokens } = world();
    harness.reader = chain;
    served.set(rawCid(sha(LOGO_B)), OTHER);
    const run = await startProcess(mkdtempSync(join(tmpdir(), 'sh-no-gate-')));
    expect(run.listed()).toEqual(tokens);
    expect(asked, 'no picture is asked for to decide a listing').toEqual([]);
    expect(run.options, 'the CLI hands the service no listing check').not.toHaveProperty('art');
  });

  it('BC-082: a restarted indexer lists the same boxes with no picture reachable anywhere', async () => {
    const { chain, tokens } = world();
    harness.reader = chain;
    const dir = mkdtempSync(join(tmpdir(), 'sh-no-gate-'));
    const first = await startProcess(dir);
    expect(first.listed()).toEqual(tokens);
    first.service.indexer.stop();
    // The restart: every gateway gone, nothing kept. The boxes are listed again at once.
    served.clear();
    const second = await startProcess(dir);
    expect(second.listed()).toEqual(tokens);
    expect(asked, 'no picture is asked for to decide a listing').toEqual([]);
    expect(readdirSync(dir), 'nothing is fetched or stored to decide a listing').toEqual([]);
  });
});
