import { describe, expect, it } from 'vitest';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import fixture from './recorded.json';
import { jsonV2 } from '../../../src/core/core-row';
import { rowsFromV2Logs } from '../../../src/core/v2/discovery-v2';
import { decodeV2Logs, routeV2 } from '../../../src/core/v2/events-v2';
import { applyV2Block, liveViewV2, type LiveStateV2 } from '../../../src/core/v2/views-v2';
import { synthManifestV2 } from '../../../../chain/src/core/v2/test-support/synth-v2';
import { requiredV2 } from '../scripted-core-chain';

const stages = ['launch', 'buy', 'sell', 'filled', 'graduated', 'poolBuy', 'poolSellBurn'] as const;
const hash = (n: bigint): Hex => keccak256(toHex(n));
for (const [name, recorded] of Object.entries(fixture)) describe(`TA28 recorded ${name} life`, () => {
  it('matches every statistic to offline contract receipts and Solidity state reads at every phase', () => {
    const original = synthManifestV2();
    const release = { ...requiredV2(original.releases[0]), registry: { address: recorded.wiring.registry as Address, codeHash: hash(0n) },
      listingRegistry: { address: recorded.wiring.listingRegistry as Address, codeHash: hash(0n) } };
    const manifest = { ...original, releases: [release], chain: { ...original.chain, poolManager: { address: recorded.wiring.poolManager as Address, codeHash: hash(0n) } } };
    function logs(stage: typeof stages[number], number: bigint) {
      return recorded[stage].map((l, logIndex) => ({ address: l.emitter as Address, topics: l.topics as Hex[], data: l.data as Hex,
        blockNumber: number, blockHash: hash(number), transactionHash: hash(number + 1000n), transactionIndex: 0, logIndex }));
    }
    const row = requiredV2(rowsFromV2Logs(logs('launch', 100n), release, manifest.chainId)[0]);
    row.pDecimals = name === 'sixDecimals' ? 6 : 18;
    const route = routeV2(release, manifest, [], [row.record]);
    let state: LiveStateV2 | undefined;
    let number = 100n;
    for (const stage of stages) {
      const timestamp = BigInt(recorded[`${stage}State`].timestamp);
      const header = { number, hash: hash(number), parentHash: hash(number - 1n), timestamp };
      const events = decodeV2Logs(logs(stage, number), route);
      const result = applyV2Block(state, header, events, row);
      state = result.state;
      expect(jsonV2(liveViewV2(state, timestamp)).statistics, stage).toEqual(recorded.expected[stage]);
      expect(state.supply, `${stage} on-chain totalSupply`).toBe(BigInt(recorded[`${stage}State`].supply));
      // Re-delivery of a canonical block cannot add a trade, a mint or a burn twice.
      expect(applyV2Block(state, header, events, row).state).toBe(state);
      number += 1n;
    }
    expect(state?.view.graduated).toBe(true);
    expect(state?.statistics?.tradeCount).toBeGreaterThan(5n);
    expect(state?.statistics?.burnedT).toBeGreaterThan(1234567890123456789n);
  });
});
