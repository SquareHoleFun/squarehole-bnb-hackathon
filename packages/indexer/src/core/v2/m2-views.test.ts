import { parseAbiItem, type AbiEvent } from 'viem';
import { describe, expect, it } from 'vitest';
import { applyV2Block } from './views-v2';
import { decodeV2Logs, routeV2 } from './events-v2';
import { jsonV2 } from '../core-row';
import { A, B, COLLECTION, H, logM2, m2Fixture } from './m2-fixture.test-support';

const funded = parseAbiItem('event HolderBatchFunded(uint256 indexed batchId, uint256 netP)');
const settled = parseAbiItem('event BatchSettled(uint256 indexed batchId, uint256 fundingP, uint256 holderP, uint256 residueP)');
const paid = parseAbiItem('event HolderPaid(uint256 indexed batchId, address indexed holder, address indexed to, uint256 grossP, uint256 tipP)');
const flushed = parseAbiItem('event ResidueFlushed(uint256 indexed batchId, address indexed destination, uint256 amountP)');
const header = (number = 101n, hash = H(101)) => ({ number, hash, parentHash: H(100), timestamp: 1700000100n });

describe('M252-REPLAY and M252-MONEY', () => {
  it.each([1n, 100n, 101n])('OC-02: refuses holder tip %s before publishing F127 history', tipP => {
    const f = m2Fixture(false); const route = routeV2(f.release, f.manifest, [], [f.record]);
    const events = decodeV2Logs([
      logM2(funded, f.at(5), { batchId: 1n, netP: 100n }, 1),
      logM2(settled, f.at(17), { batchId: 1n, fundingP: 100n, holderP: 100n, residueP: 0n }, 2),
      logM2(paid, f.at(17), { batchId: 1n, holder: A, to: A, grossP: 100n, tipP }, 3),
    ], route);
    expect(events).toHaveLength(3);
    expect(() => applyV2Block(undefined, header(), events, f.row)).toThrow(/F127.*tip/);
  });

  it('OC-02: one raw unit pays without tip or minimum; duplicate and overfunded claims still fail', () => {
    const f = m2Fixture(false); const route = routeV2(f.release, f.manifest, [], [f.record]);
    const prefix = [
      logM2(funded, f.at(5), { batchId: 1n, netP: 2n }, 1),
      logM2(settled, f.at(17), { batchId: 1n, fundingP: 2n, holderP: 2n, residueP: 0n }, 2),
      logM2(paid, f.at(17), { batchId: 1n, holder: A, to: A, grossP: 1n, tipP: 0n }, 3),
    ];
    const result = applyV2Block(undefined, header(), decodeV2Logs(prefix, route), f.row);
    expect(result.state.view.m2?.batches['1']).toMatchObject({ paidP: 1n, tipsP: 0n,
      payments: { [A.toLowerCase()]: { grossP: 1n, receivedP: 1n, tipP: 0n } } });
    for (const [holder, grossP] of [[A, 1n], [B, 2n]] as const) {
      const logs = [...prefix, logM2(paid, f.at(17), { batchId: 1n, holder, to: holder, grossP, tipP: 0n }, 4)];
      expect(() => applyV2Block(undefined, header(), decodeV2Logs(logs, route), f.row)).toThrow(/funding/);
    }
  });

  it.each([6, 8, 18])('projects net funding, gross claims and residue exactly at %s decimals', decimals => {
    const f = m2Fixture(false); const q = 10n ** BigInt(decimals) * 10n ** 20n;
    const logs = [
      logM2(funded, f.at(5), { batchId: 1n, netP: 100n * q }, 1),
      logM2(settled, f.at(17), { batchId: 1n, fundingP: 100n * q, holderP: 80n * q, residueP: 20n * q }, 2),
      logM2(paid, f.at(17), { batchId: 1n, holder: A, to: A, grossP: 60n * q, tipP: 0n }, 3),
      logM2(flushed, f.at(17), { batchId: 1n, destination: f.at(2), amountP: 20n * q }, 4),
      logM2(funded, f.at(5), { batchId: 2n, netP: 0n }, 5),
    ];
    const route = routeV2(f.release, f.manifest, [], [f.record]);
    const decoded = decodeV2Logs([...logs].reverse().concat(logs), route);
    const result = applyV2Block(undefined, header(), decoded, f.row);
    expect(result.state.view).toMatchObject({ m2: { batches: {
      '1': { fundingP: 100n * q, complete: true, holderP: 80n * q, residueP: 20n * q, paidP: 60n * q, tipsP: 0n, flushedP: 20n * q,
        payments: { [A.toLowerCase()]: { to: A.toLowerCase(), grossP: 60n * q, tipP: 0n, receivedP: 60n * q } } },
      '2': { fundingP: 0n, complete: false, holderP: null },
    } } });
    expect(result.activity).toHaveLength(5);
    expect(result.activity[0]?.data.netP).toBe((100n * q).toString());
    expect(jsonV2(result.state.view)).toMatchObject({ m2: { batches: { '1': { paidP: (60n * q).toString() } } } });
  });

  it('handles reordered and duplicate decoded deliveries, and replaces orphaned payouts by replay from the parent', () => {
    const f = m2Fixture(false); const route = routeV2(f.release, f.manifest, [], [f.record]);
    const first = [logM2(funded, f.at(5), { batchId: 1n, netP: 100n }, 1, 100n, H(100)),
      logM2(settled, f.at(17), { batchId: 1n, fundingP: 100n, holderP: 80n, residueP: 20n }, 2, 100n, H(100))];
    const events = decodeV2Logs(first, route);
    const parent = applyV2Block(undefined, header(100n, H(100)), [...events].reverse().concat(events), f.row).state;
    const orphanLog = logM2(paid, f.at(17), { batchId: 1n, holder: A, to: A, grossP: 60n, tipP: 0n }, 1);
    const orphanEvents = decodeV2Logs([orphanLog], route);
    const orphan = applyV2Block(parent, header(), orphanEvents, f.row).state;
    const duplicate = applyV2Block(orphan, header(), orphanEvents, f.row);
    expect(duplicate.activity).toHaveLength(0);
    expect(duplicate.state).toEqual(orphan);
    const replacement = applyV2Block(parent, header(101n, H(201)), [], f.row).state;
    expect(replacement.view).toMatchObject({ m2: { batches: { '1': { paidP: 0n, payments: {} } } } });
    expect(parent.view).toMatchObject({ m2: { batches: { '1': { paidP: 0n } } } });
    expect(() => applyV2Block(orphan, header(101n, H(201)), [], f.row)).toThrow(/rewind|parent/i);
    expect(() => applyV2Block(parent, header(101n, H(201)), orphanEvents, f.row)).toThrow(/block|hash/i);
  });

  it('rejects accounting contradictions instead of publishing invented credit', () => {
    const f = m2Fixture(false); const route = routeV2(f.release, f.manifest, [], [f.record]);
    const logs = [logM2(funded, f.at(5), { batchId: 1n, netP: 10n }, 1),
      logM2(settled, f.at(17), { batchId: 1n, fundingP: 10n, holderP: 11n, residueP: 0n }, 2)];
    expect(() => applyV2Block(undefined, header(), decodeV2Logs(logs, route), f.row)).toThrow(/fund|conserv/i);
  });

  it('keeps holder money after failure and never treats a missing payment log as a payment', () => {
    const f = m2Fixture(false); const route = routeV2(f.release, f.manifest, [], [f.record]);
    const failed = parseAbiItem('event BoxFailed(address indexed caller, uint8 cause, uint256 timestamp)');
    const logs = [logM2(funded, f.at(5), { batchId: 1n, netP: 100n }, 1),
      logM2(settled, f.at(17), { batchId: 1n, fundingP: 100n, holderP: 80n, residueP: 20n }, 2),
      logM2(failed, f.at(0), { cause: 1, caller: B, timestamp: 1700000100n }, 3)];
    const result = applyV2Block(undefined, header(), decodeV2Logs(logs, route), f.row);
    expect(result.state.view).toMatchObject({ m2: { failed: true, batches: { '1': { holderP: 80n, paidP: 0n, payments: {} } } } });
  });

  it('indexes shop sources, lists, curator handover, partial starters, completion and fixed recovery', () => {
    const f = m2Fixture(); const route = routeV2(f.release, f.manifest, [], [f.record]);
    const specs: [string, number, Record<string, unknown>][] = [
      ['event SeedFunded(uint256 amountT)', 3, { amountT: 1000n }],
      ['event CollectionAdded(address indexed collection,uint8 tier,uint256 activeAt)', 3, { collection: COLLECTION, tier: 0, activeAt: 1700604800n }],
      ['event StarterLoaded(uint256 indexed index,address indexed collection,uint256 id)', 3, { index: 0n, collection: COLLECTION, id: 2n ** 200n }],
      ['event StarterProgress(uint32 loaded,bytes32 remainingHash)', 19, { loaded: 1, remainingHash: H(9) }],
      ['event CuratorProposed(address indexed next)', 3, { next: B }],
      ['event CuratorChanged(address indexed curator)', 3, { curator: B }],
      ['event Given(address indexed collection,uint256 indexed id,address indexed giver,uint256 amountT)', 3, { collection: COLLECTION, id: 7n, giver: A, amountT: 1n }],
      ['event Picked(address indexed collection,uint256 indexed id,address indexed to,uint256 amountT)', 3, { collection: COLLECTION, id: 7n, to: B, amountT: 2n }],
    ];
    const events = decodeV2Logs(specs.map(([s, role, args], i) => logM2(parseAbiItem(s) as AbiEvent, f.at(role), args, i)), route);
    const first = applyV2Block(undefined, header(), events, f.row).state;
    expect(first.view).toMatchObject({ m2: { shop: { seedFundedT: 1000n, givenT: 1n, pickedT: 2n, curator: B.toLowerCase(), pendingCurator: null,
      collections: { [COLLECTION.toLowerCase()]: { tier: 0, activeAt: 1700604800n } }, starters: { '0': { id: 2n ** 200n, returned: false } } }, starter: { loaded: 1, remainingHash: H(9), notified: false } } });
    const returns = [
      logM2(parseAbiItem('event FailureEntered()'), f.at(3), {}, 1, 102n, H(102)),
      logM2(parseAbiItem('event StarterReturned(uint256 indexed index,address indexed collection,uint256 id)'), f.at(3), { index: 0n, collection: COLLECTION, id: 2n ** 200n }, 2, 102n, H(102)),
      logM2(parseAbiItem('event FailedTBurned(uint256 amount)'), f.at(3), { amount: 1001n }, 3, 102n, H(102)),
    ];
    const next = applyV2Block(first, header(102n, H(102)), decodeV2Logs(returns, route), f.row).state;
    expect(next.view).toMatchObject({ m2: { shop: { failed: true, burnedT: 1001n, starters: { '0': { returned: true } } }, starter: { notified: false } } });
    expect(first.view).toMatchObject({ m2: { shop: { starters: { '0': { returned: false } } } } });
  });
});
