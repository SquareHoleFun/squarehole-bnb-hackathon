import { describe, expect, it } from 'vitest';
import { type Address, type Hex } from 'viem';
import { logRequestPlan, type LogFilter } from '../../src/core/core-reader';
import { CORE_TOPIC0_V2 } from '../../src/core/v2/chain-v2';

const address = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`;
const topic = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const filter: LogFilter = {
  addresses: [address(1), address(2), address(3)], topics: [topic(7)],
  poolManager: address(4), poolIds: [topic(8)], poolTopics: [topic(9)],
  settlementAddresses: [address(5), address(6)], settlementTopics: CORE_TOPIC0_V2.cowSettlement ?? [],
  settlementOwners: [topic(10), topic(11), topic(12)],
};

describe('RC7-I10 pure RPC request plan', () => {
  it('keeps general addresses, pools and owner-filtered settlements in separate requests', () => {
    expect(logRequestPlan(filter, 2)).toEqual([
      { address: [address(1), address(2)], topics: [[topic(7)]] },
      { address: [address(3)], topics: [[topic(7)]] },
      { address: address(4), topics: [[topic(9)], [topic(8)]] },
      { address: [address(5), address(6)], topics: [filter.settlementTopics, [topic(10), topic(11)]] },
      { address: [address(5), address(6)], topics: [filter.settlementTopics, [topic(12)]] },
    ]);
    for (const request of logRequestPlan(filter, 2).filter(r => r.topics.length === 1)) {
      expect(request.address).not.toContain(address(5));
      expect(request.address).not.toContain(address(6));
    }
  });

  it.each(['settlementAddresses', 'settlementOwners'] as const)('sends no settlement request without %s', key => {
    expect(logRequestPlan({ ...filter, [key]: [] }, 200)).toEqual([
      { address: filter.addresses, topics: [filter.topics] },
      { address: filter.poolManager, topics: [filter.poolTopics, filter.poolIds] },
    ]);
  });

  it('splits 450 owners at 200 into exactly 200, 200, 50 without changing any topic', () => {
    const owners = Array.from({ length: 450 }, (_, i) => topic(1000 + i));
    const requests = logRequestPlan({ ...filter, addresses: [], poolIds: [], settlementOwners: owners }, 200);
    expect(requests).toEqual([0, 200, 400].map(start => ({
      address: filter.settlementAddresses, topics: [filter.settlementTopics, owners.slice(start, start + 200)],
    })));
    expect(requests.map(r => r.topics[1]?.length)).toEqual([200, 200, 50]);
  });
});
