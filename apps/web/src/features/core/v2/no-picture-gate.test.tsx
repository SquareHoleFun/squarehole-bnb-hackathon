/**
 * SH-NO-PICTURE-GATE (founder 2026-10-24): the indexer lists a v2 box whether or not its pictures are available, so its
 * page renders right away. The snapshot comes from the indexer exactly as the server's CLI composes it (core-main.ts,
 * with a picture gateway configured, as infra/server/indexer.env does) and no gateway has the box's logo: before this
 * change the CLI's listing check kept that box unlisted (no snapshot, no page). A logo that no gateway has, or whose
 * bytes do not hash to the commitment, shows the plain tile: no words, no badge, never the gateway's bytes. Once the
 * matching bytes answer, the picture shows. Nothing leaves the machine: the chain is scripted and every fetch mocked.
 */
import { pngFixture } from '../../../../../../packages/artwork/src/picture-fixtures';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex, rawCidV1 } from '@squarehole/artwork';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { AppProviders } from '../../../app-providers';
import { resetPicturesForTests } from '../../boxes/box-pictures';
import { createDemoWalletAdapter } from '../../wallet';
import { parseSnapshotV2, type V2Source } from './indexer-v2';
import { recordV2 } from './record-v2';
import { required } from './test-support/required';
import { V2BoxPage } from './V2BoxPage';
import type { CoreReader } from '../../../../../../packages/indexer/src/core/core-reader';
import type { CoreServiceOptions, RunningCoreService } from '../../../../../../packages/indexer/src/core/core-service';
import { World } from '../../../../../../packages/indexer/test/core/core-synth';
import { boxLogsV2, serviceChainV2, synthManifestV2 } from '../../../../../../packages/indexer/test/core/scripted-core-chain';
import { synthBoxV2 } from '../../../../../../packages/chain/src/core/v2/test-support/synth-v2';
import { pictureLoaded } from './test-support/picture-loaded';

const cli = vi.hoisted(() => ({ reader: null as unknown, services: [] as unknown[] }));
vi.mock('./SafesV2', () => ({ SafesV2: () => null }));
vi.mock('./BurnLogV2', () => ({ BurnLogV2: () => null }));
// Only the listening address is a stand-in. Every other reader of the settings is the module's own, as on the server.
vi.mock('../../../../../../packages/indexer/src/core/core-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../../packages/indexer/src/core/core-config')>()),
  idleOptionsOf: () => ({ port: 5391, host: '127.0.0.1', manifestPollMs: 1000 }),
}));
vi.mock('../../../../../../packages/indexer/src/core/idle', () => ({ idleUntilDeployed: vi.fn() }));
// SH-BOX-CANDLES: the chart's drawing (jsdom has no canvas).
vi.mock('./candle-canvas', () => import('./test-support/candle-canvas-fake'));
vi.mock('../../../../../../packages/indexer/src/history/history-service', () => ({ startHistory: async () => null }));
vi.mock('../../../../../../packages/indexer/src/service', () => ({ logLine: vi.fn() }));
vi.mock('../../../../../../packages/indexer/src/core/redact', () => ({ redactConsole: vi.fn(), urlRedactor: vi.fn(), redactUrl: (url: string) => url }));
vi.mock('../../../../../../packages/indexer/src/core/core-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../../packages/indexer/src/core/core-service')>();
  return {
    ...actual,
    // The real service on the scripted chain, with the options core-main gives it: the pipeline only (no port, no head feed).
    startCoreService: vi.fn(async (options: CoreServiceOptions) => {
      const service = actual.createCoreService({ ...options, reader: cli.reader as CoreReader, port: 0 });
      await service.indexer.start();
      await service.indexer.idle();
      cli.services.push(service);
      return service;
    }),
  };
});
afterEach(() => { cleanup(); resetPicturesForTests(); });

const GATEWAY = 'http://127.0.0.1:5421';
const png = pngFixture;
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const LOGO = png(1);
const LOGO_SHA = sha256Hex(LOGO) as `0x${string}`;

/**
 * The CLI's snapshot of a new v2 box that commits LOGO, once per file: core-main runs with the server's picture gateway
 * configured, and that gateway has no file at all (404 for every path).
 */
let snapshot: Promise<{ body: unknown; source: V2Source }> | null = null;
function published(): Promise<{ body: unknown; source: V2Source }> {
  snapshot ??= (async () => {
    const box = synthBoxV2({ boxId: 8n, specOf: (spec) => ({ ...spec, coverSha256: LOGO_SHA }) });
    const manifest = synthManifestV2();
    const world = new World('web-no-picture-gate');
    world.block(10n); world.block(100n, [boxLogsV2(box)]); world.to(105n);
    cli.reader = serviceChainV2(world, [box]);
    const { idleUntilDeployed } = await import('../../../../../../packages/indexer/src/core/idle');
    vi.mocked(idleUntilDeployed).mockResolvedValue({
      manifest, httpUrls: ['http://127.0.0.1:9'], wsUrls: [], port: 5391, host: '127.0.0.1', pollMs: 1000,
      history: 'off', pg: { host: undefined, port: undefined, database: 'x', user: undefined },
      art: { gateways: [GATEWAY], dir: mkdtempSync(join(tmpdir(), 'sh-web-no-gate-')) }, maxStreamsPerClient: 3, trustedProxies: [],
    } as unknown as Awaited<ReturnType<typeof idleUntilDeployed>>);
    const on = vi.spyOn(process, 'on').mockReturnValue(process);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
    try {
      await import('../../../../../../packages/indexer/src/core/core-main');
      await vi.waitFor(() => expect(cli.services).toHaveLength(1), { timeout: 10_000 });
      const service = cli.services[0] as RunningCoreService;
      const body = required(service.indexer.v2BoxView(required(box.record.contracts[1])) ?? undefined);
      service.indexer.stop();
      const source: V2Source = { network: 'local', origin: 'https://indexer.invalid', rpc: 'http://127.0.0.1:8599', manifest, art: [GATEWAY] };
      return { body, source };
    } finally { on.mockRestore(); vi.unstubAllGlobals(); }
  })();
  return snapshot;
}

/** The page of a listed v2 box whose logo is `logo`, with a gateway answering `answer` for its raw CID. */
async function page(logo: Uint8Array, answer: Uint8Array | null) {
  const committed = sha256Hex(logo) as `0x${string}`;
  const { body, source } = await published();
  const view = parseSnapshotV2(body, source);
  const asked: string[] = [];
  resetPicturesForTests(vi.fn(async (input: RequestInfo | URL) => {
    asked.push(String(input));
    return answer && String(input) === `${GATEWAY}/ipfs/${rawCidV1(committed)}` ? new Response(answer.slice(), { status: 200 }) : new Response(null, { status: 404 });
  }) as unknown as typeof fetch);
  const { container } = render(<AppProviders walletAdapter={createDemoWalletAdapter({ latencyMs: 0 })}><MemoryRouter><V2BoxPage record={recordV2(view, source)} /></MemoryRouter></AppProviders>);
  // SH-255: the box's logo sits beside its name in the picture's head (a lazy chunk).
  await pictureLoaded();
  await waitFor(() => expect(asked).toEqual([`${GATEWAY}/ipfs/${rawCidV1(committed)}`]));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  return container;
}

/**
 * The header's box picture: the plain tile, no image, no text of its own. Its neutral cube stays (integrator, fix round
 * 1: a neutral shape is no trust label); no placeholder anywhere on the page carries a word or a badge about pictures.
 */
function expectPlainTile(container: HTMLElement) {
  expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
  const cover = container.querySelector('.sh-bpic-head .sh-box-cover');
  expect(cover?.getAttribute('data-art')).toBe('plain');
  expect(cover?.querySelector('img')).toBeNull();
  expect(cover?.querySelector('svg')).not.toBeNull();
  expect(cover?.textContent).toBe('');
  // The ticker initial on a lettered coin is drawn by CSS from data-letter: no text node, hidden from screen readers.
  for (const coin of container.querySelectorAll('.sh-box-coin')) {
    expect(coin.textContent).toBe('');
    expect(coin.getAttribute('aria-hidden')).toBe('true');
  }
  expect(container.textContent).not.toMatch(/verified picture|unverified picture|trusted|official|featured|no (?:image|picture)|picture (?:missing|unavailable|pending)|art not available/i);
}

it('BC-082: a box listed with its logo on no gateway shows the plain tile, with no words or badge', async () => {
  expectPlainTile(await page(png(1), null));
});

it('BC-082: a box listed while a gateway answers its logo with other bytes shows the plain tile, never those bytes', async () => {
  const other = png(2);
  const container = await page(png(1), other);
  expectPlainTile(container);
  expect(container.innerHTML).not.toContain(base64(other));
});

it('the same page shows the logo once the matching bytes answer (the check is the only condition)', async () => {
  const logo = png(1);
  const container = await page(logo, logo);
  await waitFor(() => expect(container.querySelector('.sh-bpic-head .sh-box-cover')?.getAttribute('data-art')).toBe('image'));
  expect(container.querySelector('.sh-bpic-head .sh-box-cover img')?.getAttribute('src')).toContain(base64(logo));
});
