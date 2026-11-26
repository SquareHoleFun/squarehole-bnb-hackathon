/**
 * SH-TA-12: the indexer's own answers for the COMMITTED Sepolia manifest, recorded for the test app's read-only e2e
 * (apps/web/e2e/sepolia-readonly). The pipeline (CoreChainIndexer) follows the scripted chain of sepolia-world.ts to
 * the manifest's evidence block, and the gateway's source (coreGatewaySource, what /v1 and /v2 answer) gives the
 * answers the app asks for: the v1 and v2 feeds, box 0's snapshot, activity and candles, and the v2 listing book.
 *
 * The fixture is checked byte for byte against a fresh run; `SH_WRITE_SEPOLIA_READONLY=1` rewrites it. Nothing here
 * calls a network: the scripted chain answers every read.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CoreChainIndexer } from '../../../src/core/chain-indexer';
import { coreGatewaySource } from '../../../src/core/core-service';
import { parseBoxView, parseFeedView } from '../../../src/client';
import { toJson } from '../../../src/model';
import { BLOCKS, BUY_AND_BURN_BLOCKS, SEPOLIA_MANIFEST_FILE, SUPPLY_AT_READ, sepoliaWorld } from './sepolia-world';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SEPOLIA_READONLY_FIXTURE = join(HERE, '../../../../../apps/web/e2e/fixtures/sepolia-readonly/indexer-answers.json');
const CANDLE_INTERVALS = ['1m', '1h', '1d'] as const;

/** Every answer the app may ask the gateway for, keyed by path (and query where the answer depends on it). */
async function answers() {
  const world = sepoliaWorld();
  const indexer = new CoreChainIndexer({ reader: world.chain, manifest: world.manifest as never, auditEvery: 1_000_000_000 });
  await indexer.start();
  await indexer.idle();
  const head = indexer.head();
  if (!head) throw new Error('the indexer applied no block');
  // The gateway as it answers at the head's time: following the chain (no stale flag).
  const nowMs = Number(head.timestamp) * 1000;
  const { source, updated } = coreGatewaySource(indexer, world.chain, null, 60_000, () => nowMs);
  updated();
  const chain = world.manifest.chainId;
  const token = (world.row.contracts.token as string).toLowerCase();
  const release = world.manifest.releases[0];
  if (!release) throw new Error('no v2 release');
  const out: Record<string, unknown> = {
    '/v1/feed': source.feed(),
    [`/v1/boxes/${chain}/${token}`]: source.box(token),
    [`/v1/boxes/${chain}/${token}/activity`]: await source.activity(token, { kind: null, before: null, limit: 30 }),
    // The revealed items' page (core-gateway.ts `items`): none of box 0's items is revealed in the life record.
    [`/v1/boxes/${chain}/${token}/items`]: { asOf: source.box(token)?.asOf ?? null, items: source.items?.(token, 0n, 24) ?? [], next: null },
    '/v2/feed': source.v2Feed?.(),
    [`/v2/listings/${chain}/${release.registry.address.toLowerCase()}`]: source.v2Listings?.(release.registry.address.toLowerCase()),
  };
  for (const interval of CANDLE_INTERVALS) {
    const answer = await source.candles(token, interval);
    out[`/v1/boxes/${chain}/${token}/candles?interval=${interval}`] = answer && { ...answer, interval };
  }
  indexer.stop();
  return { world, indexer, answers: JSON.parse(toJson(out)) as Record<string, unknown> };
}

function fixtureOf(answersJson: Record<string, unknown>, headTimestamp: string): string {
  const manifestSha256 = createHash('sha256').update(readFileSync(SEPOLIA_MANIFEST_FILE)).digest('hex');
  return `${JSON.stringify(
    {
      schema: 'sh.sepolia-readonly-indexer/v1',
      about: 'TEST FIXTURE (SH-TA-12): the indexer gateway source\'s answers for the committed Sepolia manifest, from packages/indexer/test/core/sepolia-readonly (a scripted chain of box 0 at its deployed identities and the empty v2 release). Rewrite: SH_WRITE_SEPOLIA_READONLY=1 pnpm exec vitest run --project indexer test/core/sepolia-readonly.',
      manifest: 'packages/contracts/deployments/core-v1/11155111.json',
      manifestSha256,
      headTimestamp,
      answers: answersJson,
    },
    null,
    2,
  )}\n`;
}

describe('SH-TA-12: the indexer on the committed Sepolia manifest', () => {
  it('reproduces the life record’s chain figures with the layout library and v4 math', () => {
    const { figures, row } = sepoliaWorld();
    // Graduated(poolShare 200824004616778209823865898, tokenDustBurned 21280) (f5-logs.json): exact.
    expect(figures.poolShare).toBe(200_824_004_616_778_209_823_865_898n);
    expect(figures.dust).toBe(21_280n);
    // F1 "about 1.59M T", F3 "663.15M T".
    expect(figures.f1TokensOut / 10n ** 22n).toBe(159n);
    expect(figures.f3TokensOut / 10n ** 16n).toBe(66_315_175_063n);
    expect(figures.supplyAtRead).toBe(SUPPLY_AT_READ);
    expect(row.specHash).toBe('0x56ae098ad2b0ff9622c14aa62d74014b2c5f2860349471eae9cbbfa7c6cdc286');
    expect(row.spec.tokenSymbol).toBe('RHT3');
    expect(BUY_AND_BURN_BLOCKS).toHaveLength(13);
  });

  it('shows box 0 graduated from the manifest’s registry alone, with no error; the v2 feed is empty; listing 0 is native ETH', async () => {
    const { world, indexer, answers: a } = await answers();
    expect(indexer.metrics.errors).toBe(0);
    expect(indexer.allRows().map((r) => [r.row.boxId, r.verdict.classification])).toEqual([[0n, 'shown']]);
    const token = (world.row.contracts.token as string).toLowerCase();
    const options = { chainId: 11_155_111, box0Registry: world.manifest.versions[0]?.registry.address as `0x${string}`, registries: world.manifest.versions.map((v) => v.registry.address) };
    const feed = parseFeedView(a['/v1/feed'], options);
    expect(feed.cards).toHaveLength(1);
    expect(feed.dropped).toBe(0);
    const card = feed.cards[0]?.card;
    expect(card?.phase).toBe('graduated');
    expect(card?.stale).toBe(false);
    expect(card?.fdvQ).not.toBeNull();
    expect(card?.asOf.block).toBe(world.manifest.evidence.block.number);
    const box = parseBoxView(a[`/v1/boxes/11155111/${token}`], options);
    expect(box.view.phase).toBe('graduated');
    expect(BigInt(box.view.supply.total)).toBe(SUPPLY_AT_READ);
    // The per-item stream as G5 and G6 left it: 48.2827 T per item, 96.57 T claimed.
    expect(box.view.reads?.['stream.index']?.slice(0, 6)).toBe('482827');
    expect(BigInt(box.view.stream.claimed) / 10n ** 16n).toBe(9656n);
    expect(box.view.vault.outside).toBe('2');
    expect((a['/v2/feed'] as { cards: unknown[] }).cards).toEqual([]);
    const listings = a[`/v2/listings/11155111/${world.manifest.releases[0]?.registry.address.toLowerCase()}`] as { listings: { id: number; token: string; class: string; detail: unknown }[] };
    expect(listings.listings.map((l) => [l.id, l.token, l.class])).toEqual([[0, '0x0000000000000000000000000000000000000000', 'NATIVE']]);
    expect(listings.listings[0]?.detail).not.toBeNull();
    const activity = a[`/v1/boxes/11155111/${token}/activity`] as { items: { kind: string; block: string }[] };
    // The newest 30: G7's skipped deepen first, then its buy-and-burns and conversions.
    expect(activity.items).toHaveLength(30);
    expect(activity.items[0]).toMatchObject({ kind: 'deepen_skipped', block: String(BLOCKS.g7Skipped) });
    expect(activity.items.filter((i) => i.kind === 'buyback').map((i) => i.block)).toEqual(BUY_AND_BURN_BLOCKS.map(String).reverse());
  });

  it('the recorded fixture is this run’s output, byte for byte (SH_WRITE_SEPOLIA_READONLY=1 rewrites it)', async () => {
    const { answers: a, world } = await answers();
    const head = world.headers.at(-1)?.timestamp;
    const text = fixtureOf(a, String(head));
    if (process.env.SH_WRITE_SEPOLIA_READONLY === '1') {
      mkdirSync(dirname(SEPOLIA_READONLY_FIXTURE), { recursive: true });
      writeFileSync(SEPOLIA_READONLY_FIXTURE, text);
    }
    expect(existsSync(SEPOLIA_READONLY_FIXTURE), 'run with SH_WRITE_SEPOLIA_READONLY=1 once').toBe(true);
    expect(readFileSync(SEPOLIA_READONLY_FIXTURE, 'utf8')).toBe(text);
  });
});
