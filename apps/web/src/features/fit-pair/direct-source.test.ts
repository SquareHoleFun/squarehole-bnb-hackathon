import { curvePoint, MISFITS_CURVE } from '@squarehole/indexer/client';
import { describe, expect, it } from 'vitest';
import { DemoChain } from './demo-chain';
import { contractsOf, directReaderFor, liveDataFromDirect, liveWindowAt, vaultCountersFromRead } from './direct-source';
import { DEMO_FIT_TARGET, FIT_ISSUANCE_RAW, type FitMarketTarget } from './fit-target';
import { tapeRows } from './TradeTape';
import type { LiveTrade } from './live-model';

const T: FitMarketTarget = { ...DEMO_FIT_TARGET, kind: 'chain', rpcUrl: 'http://127.0.0.1:8599' };
const HASH = `0x${'ab'.repeat(32)}` as const;

function read(overrides: Partial<Parameters<typeof liveDataFromDirect>[0]> = {}) {
  const chain = new DemoChain(T);
  chain.mineTo(T.openBlock + 100n);
  return liveDataFromDirect(
    {
      block: { number: chain.head.header.number, hash: HASH, timestamp: chain.head.header.timestamp },
      safeBlock: 5n,
      finalizedBlock: 4n,
      sqrtPriceX96: chain.head.state.sqrtPriceX96,
      tick: chain.head.state.tick,
      phase: 'curve',
      completedBlock: null,
      migratedBlock: null,
      liquidityOpensAtBlock: null,
      openBlock: T.openBlock,
      totalSupplyRaw: FIT_ISSUANCE_RAW - 123n,
      ...overrides,
    },
    T,
  );
}

describe('direct chain reads as the page’s model', () => {
  it('recomputes the curve from √price, has no trades, and treats the head as not final', () => {
    const data = read();
    expect(data.origin).toBe('direct');
    expect(data.state.figures).toMatchObject({ retainedWei: curvePoint(data.state.sqrtPriceX96, MISFITS_CURVE).retainedWei });
    expect(data.state.burnedRaw).toBe(123n);
    expect(data.state.taxWei).toBeNull();
    expect(data.trades).toEqual([]);
    expect(data.confirmed).toBe(data.state);
    expect(data.finality).toEqual({ confirmedBlock: data.head.number - 1n, safeBlock: 5n, finalizedBlock: 4n });
    expect(data.window.status).toBe('open');
    expect(data.stateMismatch).toBeNull();
  });

  it('flags a hook whose open block is not the record’s, and a supply above the issuance', () => {
    expect(read({ openBlock: T.openBlock + 1n }).stateMismatch).toMatch(/open block/);
    const inflated = read({ totalSupplyRaw: FIT_ISSUANCE_RAW + 1n });
    expect(inflated.stateMismatch).toMatch(/one-time issuance/);
    expect(inflated.state.burnedRaw).toBeNull();
  });

  it('derives the graduation block from the completion and the 32-block latch', () => {
    expect(read({ phase: 'completed', completedBlock: 9_000n }).state.graduatesFromBlock).toBe(9_032n);
    expect(read({ phase: 'migrated', completedBlock: 9_000n, migratedBlock: 9_040n, liquidityOpensAtBlock: 9_072n }).state).toMatchObject({ graduatesFromBlock: null, migratedBlock: 9_040n, liquidityOpensAtBlock: 9_072n });
  });

  it('computes the window like the indexer, relative to the next block', () => {
    const head = { number: T.openBlock - 11n, hash: HASH, timestamp: 1_000n };
    expect(liveWindowAt(head, T)).toMatchObject({ status: 'before_open', blocksToOpen: 10n, etaOpenUnix: 1_000n + 11n * 12n });
    expect(liveWindowAt({ ...head, number: T.openBlock + 5n }, T)).toMatchObject({ status: 'router_window', blocksToClose: 26n });
  });

  it('maps vault reads and names only this market’s contracts', () => {
    expect(
      vaultCountersFromRead({
        block: { number: 7n, hash: HASH, timestamp: 1n },
        inside: 4_197n,
        collectionSize: 4_200n,
        gateOpen: false,
        placeholdersTaken: 3n,
        placeholdersMinted: 4n,
        escrowPrincipal: 714_286n * 10n ** 18n,
        totalSupply: 10n ** 27n - 7_143n * 10n ** 18n,
        quoteWithdrawOne: 238_095n * 10n ** 18n,
        hidden: 4_197n,
        pendingTickets: 3n,
        shelf: 0n,
      }),
    ).toEqual({
      source: 'chain',
      block: 7n,
      inside: 4_197n,
      collectionSize: 4_200n,
      gateOpen: false,
      placeholdersTaken: 3n,
      escrow: 714_286n * 10n ** 18n,
      supply: 10n ** 27n - 7_143n * 10n ** 18n,
      quoteOne: 238_095n * 10n ** 18n,
    });
    expect(contractsOf(T)).toEqual({ poolManager: T.poolManager, poolId: T.poolId, hook: T.hook, token: T.token, vault: T.vault, placeholders: T.placeholders, collection: T.collection });
    expect(directReaderFor(DEMO_FIT_TARGET)).toBeNull();
    expect(directReaderFor({ ...T, rpcUrl: null })).toBeNull();
    expect(directReaderFor(T)).not.toBeNull();
  });
});

describe('the tape', () => {
  const trade = (block: bigint, index: number, side: 'buy' | 'sell' = 'buy'): LiveTrade => ({
    id: `0x${block.toString(16).padStart(64, '0')}:${index}`,
    block,
    blockHash: `0x${block.toString(16).padStart(64, '0')}`,
    timestamp: 1n,
    txHash: HASH,
    logIndex: index,
    side,
    route: 'other',
    ethRaw: 10n,
    tokenRaw: 20n,
    taxRaw: side === 'buy' ? 1n : 0n,
    trader: null,
    priceAfterEthPerToken: '0.1',
    fillBpsAfter: 1,
  });

  it('folds a block with more than three trades into one row (VL-5)', () => {
    const rows = tapeRows([trade(9n, 4, 'sell'), trade(9n, 3), trade(9n, 2), trade(9n, 1), trade(8n, 2), trade(8n, 1)]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ kind: 'folded', block: 9n, buys: 3, sells: 1, ethIn: 30n, taxIn: 3n, ethOut: 10n });
    expect(rows.slice(1).map((row) => row.kind)).toEqual(['trade', 'trade']);
    expect(tapeRows([])).toEqual([]);
  });
});
