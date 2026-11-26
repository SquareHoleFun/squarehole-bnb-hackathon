/**
 * Discovery and decoding on synthetic chains (S10a § 3.1-3.3):
 * - BC-073: several boxes found from the manifest's registry alone (no per-box setting), each checked at its creation
 *   block; a box created and traded in its creation block has that trade; a look-alike registry's logs do not count; a
 *   box whose code does not match is refused and a template this build does not show gets a row and no indexing, each
 *   with why; the same result from a cold start (range backfill) and block by block. A box created through an inner
 *   call (a Safe, an ERC-4337 account) emits the same logs, so it needs nothing else (no traces).
 * - BC-083: prices and sides for every Q class with T as currency0 and as currency1, in each Q's own decimals.
 */
import { labelAddress, TEST_Q, type TestQName } from '@squarehole/chain/core/test-support';
import { boxRegistryAbi } from '@squarehole/chain/abi';
import type { Abi } from 'viem';
import { describe, expect, it } from 'vitest';
import { CoreChainIndexer } from '../../src/core/chain-indexer';
import { priceQPerT } from '../../src/core/core-math';
import { getSqrtPriceAtTick } from '../../src/v4-math';
import { ev, event, synthBox, synthManifest, testQList, World, type SynthBox } from './core-synth';

const SQRT_START = getSqrtPriceAtTick(-30_000);

function world(): { w: World; a: SynthBox; b: SynthBox; unsupported: SynthBox; refused: SynthBox } {
  const w = new World();
  const a = synthBox({ boxId: 0n, creationBlock: 12n });
  const b = synthBox({ boxId: 1n, creationBlock: 20n });
  const unsupported = synthBox({ boxId: 2n, creationBlock: 25n, templateId: `0x${'ab'.repeat(32)}` });
  const refused = synthBox({ boxId: 3n, creationBlock: 30n, badCode: 'hook' });
  w.block(10n);
  // Box A: created, its pool initialised and its bootstrap buy, all in the creation transaction.
  w.block(12n, [w.created(a, [ev.initialize(a, SQRT_START, -30_000), ev.mint(a, a.row.contracts.coordinator as `0x${string}`, 10n ** 27n), ev.swap(a, { amount0: -1_500_000_000_000_000n, amount1: 10n ** 21n, sqrtPriceX96: SQRT_START - 1n, tick: -30_001, liquidity: 10n ** 20n, sender: a.row.contracts.launchRouter as `0x${string}` }), ev.bootstrapped(a, 1_500_000_000_000_000n, 10n ** 21n)])]);
  // Box B: created in one transaction and traded by someone else in another of the same block.
  w.block(20n, [w.created(b, [ev.initialize(b, SQRT_START, -30_000)]), [ev.swap(b, { amount0: -(10n ** 17n), amount1: 5n * 10n ** 22n, sqrtPriceX96: SQRT_START - 7n, tick: -30_002, liquidity: 10n ** 20n })]]);
  // A look-alike registry emitting the same signature: not the manifest's, never counted.
  const fake = synthBox({ boxId: 9n, creationBlock: 22n });
  const [created, spec] = w.created(fake).slice(-2) as [ReturnType<typeof event>, ReturnType<typeof event>];
  w.boxes.pop();
  w.block(22n, [[{ ...created, address: labelAddress('synth:look-alike') }, { ...spec, address: labelAddress('synth:look-alike') }]]);
  w.block(25n, [w.created(unsupported)]);
  w.block(30n, [w.created(refused)]);
  w.block(31n, [[ev.swap(a, { amount0: 10n ** 16n, amount1: -(10n ** 20n), sqrtPriceX96: SQRT_START + 3n, tick: -29_999, liquidity: 10n ** 20n })]]);
  w.to(40n);
  return { w, a, b, unsupported, refused };
}

async function follow(w: World, blockByBlock: boolean, manifest = synthManifest()): Promise<CoreChainIndexer> {
  const chain = w.chain();
  const indexer = new CoreChainIndexer({ reader: chain, manifest, qList: testQList() });
  if (blockByBlock) {
    chain.tip = 10n;
    await indexer.start();
    for (let n = 11n; n <= 40n; n += 1n) {
      chain.tip = n;
      await indexer.enqueue(chain.header(n));
    }
  } else {
    await indexer.start();
  }
  await indexer.idle();
  return indexer;
}

describe('BC-073: boxes from the registry alone', () => {
  for (const mode of ['block by block', 'cold start (range backfill)'] as const) {
    it(`BC-073 ${mode}: shown boxes, the others with why, the creation block's trades`, async () => {
      const { w, a, b } = world();
      const indexer = await follow(w, mode === 'block by block');
      expect(indexer.metrics.errors).toBe(0);
      const feed = indexer.feedView();
      expect(feed.cards.map((c) => c.row.record.boxId).sort()).toEqual(['0', '1']);
      expect(feed.hidden.map((h) => [h.boxId, h.reason.split(' ').slice(0, 2).join(' ')])).toEqual([
        ['2', 'template 0xabababababababababababababababababababababababababababababababab'],
        ['3', "hook's code"],
      ]);
      // Box A's bootstrap in its creation block (the creation transaction itself) and a sell later.
      const aTrades = indexer.recent(a.row.contracts.token as string)?.trades ?? [];
      expect(aTrades.map((t) => [t.block, t.side, t.route])).toEqual([
        [12n, 'buy', 'bootstrap'],
        [31n, 'sell', 'other'],
      ]);
      // Box B's trade in its creation block, by another transaction.
      expect(indexer.recent(b.row.contracts.token as string)?.trades.map((t) => t.block)).toEqual([20n]);
      // Nothing from the look-alike registry.
      expect(indexer.allRows().map((r) => r.row.boxId)).toEqual([0n, 1n, 2n, 3n]);
    });
  }

  it('BC-073: one getLogs pair per block, and one re-read of the creation block per new box (no traces, no per-box setting)', async () => {
    const { w } = world();
    const chain = w.chain();
    const indexer = new CoreChainIndexer({ reader: chain, manifest: synthManifest(), qList: testQList() });
    chain.tip = 10n;
    await indexer.start();
    const before = chain.asked.length;
    for (let n = 11n; n <= 40n; n += 1n) {
      chain.tip = n;
      await indexer.enqueue(chain.header(n));
    }
    await indexer.idle();
    // 30 blocks, plus a re-read for each shown box created in them (A in 12, B in 20).
    expect(chain.asked.length - before).toBe(30 + 2);
  });

  it('BC-073: the manifest names no box: its only per-chain inputs are the registries and the start block', () => {
    const json = JSON.stringify(synthManifest());
    for (const box of world().w.boxes) expect(json).not.toContain((box.row.contracts.token as string).slice(2).toLowerCase());
    expect(boxRegistryAbi as Abi).toBeDefined();
  });
});

describe('BC-083: prices and sides for any Q, T as currency0 or currency1', () => {
  const cases: { q: TestQName; order: 'low' | 'high' }[] = [];
  for (const q of Object.keys(TEST_Q) as TestQName[]) {
    cases.push({ q, order: 'low' });
    if (q !== 'NATIVE_ETH') cases.push({ q, order: 'high' });
  }
  for (const c of cases) {
    it(`BC-083 ${c.q}, T ${c.order === 'low' && c.q !== 'NATIVE_ETH' ? 'currency0' : 'currency1'}`, async () => {
      const box = synthBox({ boxId: 0n, creationBlock: 12n, q: c.q, order: c.order });
      const tIsC0 = box.row.tIsCurrency0;
      expect(tIsC0).toBe(c.order === 'low' && c.q !== 'NATIVE_ETH');
      const qDecimals = TEST_Q[c.q].decimals;
      const qIn = 25n * 10n ** BigInt(qDecimals - 2); // 0.25 Q in its own units
      const tOut = 7n * 10n ** 20n;
      const sqrt = getSqrtPriceAtTick(tIsC0 ? 20_000 : -20_000);
      // A buy pays Q in: the swapper's Q delta is negative, on whichever side Q is.
      const buy = tIsC0 ? { amount0: tOut, amount1: -qIn } : { amount0: -qIn, amount1: tOut };
      const sell = tIsC0 ? { amount0: -tOut / 2n, amount1: qIn / 3n } : { amount0: qIn / 3n, amount1: -tOut / 2n };
      const w = new World();
      w.block(10n);
      w.block(12n, [w.created(box, [ev.initialize(box, sqrt, 0)])]);
      w.block(13n, [[ev.swap(box, { ...buy, sqrtPriceX96: sqrt, tick: 0, liquidity: 10n ** 20n })], [ev.swap(box, { ...sell, sqrtPriceX96: sqrt, tick: 0, liquidity: 10n ** 20n })]]);
      w.to(20n);
      const indexer = await follow(w, false);
      const trades = indexer.recent(box.row.contracts.token as string)?.trades ?? [];
      expect(trades.map((t) => [t.side, t.qRaw, t.tRaw])).toEqual([
        ['buy', qIn, tOut],
        ['sell', qIn / 3n, tOut / 2n],
      ]);
      const view = indexer.boxView(box.row.contracts.token as string);
      expect(view?.row.qSymbol ?? null).toBe(c.q === 'NATIVE_ETH' ? 'ETH' : null);
      expect(view?.price.qPerT).toBe(priceQPerT(sqrt, { tIsCurrency0: tIsC0, qDecimals, tDecimals: 18 }));
      expect(view?.trading.volumeQ).toBe((qIn + qIn / 3n).toString());
      // The price is in the Q's own whole units: an 18-decimal assumption would be off by 10^12 for a 6-decimal Q.
      const as18 = priceQPerT(sqrt, { tIsCurrency0: tIsC0, qDecimals: 18, tDecimals: 18 });
      if (qDecimals !== 18) expect(view?.price.qPerT).not.toBe(as18);
    });
  }
});
