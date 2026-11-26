/**
 * SH-TA-12: the indexer's recorded answers for the committed Sepolia manifest (e2e/fixtures/sepolia-readonly, written
 * by packages/indexer/test/core/sepolia-readonly) pass the app's own checks with the build the Sepolia test site ships:
 * the committed manifest and the indexer at https://api.squarehole.fun. Box 0 comes from the indexer (not a direct
 * read), the v2 feed is empty and parses, and Create's listing book offers ETH. No network: the fetcher answers.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import fixture from '../../../e2e/fixtures/sepolia-readonly/indexer-answers.json' with { type: 'json' };
import SEPOLIA_MANIFEST from '../../../../../packages/contracts/deployments/core-v1/11155111.json' with { type: 'json' };
import { loadListingsV2 } from '../create/v2/indexer-listings';
import type { TokenReader } from '../create/v2/issuer-powers';
import { coreSourceFor } from './core-build';
import { loadBox, loadFeed, type DirectReader, type Fetcher } from './core-client';
import { loadFeedV2, sourceV2 } from './v2/indexer-v2';
import { recordFromRow } from './row-record';
import { rowSummary } from './row-summary';
import { NO_FIGURE } from './v2/stats-v2';

const API = 'https://api.squarehole.fun';
const BUILD = { manifests: [SEPOLIA_MANIFEST], localRpcUrl: '', indexers: { local: null, sepolia: API }, artGateways: { local: [], sepolia: [API] } };
const answers = fixture.answers as Record<string, unknown>;
const asked: string[] = [];
const fetcher: Fetcher = async (url) => {
  const { origin, pathname, search } = new URL(url);
  asked.push(`${pathname}${search}`);
  const body = origin === API ? (answers[`${pathname}${search}`] ?? answers[pathname]) : undefined;
  return { ok: body !== undefined, status: body === undefined ? 404 : 200, json: async () => body };
};
/** A direct chain read would mean the indexer's answer failed its checks: refused here. */
const NO_CHAIN: DirectReader = { feed: () => Promise.reject(new Error('read the chain')), box: () => Promise.reject(new Error('read the chain')), wallet: () => Promise.reject(new Error('read the chain')) };
const NO_TOKEN_READS = new Proxy({}, { get: () => () => Promise.reject(new Error('no token read for native ETH')) }) as unknown as TokenReader;

describe('SH-TA-12: the recorded indexer answers on the committed Sepolia manifest', () => {
  it('were recorded for this manifest, byte for byte', () => {
    const file = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/contracts/deployments/core-v1/11155111.json');
    expect(fixture.manifestSha256).toBe(createHash('sha256').update(readFileSync(file)).digest('hex'));
  });

  it('box 0 from the indexer: graduated, its FDV, price and burned, checked against the manifest’s registry', async () => {
    const core = coreSourceFor('sepolia', BUILD, 'https://ethereum-sepolia-rpc.publicnode.com');
    if (core.status !== 'ready') throw new Error(core.status);
    expect(core.indexerOrigin).toBe(API);
    const feed = await loadFeed(core, fetcher, NO_CHAIN);
    expect(feed.via).toBe('indexer');
    expect(feed.dropped).toBe(0);
    expect(feed.cards).toHaveLength(1);
    const [{ row, card }] = feed.cards as [(typeof feed.cards)[number]];
    expect([row.isBox0, row.boxId, row.registry, row.spec.tokenSymbol]).toEqual([true, 0n, SEPOLIA_MANIFEST.versions[0]?.registry.address, 'RHT3']);
    expect([card.phase, card.fdvQ, card.qPerT, card.burnedT]).toEqual(['graduated', '2059653188837633132', '0.000000002064940883', '2560700439204227628053081']);
    // The card: FDV the figure, the price per 1M and the T burned under it; a dash for an older gateway's card.
    const record = recordFromRow({ row, network: 'sepolia' }, { nowMs: 0 });
    const summary = rowSummary(record, row, card);
    expect(summary.figure.text).toBe('FDV 2.05 ETH');
    expect(summary.cells).toEqual([['Price', '0.0020649'], ['Burned', '2.56M']]);
    const older = { ...card };
    delete older.burnedT;
    expect(rowSummary(record, row, older).cells).toEqual([['Price', '0.0020649'], ['Burned', NO_FIGURE]]);
    expect(rowSummary(record, row, { ...card, verified: false }).cells?.[0]).toEqual(['Price', NO_FIGURE]);
    expect(rowSummary(record, row, { ...card, phase: 'upcoming' }).cells).toBeUndefined();
    const box = await loadBox(core, (row.contracts.token as string).toLowerCase(), fetcher, NO_CHAIN);
    expect(box?.indexerError).toBeUndefined();
    expect(box?.view.vault.collectionSize).toBe('4269');
  });

  it('the v2 feed: empty, and a valid answer; Create’s listing book offers native ETH (listing 0)', async () => {
    const source = sourceV2('sepolia', BUILD);
    if (!source) throw new Error('no v2 source');
    expect(source.art).toEqual([API]);
    expect(await loadFeedV2(source, fetcher)).toEqual([]);
    const listings = await loadListingsV2(source, fetcher, NO_TOKEN_READS);
    expect(listings.map((l) => [l.id, l.symbol, l.token, l.raise, l.bootstrap])).toEqual([[0, 'ETH', '0x0000000000000000000000000000000000000000', 4_206_980_085_000_000_000n, 1_500_000_000_000_000n]]);
    expect(asked).toContain('/v2/listings/11155111/0x5d2866ef084d801ae734d3a2a6e4f7179898737c');
  });
});
