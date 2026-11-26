import { expect, it } from 'vitest';
import { encodeAbiParameters, parseAbiItem } from 'viem';
import { decodeV2Logs, routeV2 } from './events-v2';
import { applyV2Block } from './views-v2';
import { m3Fixture, logM3, H } from './m3-fixture.test-support';

const funded = parseAbiItem('event ItemFunded(uint256 indexed receiptId,uint256 indexed batchId,uint8 side,uint8 source,uint256 choiceP,uint256 ledgerP)');
const depth = parseAbiItem('event ItemsDepthFunded(uint8 indexed side,uint8 indexed source,uint256 choiceP,uint256 depthP,uint256 rewardsP)');
const bought = parseAbiItem('event RewardsBought(uint8 indexed choice,uint8 indexed side,uint256 spentP,uint256 boughtT,uint256 ledgerT,uint256 burnT,uint256 tipP)');
function fixture(inT = false) {
  const f = m3Fixture();
  const spec = { ...f.spec, buyers: { ...f.spec.buyers, a: { ...f.spec.buyers.a, leg: inT ? 2 : 1,
    destParams: encodeAbiParameters([{ type: 'uint8' }], [3]) } } };
  return { ...f, spec, row: { ...f.row, spec } };
}
function replay(f: ReturnType<typeof fixture>, logs: ReturnType<typeof logM3>[]) {
  return applyV2Block(undefined, { number: 101n, hash: H(101), parentHash: H(100), timestamp: 1000n },
    decodeV2Logs(logs, routeV2(f.release, f.manifest, [], [f.record])), f.row).state.view;
}
it('IP10 attributes P inside shares to depth and rejects a funded source-3 Depth receipt', () => {
  const f = fixture(), amount = 2n ** 120n;
  const event = (source: number, ledgerP: bigint) => logM3(funded, f.at(5), { receiptId: 1n, batchId: 0n, side: 1, source, choiceP: amount, ledgerP }, 0);
  expect(replay(f, [event(2, amount / 4n)]).m3?.items).toMatchObject({
    choiceP: amount, fundedP: amount / 4n, retainedBurnP: 0n, depthP: amount * 3n / 4n,
  });
  expect(() => replay(f, [event(3, 1n)])).toThrow(/funding/);
});
it('IP11 conserves T-choice P separately from bought T and rerouted queued P', () => {
  const f = fixture(true);
  const allocation = (source: number, choiceP: bigint, depthP: bigint, rewardsP: bigint, i: number) =>
    logM3(depth, f.at(5), { side: 1, source, choiceP, depthP, rewardsP }, i);
  const purchase = logM3(bought, f.at(5), { choice: 8, side: 1, spentP: 7n, boughtT: 99n, ledgerT: 99n, burnT: 0n, tipP: 1n }, 1);
  const logs = [allocation(2, 100n, 75n, 25n, 0), purchase, allocation(4, 17n, 17n, 0n, 2)];
  expect(replay(f, [...logs, ...logs]).payInT).toMatchObject({ itemsDepth: {
    '1': { choiceP: 100n, depthP: 92n, queuedP: 8n, spentP: 7n, tipsP: 1n },
  }, itemsFundedT: 99n, insideBurnT: 0n });
  expect(() => replay(f, [allocation(2, 100n, 76n, 25n, 0)])).toThrow(/conservation/);
  expect(() => replay(f, [allocation(2, 100n, 75n, 25n, 0), allocation(4, 26n, 26n, 0n, 1)])).toThrow(/conservation/);
});
