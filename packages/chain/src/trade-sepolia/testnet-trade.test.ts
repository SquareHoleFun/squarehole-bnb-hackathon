/**
 * SH-258: the trade and coin calls under `SH_TESTNET=bnb`. BNB Chain testnet (97) replaces Sepolia as the test chain;
 * its addresses come from its own record (passed as `localDeployment`, as the local alpha's are), and a box must be
 * listed by the release's registry the record names (`boxRegistry`). The addresses are fakes (0x97…).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, zeroAddress } from 'viem';
// Lane c's plain rehearsal on a local chain with id 97 (SH-260, 9f5056a8): a fixture, never the real record.
import rehearsal from '../../test/fixtures/bnb-testnet/coin-deployment-97.rehearsal.json' with { type: 'json' };

const fake = (n: number) => `0x97${'0'.repeat(34)}${n.toString(16).padStart(4, '0')}` as `0x${string}`;
const HASH = `0x${'97'.repeat(32)}` as `0x${string}`;
const pair = (coin: string, symbol: string, decimals: number) => ({ coin, symbol, decimals, fee: '3000', tickSpacing: 60, hooks: zeroAddress, tickLower: -887220, tickUpper: 887220 });
const coinRecord = { chainId: 97, status: 'deployed', teth: { address: fake(10), codeHash: HASH }, pairHelper: { address: fake(11), codeHash: HASH },
  poolManager: fake(1), poolSwapTest: fake(12), poolSwapTestCodeHash: HASH, pairs: [pair(fake(20), 'tUSDC', 6), pair(fake(21), 'tNVDA', 18)] };

async function bnb() {
  vi.stubEnv('SH_TESTNET', 'bnb');
  vi.resetModules();
  const [trade, coins] = await Promise.all([import('./trade'), import('./coin-deployment')]);
  return { trade, coins };
}

/** An RPC on chain 97 whose registry lists no box (`boxIdOf` answers `(false, 0)`). */
const chain97 = async (r: { method: string }): Promise<unknown> => {
  if (r.method === 'eth_chainId') return '0x61';
  if (r.method === 'eth_getBlockByNumber') return { number: '0x10', hash: HASH, timestamp: '0x3e8', transactions: [] };
  if (r.method === 'eth_call') return encodeAbiParameters([{ type: 'bool' }, { type: 'uint256' }], [false, 0n]);
  throw new Error(`unexpected ${r.method}`);
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('SH_TESTNET=bnb: the trade chain', () => {
  it('97 and the local alpha are trade chains; Sepolia is not', async () => {
    const { trade } = await bnb();
    expect([trade.isTradeChain(97), trade.isTradeChain(31337), trade.isTradeChain(11155111), trade.isTradeChain(56)]).toEqual([true, true, false, false]);
  });

  it('the default build keeps Sepolia and the local alpha only', async () => {
    const trade = await import('./trade');
    expect([trade.isTradeChain(97), trade.isTradeChain(31337), trade.isTradeChain(11155111)]).toEqual([false, true, true]);
  });

  it('the coin record of 97 is parsed from the caller, never pinned; none is refused', async () => {
    const { coins } = await bnb();
    expect(coins.coinDeployment(97, coinRecord)).toMatchObject({ chainId: 97, status: 'deployed', poolSwapTest: fake(12) });
    expect(() => coins.coinDeployment(97, undefined)).toThrow(/deployment_required/);
    expect(() => coins.coinDeployment(97, { ...coinRecord, chainId: 31337 })).toThrow(/deployment_chain_mismatch/);
    expect(() => coins.coinDeployment(11155111, coinRecord)).toThrow(/chain_not_allowed/);
  });

  it('the record SH-260 writes (its rehearsal on chain 97) parses: tETH and the four tETH pairs', async () => {
    const { coins } = await bnb();
    const parsed = coins.parseCoinDeployment(rehearsal);
    expect([parsed.chainId, parsed.status, parsed.pairs.map((p) => p.symbol)]).toEqual([97, 'deployed', ['tUSDC', 'tNVDA', 'tGOLD', 'tPEPE']]);
    expect(coins.coinDeployment(97, rehearsal).teth.address).toBe(rehearsal.teth.address);
  });

  it('a buy on 97 carries gas for the hook’s holder notice, however low the estimate', async () => {
    const { trade } = await bnb();
    // ReleaseConstantsV2: HOLDER_NOTICE_GAS 1,400,000, POKE_OVERHEAD_GAS 20,000, HOLDER_NOTICE_RESERVE_GAS 1,200,000;
    // BoxHookV2Base._noticeTrade skips the notice below cap + cap/63 + overhead + reserve.
    const need = 1_400_000n + 1_400_000n / 63n + 20_000n + 1_200_000n;
    for (const estimate of [150_000n, 371_383n, 900_000n, 3_000_000n]) {
      const limit = trade.tradeGasLimit(estimate);
      expect(limit).toBeGreaterThanOrEqual(trade.MIN_TRADE_GAS);
      // Three nested calls reach the hook (PoolSwapTest or the launch router, the PoolManager's unlock callback, the
      // hook), each passing on 63/64; 400,000 is left for everything spent before the notice.
      expect((limit * 63n ** 3n) / 64n ** 3n - 400_000n).toBeGreaterThan(need);
    }
    expect(trade.MIN_TRADE_GAS).toBe(4_000_000n);
  });

  it('a trade on 97 needs the release registry and a box it lists', async () => {
    const { trade } = await bnb();
    const options = { rpc: chain97, chainId: 97, coordinator: fake(3), from: fake(4), side: 'buy' as const, amountIn: 10n ** 15n };
    const deployment = { poolSwapTest: fake(12), poolManager: fake(1), poolSwapTestCodeHash: HASH };
    expect(await trade.prepareTradeSepolia({ ...options, localDeployment: deployment })).toEqual({ ok: false, reason: 'deployment_required' });
    expect(await trade.prepareTradeSepolia({ ...options, localDeployment: { ...deployment, boxRegistry: fake(2) } })).toEqual({ ok: false, reason: 'unregistered_box' });
    expect(await trade.prepareTradeSepolia({ ...options, chainId: 11155111, localDeployment: deployment })).toEqual({ ok: false, reason: 'chain_not_allowed' });
  });
});
