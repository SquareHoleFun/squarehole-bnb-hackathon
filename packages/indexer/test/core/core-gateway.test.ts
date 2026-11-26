/**
 * The core gateway (S10a § 3.5): one feed answer for every card (BC-085), each box's row and snapshot, the activity
 * pages and candles, wallets grouped by box address (BC-089), the SSE stream; `asOf` and decimal strings on every
 * answer; bad input refused. On a synthetic chain with three boxes, two of them sharing a ticker.
 */
import { labelAddress } from '@squarehole/chain/core/test-support';
import { BOX_0_MISFITS } from '@squarehole/box-spec';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CoreChainIndexer } from '../../src/core/chain-indexer';
import { CoreGateway } from '../../src/core/core-gateway';
import type { CoreReader } from '../../src/core/core-reader';
import { coreGatewaySource } from '../../src/core/core-service';
import { parseFeedView, parseWalletView, parseBoxView } from '../../src/core/core-views';
import { getSqrtPriceAtTick } from '../../src/v4-math';
import { ev, REGISTRY, synthBox, synthManifest, World, type SynthBox } from './core-synth';
import { parseSnapshotV2 } from '../../../../apps/web/src/features/core/v2/indexer-v2';
import { A, B, required, replayVaultInventory, vaultInventoryFixture, vaultInventoryWorld } from '../../src/core/v2/vault-inventory-fixture.test-support';
import { request, ResponseDouble } from '../links/fixture';

const ALICE = labelAddress('alice');
let gateway: CoreGateway;
let base = '';
let boxes: SynthBox[];
let indexer: CoreChainIndexer;
let reader: CoreReader;

const options = { chainId: 11_155_111, box0Registry: REGISTRY, registries: [REGISTRY] };

describe('the core gateway', () => {
  beforeAll(async () => {
    const w = new World();
    // Two boxes with the same ticker (FIT) and one other; Alice holds T of two of them.
    boxes = [synthBox({ boxId: 0n, creationBlock: 12n }), synthBox({ boxId: 1n, creationBlock: 13n }), synthBox({ boxId: 2n, creationBlock: 14n, spec: { ...BOX_0_MISFITS, tokenSymbol: 'KITE' } })];
    w.block(10n);
    for (const box of boxes) w.block(box.row.creationBlock, [w.created(box, [ev.initialize(box, getSqrtPriceAtTick(-30_000), -30_000), ev.mint(box, labelAddress('pool'), 10n ** 27n)])]);
    for (let n = 15n; n <= 40n; n += 1n) {
      const box = boxes[Number(n) % 2] as SynthBox;
      w.block(n, [[ev.swap(box, { amount0: -(10n ** 16n), amount1: 10n ** 21n, sqrtPriceX96: getSqrtPriceAtTick(-30_000 - Number(n)), tick: -30_000 - Number(n), liquidity: 10n ** 20n }), ev.transfer(box, labelAddress('pool'), ALICE, 10n ** 21n)]]);
    }
    const chain = w.chain();
    reader = chain;
    chain.callAnswers = () => `0x${'0'.repeat(64)}`;
    indexer = new CoreChainIndexer({ reader: chain, manifest: synthManifest() });
    await indexer.start();
    await indexer.idle();
    const { source } = coreGatewaySource(indexer, chain, null, 60_000);
    gateway = new CoreGateway({ source, port: 0, host: '127.0.0.1' });
    await gateway.start();
    base = `http://127.0.0.1:${gateway.address().port}`;
  });

  afterAll(async () => {
    await gateway.stop();
  });

  it('BC-085: GET /v1/feed: one answer, one card per shown box with its own phase and figures, asOf on each', async () => {
    const res = await fetch(`${base}/v1/feed?chain=11155111`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const parsed = parseFeedView(await res.json(), options);
    expect(parsed.dropped).toBe(0);
    expect(parsed.cards.map((c) => c.row.boxId)).toEqual([0n, 1n, 2n]);
    expect(parsed.cards.map((c) => c.card.asOf.block)).toEqual(['40', '40', '40']);
    // Each card its own figure: boxes 0 and 1 last traded at different prices, box 2 not at all.
    expect(new Set(parsed.cards.map((c) => c.card.qPerT)).size).toBe(3);
    expect(parsed.cards.map((c) => c.card.volumeQ === '0')).toEqual([false, false, true]);
    expect((await fetch(`${base}/v1/feed?chain=1`)).status).toBe(404);
  });

  it('GET /v1/boxes/<chain>/<token>: the row and the snapshot; 404 for an unknown token, 400 for a malformed one', async () => {
    const token = (boxes[0] as SynthBox).row.contracts.token as string;
    const res = await fetch(`${base}/v1/boxes/11155111/${token}`);
    const { row, view } = parseBoxView(await res.json(), options);
    expect(row.boxId).toBe(0n);
    expect(view.asOf.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(view.supply.total).toBe((10n ** 27n).toString());
    expect((await fetch(`${base}/v1/boxes/11155111/0x${'1'.repeat(40)}`)).status).toBe(404);
    expect((await fetch(`${base}/v1/boxes/11155111/nope`)).status).toBe(400);
    expect((await fetch(`${base}/v1/boxes/1/${token}`)).status).toBe(404);
    expect((await fetch(`${base}/v1/boxes/11155111/${token}`, { method: 'POST' })).status).toBe(405);
  });

  it('activity pages newest first with a cursor, and candles', async () => {
    const token = (boxes[1] as SynthBox).row.contracts.token as string;
    const page = (await (await fetch(`${base}/v1/boxes/11155111/${token}/activity?limit=5&kind=trade`)).json()) as { items: { block: string; logIndex: number; kind: string }[]; next: string | null };
    expect(page.items).toHaveLength(5);
    expect(page.items.every((i) => i.kind === 'trade')).toBe(true);
    expect(page.next).toMatch(/^\d+-\d+$/);
    const next = (await (await fetch(`${base}/v1/boxes/11155111/${token}/activity?limit=5&kind=trade&before=${page.next}`)).json()) as { items: { block: string }[] };
    expect(BigInt(next.items[0]?.block ?? '0')).toBeLessThan(BigInt(page.items.at(-1)?.block ?? '0'));
    expect((await fetch(`${base}/v1/boxes/11155111/${token}/activity?limit=500`)).status).toBe(400);
    expect((await fetch(`${base}/v1/boxes/11155111/${token}/activity?before=x`)).status).toBe(400);
    const candles = (await (await fetch(`${base}/v1/boxes/11155111/${token}/candles?interval=1m`)).json()) as { candles: { trades: number }[]; asOf: unknown };
    expect(candles.candles.reduce((n, c) => n + c.trades, 0)).toBe(13);
    expect((await fetch(`${base}/v1/boxes/11155111/${token}/candles?interval=5m`)).status).toBe(400);
  });

  it('BC-089: GET /v1/wallets: every box the address holds, keyed by box address (two with the same ticker stay apart)', async () => {
    const res = await fetch(`${base}/v1/wallets/11155111/${ALICE}`);
    const parsed = parseWalletView(await res.json(), options);
    expect(parsed.boxes.map((b) => b.row.spec.tokenSymbol)).toEqual(['FIT', 'FIT']);
    expect(new Set(parsed.boxes.map((b) => b.box.token)).size).toBe(2);
    expect(parsed.boxes.map((b) => b.box.t)).toEqual([(13n * 10n ** 21n).toString(), (13n * 10n ** 21n).toString()]);
    expect((await fetch(`${base}/v1/wallets/11155111/nope`)).status).toBe(400);
  });

  it('the SSE stream sends the snapshot now', async () => {
    const token = (boxes[2] as SynthBox).row.contracts.token as string;
    const controller = new AbortController();
    const res = await fetch(`${base}/v1/boxes/11155111/${token}/stream`, { signal: controller.signal });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = res.body?.getReader();
    let text = '';
    while (reader && !text.includes('event: snapshot')) text += new TextDecoder().decode((await reader.read()).value);
    controller.abort();
    expect(text).toContain('"schema":"sh.core-box.v1"');
  });

  it('healthz answers while the indexer follows', async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(503); // no block arrived since the source was wired
    expect(indexer.head()?.number).toBe(40n);
  });

  it('BC-094: every box and card is Stale while the chain is not heard from or the index lags; /healthz says why, and reports a failing history writer', async () => {
    let now = 1_000_000;
    let heard: number | null = now;
    let newest: bigint | null = 40n;
    let history = { ok: true, relisting: 0, pending: 0, lastError: null as string | null, failures: 0, failingSinceMs: null, written: 1 };
    const { source } = coreGatewaySource(indexer, reader, null, 60_000, () => now, {
      liveness: { lastHeardMs: () => heard, newestSeen: () => newest },
      historyHealth: () => history,
    });
    const token = (boxes[0] as SynthBox).row.contracts.token as string;
    // Heard a moment ago, at the index's head: followed, nothing Stale (a quiet chain is followed too).
    now += 30_000;
    expect(source.health()).toMatchObject({ following: true, reason: null });
    expect(source.box(token)?.stale).toBe(false);
    expect(source.feed().cards.every((c) => !c.stale)).toBe(true);
    // The chain not heard from for over a minute (RPC failures, a stalled feed): Stale everywhere.
    now += 31_000;
    expect(source.health()).toMatchObject({ following: false });
    expect(source.box(token)?.stale).toBe(true);
    expect(source.feed().cards.every((c) => c.stale)).toBe(true);
    // Heard again, but the chain is 5 blocks ahead of the index (it cannot apply them): still Stale.
    heard = now;
    newest = 45n;
    expect(source.health().reason).toMatch(/the index is at block 40, the chain at 45/);
    expect(source.box(token)?.stale).toBe(true);
    // Caught up: fresh again. A failing history writer does not make boxes Stale, but /healthz reports it.
    newest = 41n;
    history = { ...history, ok: false, pending: 7, lastError: 'block 30: connection reset', failures: 3 };
    expect(source.box(token)?.stale).toBe(false);
    const gw = new CoreGateway({ source, port: 0, host: '127.0.0.1' });
    await gw.start();
    try {
      const res = await fetch(`http://127.0.0.1:${gw.address().port}/healthz`);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ ok: false, following: true, history: { ok: false, pending: 7, lastError: 'block 30: connection reset' } });
    } finally {
      await gw.stop();
    }
  });
});

// Exercise the real route with the existing HTTP doubles; no listening socket is needed.
it('SH-235: publishes a no-items-side vault inventory with decimal IDs at the feed asOf, without payout fields', async () => {
  const f = vaultInventoryFixture();
  const { indexer: v2, chain } = await replayVaultInventory(vaultInventoryWorld(f), f);
  const { source } = coreGatewaySource(v2, chain, null, 60_000);
  const gw = new CoreGateway({ source, port: 0, host: '127.0.0.1' });
  const send = async (url: string) => {
    const res = new ResponseDouble();
    await gw.route(request(undefined, { method: 'GET', url }).req, res.asResponse());
    expect(res.status).toBe(200);
    return res.json();
  };
  try {
    const feed = await send(`/v2/feed?chain=${f.manifest.chainId}`) as ReturnType<typeof v2.v2FeedView>;
    expect(feed.cards).toHaveLength(1);
    const card = required(feed.cards[0]);
    expect(card.asOf).toEqual(feed.asOf);
    expect(card.asOf.hash).toBe(v2.head()?.hash);
    expect(card.choices).toEqual({ buyers: 'burn', sellers: 'burn' });
    expect(card).not.toHaveProperty('m3');
    expect(card.vaultItems?.firstId).toBe('1'); expect(card.vaultItems?.n).toBe('500');
    expect(card.vaultItems?.owners).toEqual({ '1': B.toLowerCase(), '3': A.toLowerCase() });
    expect(card.vaultItems?.known.map(i => i.id)).toEqual(['2', '3', '1']);
    expect(card.vaultItems?.known.every(i => /^\d+$/.test(i.sequence))).toBe(true);
    expect(Object.keys(required(card.vaultItems)).sort()).toEqual(['firstId', 'known', 'n', 'owners']);
    const box = await send(`/v2/boxes/${f.manifest.chainId}/${f.at(1)}`);
    expect(box['vaultItems']).toEqual(card.vaultItems); expect(box['asOf']).toEqual(feed.asOf);
    const reader = { network: 'local' as const, manifest: f.manifest, origin: '', rpc: '' };
    // The real existing browser reader tolerates the new optional field and still reads old feeds.
    const old = { ...card }; delete old.vaultItems;
    const legacyFeed = { ...feed, cards: [old] };
    const { vaultItems, ...oldFields } = parseSnapshotV2(card, reader);
    expect(oldFields).toEqual(parseSnapshotV2(required(legacyFeed.cards[0]), reader));
    expect(vaultItems).toEqual({ firstId: 1n, n: 500n, known: required(card.vaultItems).known.map((k) => ({ id: BigInt(k.id), inside: k.inside, sequence: BigInt(k.sequence) })), owners: { '1': B, '3': A } });
    expect(old).not.toHaveProperty('vaultItems');
    expect(parseSnapshotV2(old, reader).choices).toEqual({ buyers: 'burn', sellers: 'burn' });
  } finally { await gw.stop(); v2.stop(); }
});
