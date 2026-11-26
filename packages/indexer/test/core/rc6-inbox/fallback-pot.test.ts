import { describe, expect, it } from 'vitest';
import { zeroAddress, type Address, type Hex } from 'viem';
import recorded from './recorded.json';
import { m2Fixture, H } from '../../../src/core/v2/m2-fixture.test-support';
import { CORE_TOPIC0_V2 } from '../../../src/core/v2/chain-v2';
import { decodeV2Logs, routeV2 } from '../../../src/core/v2/events-v2';
import { boxViewContextV2, boxViewV2, liveViewV2, type BoxViewContextV2, type BoxViewV2 } from '../../../src/core/v2/views-v2';
import { jsonV2 } from '../../../src/core/core-row';
import { readMoneyV2 } from '../../../src/core/v2/money-v2';
import { eventV2, requiredV2, serviceBoxV2, serviceChainV2 } from '../scripted-core-chain';
import type { RawLog } from '../../../src/events';

const f = m2Fixture(false);
// These recordings are native-P boxes. Remap only recognized coordinator/receiver receipts, preserving payload/order.
const ctx = { ...boxViewContextV2({ ...f.record, q: zeroAddress }, f.spec, 18), spec: undefined };
const route = routeV2(f.release, f.manifest, [], [f.record]);
const header = { number: 101n, hash: H(101), parentHash: H(100), timestamp: 1000n };
function recordedEvents(logs: typeof recorded.holderFailureLogs) {
  return decodeV2Logs(logs.flatMap((log, logIndex): RawLog[] => {
    const topic = log.topics[0] as Hex;
    const slot = CORE_TOPIC0_V2.coordinator?.includes(topic) ? 0 : CORE_TOPIC0_V2.receiver?.includes(topic) ? 5 : null;
    return slot === null ? [] : [{ address: f.at(slot), topics: log.topics as Hex[], data: log.data as Hex,
      blockNumber: header.number, blockHash: header.hash, transactionHash: H(500), transactionIndex: 0, logIndex }];
  }), route);
}
function event(source: 'coordinator' | 'receiver' | 'launchRouter', name: string, args: Record<string, unknown>) {
  const address = f.at(source === 'coordinator' ? 0 : source === 'receiver' ? 5 : 6);
  const log = eventV2(source, name, address, args);
  return requiredV2(decodeV2Logs([{ ...log, blockNumber: header.number, blockHash: header.hash,
    transactionHash: H(500), transactionIndex: 0, logIndex: 1000 }], route)[0]);
}
const funded = (amount: bigint, token: Address = zeroAddress) => event('receiver', 'RoyaltyFunded', { token, destination: 1, amount });
const collected = (buyersP: bigint) => event('receiver', 'Collected', { caller: f.record.creator, tipTo: zeroAddress, buyersP, sellersP: 2n, qToReserve: 3n, tip: 4n });
const swept = (to: Address, amount = 81n) => event('launchRouter', 'Swept', { to, amount, toDepth: false });
const failure = () => boxViewV2(recordedEvents(recorded.noBuyerFailureLogs), ctx);
const publish = (view: BoxViewV2) => jsonV2(liveViewV2({ block: header.number, p: ctx.p, pDecimals: 18,
  view, pool: null, supply: 0n, balances: new Map(), volumeQ: 0n, volumeT: 0n }, header.timestamp));

describe('RC7-I13 event-only failed pot', () => {
  it('exhausts the recorded holder pot after the final claim sweeps the large inbox P through RoyaltyFunded', () => {
    const before = boxViewV2(recordedEvents(recorded.holderFailureLogs), ctx);
    const receipts = recordedEvents(recorded.holderClaimLogs);
    expect(receipts.find(e => e.name === 'RoyaltyFunded')?.args).toMatchObject({ token: zeroAddress, amount: 900719925474099312345n });
    expect(receipts.find(e => e.name === 'Collected')?.args.buyersP).toBe(0n);
    const after = boxViewV2(receipts, ctx, before);
    expect(publish(after).closing).toMatchObject({ pot: recorded.exhausted.pot, tLeft: recorded.exhausted.tLeft });
    expect(after.claim).toMatchObject({ initialPot: before.claim?.initialPot, initialT: before.claim?.initialT,
      claimedP: BigInt(recorded.pending.pot) + BigInt(recorded.pending.pendingP), claimedT: BigInt(recorded.pending.tLeft) });
  });

  it('does not double count recorded no-buyer funding before PotFixed in the same receipt', () => {
    const events = recordedEvents(recorded.noBuyerFailureLogs);
    const fundedAt = events.findIndex(e => e.name === 'RoyaltyFunded');
    expect(events[fundedAt]?.args.amount).toBe(123456789n);
    expect(fundedAt).toBeLessThan(events.findIndex(e => e.name === 'PotFixed'));
    expect(publish(boxViewV2(events, ctx)).closing).toMatchObject({ pot: '997000123456790', tLeft: '0' });
    expect(failure().claim?.pot).toBe(BigInt(recorded.noBuyer.pot));
  });

  it('reopens a paid no-buyer remainder after 77 raw native P is swept through receiver funding', () => {
    const claimed = event('coordinator', 'Claimed', { holder: f.record.creator, to: f.record.creator, t: 0n, p: BigInt(recorded.noBuyer.pot) });
    const paid = boxViewV2([claimed], ctx, failure());
    expect(publish(paid).closing?.pot).toBe('0');
    // Before the sweep the readable inbox is in claimState, but has no pot receipt for the fallback to fold.
    expect(recorded.noBuyerLate.pot).toBe('77');
    const reopened = boxViewV2([funded(77n)], ctx, paid);
    expect(publish(reopened).closing).toMatchObject({ pot: recorded.noBuyerReopened.pot, tLeft: '0' });
    expect(reopened.claim).toMatchObject({ initialPot: BigInt(recorded.noBuyer.pot), claimedP: BigInt(recorded.noBuyer.pot), creatorClaimed: true });
  });

  it('adds a later collect and a sweep to the coordinator, retaining all unrelated fields', () => {
    expect.soft(ctx.coordinator).toBe(f.at(0));
    const before = failure();
    const collect = collected(93n);
    const after = boxViewV2([collect, swept(f.at(0))], { ...ctx, coordinator: f.at(0) }, before);
    expect(publish(after).closing?.pot).toBe(String(BigInt(recorded.noBuyer.pot) + 93n + 81n));
    expect(after.claim).toEqual({ ...before.claim, pot: BigInt(recorded.noBuyer.pot) + 174n });
    expect(after.fees).toEqual({ buyersP: before.fees.buyersP + 93n, sellersP: before.fees.sellersP + 2n,
      qToReserve: before.fees.qToReserve + 3n, tipsP: before.fees.tipsP + 4n });
    expect(after.royaltyFunded).toEqual(before.royaltyFunded);
  });

  it('counts only receipts after PotFixed, even within one block and transaction', () => {
    const fixed = requiredV2(recordedEvents(recorded.noBuyerFailureLogs).find(e => e.name === 'PotFixed'));
    const events = [collected(500n), funded(600n), swept(f.at(0), 700n), fixed, collected(11n), funded(13n), swept(f.at(0), 17n)];
    expect(boxViewV2(events, ctx).claim?.pot).toBe(BigInt(recorded.noBuyer.pot) + 41n);
    const split = boxViewV2(events.slice(0, 4), ctx);
    expect(boxViewV2(events.slice(4), ctx, split)).toEqual(boxViewV2(events, ctx));
  });

  it('leaves other tokens, other sweep destinations, missing coordinator context and live boxes unchanged', () => {
    const before = failure();
    const other = boxViewV2([funded(123n, f.at(1)), swept(f.at(1))], ctx, before);
    expect(publish(other).closing?.pot).toBe(recorded.noBuyer.pot);
    expect(other.royaltyFunded[f.at(1).toLowerCase()]).toBe(123n);
    const noCoordinator: BoxViewContextV2 = { ...ctx, coordinator: undefined };
    expect(boxViewV2([swept(f.at(0))], noCoordinator, before).claim).toEqual(before.claim);
    const live = boxViewV2([collected(93n), funded(77n), swept(f.at(0))], ctx);
    expect(live.claim).toBeNull(); expect(publish(live).closing).toBeNull();
  });

  it('keeps a canonical money read authoritative over the event-only pot', async () => {
    const box = serviceBoxV2();
    const reader = serviceChainV2({ headers: [header], logs: [] }, [box], (_box, key) =>
      key === 'coordinator.claimState' ? [555n, 0n] : undefined);
    const view = boxViewV2([collected(93n), funded(77n)], ctx, failure());
    const money = await readMoneyV2(reader, { ...f.row, record: box.record, contracts: {
      ...f.row.contracts, coordinator: requiredV2(box.record.contracts[0]), token: requiredV2(box.record.contracts[1]),
      hook: requiredV2(box.record.contracts[2]), receiver: requiredV2(box.record.contracts[5]), royaltyRouter: null,
    } }, view, header.number, header.hash);
    const live = liveViewV2({ block: header.number, p: ctx.p, pDecimals: 18, view, money,
      pool: null, supply: 0n, balances: new Map(), volumeQ: 0n, volumeT: 0n }, header.timestamp);
    expect(live.closing?.pot).toBe(555n);
  });
});
