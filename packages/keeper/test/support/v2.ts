import type { BoxState, World } from '../../src/world';
import { seededRng } from '../../src/rng';
import { loadConfig } from '../../src/config';

export const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as const;
export const time = 1_791_302_400n;
export const keeper = addr(99);
export const v2 = {
  router: addr(6), q: addr(0), qDecimals: 18, closedAt: time - 100n, lastProtocolBlock: 0n,
  graduationSettled: true, depthBudget: 1000n, buyBackP: 1000n, tBurnPending: 0n, reward: 0n,
  pot: 0n, tLeft: 1n, royalty: { address: addr(8), eth: 0n, wrapped: 0n, price: 0n },
};
export const box = (over: Partial<BoxState> = {}): BoxState => ({
  id: 0n, version: 2, coordinator: addr(1), hook: addr(2), receiver: addr(3), priceSource: null,
  graduated: true, failed: false, curveClosed: true, gateOpen: true, openAt: time - 100n, deadline: time + 900_000n,
  spotTick: null, sampleTick: null, checkpointTime: 0n, fitOwed: 0n, platformOwed: 0n,
  qPerEthX18: 10n ** 18n, v2, ...over,
});
export const world = (b = box(), block = 100n, timestamp = time): World => ({
  block: { number: block, timestamp, baseFeePerGas: 1n }, fitGraduated: false, boxes: [b],
});
export const options = () => ({
  // These lifecycle fixtures use raw-unit toy balances; minimum defaults have their own boundary suite.
  ...loadConfig({ SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216', SH_KEEPER_RPC_URL: 'http://fake.invalid',
    SH_KEEPER_COIN_MINIMUMS: JSON.stringify({ [addr(0)]: { collectRaw: '1' } }),
  }), keeper, privateEndpoint: false,
  payoutMinWei: 1n, retryBlocks: 2n, buyBackAlertBlocks: 3n, rng: seededRng(2),
});
export const quiet = { info: () => {}, warn: () => {}, error: () => {} };

/** Local receipt-source double for tests of other policies, independent of asset decimals.
 * Production native receipt verification and unknown-token refusal are pinned in income-read.test.ts.
 */
export const fundedIncome = (w: World) => ({ at: w.block.timestamp, platformWei: 10n ** 30n,
  boxes: Object.fromEntries(w.boxes.map(b => [b.receiver.toLowerCase(), { shareWei: 10n ** 30n, tipsWei: 0n }])), mined: {} });
