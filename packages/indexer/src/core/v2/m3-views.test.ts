import { parseAbiItem, type AbiEvent } from 'viem';
import { describe, expect, it } from 'vitest';
import { decodeV2Logs, routeV2 } from './events-v2';
import { applyV2Block } from './views-v2';
import { m3Fixture, logM3, H, A, B, SEED, required } from './m3-fixture.test-support';
const funding = parseAbiItem('event ItemFunded(uint256 indexed receiptId,uint256 indexed batchId,uint8 side,uint8 source,uint256 choiceP,uint256 ledgerP)');
const life = parseAbiItem('event ItemLifecycleRecorded(uint256 indexed sequence,bytes32 indexed ticketKey,uint256 indexed itemId,uint256 fundingCursor,uint64 at,uint8 kind)');
const header = (n = 101, hash = H(n)) => ({ number: BigInt(n), hash, parentHash: H(n - 1), timestamp: 1000n });
function run(f: ReturnType<typeof m3Fixture>, logs: ReturnType<typeof logM3>[], previous?: ReturnType<typeof applyV2Block>['state'], block = header()) {
  return applyV2Block(previous, block, decodeV2Logs(logs, routeV2(f.release, f.manifest, [], [f.record])), f.row);
}
function fundingLog(f: ReturnType<typeof m3Fixture>, id: bigint, choiceP: bigint, ledgerP = choiceP, source = 2, index = 0) {
  return logM3(funding, f.at(5), { receiptId: id, batchId: 0n, side: 1, source, choiceP, ledgerP }, index);
}
function lifeLog(f: ReturnType<typeof m3Fixture>, seq: bigint, kind: number, key: string, cursor: bigint, id = 0n, index = 0) {
  return logM3(life, f.at(3), { sequence: seq, ticketKey: key, itemId: id, fundingCursor: cursor, at: 1000n, kind }, index);
}
const pileLog = (f: ReturnType<typeof m3Fixture>, event: string, args: Record<string, unknown>, i: number) => logM3(parseAbiItem(event) as AbiEvent, f.at(3), args, i);

describe('M352 canonical item history', () => {
  it('retains same-second keyed starts, reverse delivery, cancellation and full-width backing without inventing item credit', () => {
    const f = m3Fixture(); const amount = 2n ** 120n + 11n;
    const logs = [fundingLog(f, 1n, 40n, 40n, 3), lifeLog(f, 1n, 1, H(11), 1n, 0n, 1),
      fundingLog(f, 2n, amount, amount, 2, 2), lifeLog(f, 2n, 1, H(12), 2n, 0n, 3),
      lifeLog(f, 3n, 2, H(12), 2n, 3n, 4), lifeLog(f, 4n, 2, H(11), 2n, 2n, 5),
      lifeLog(f, 5n, 1, H(13), 2n, 0n, 6), lifeLog(f, 6n, 3, H(13), 2n, 0n, 7)];
    const result = run(f, [...logs].reverse().concat(logs)); const view = required(result.state.view.m3);
    expect(view.items).toMatchObject({ choiceP: amount + 40n, fundedP: amount + 40n, retainedBurnP: 0n, fundingCursor: 2n, lifecycleCursor: 6n });
    expect(view.items?.tickets[H(11)]).toMatchObject({ fundingStart: 1n, itemId: 2n, state: 'delivered' });
    expect(view.items?.tickets[H(12)]).toMatchObject({ fundingStart: 2n, itemId: 3n, state: 'delivered' });
    expect(view.items?.tickets[H(13)]).toMatchObject({ fundingStart: 2n, state: 'cancelled' });
    expect(view.items).not.toHaveProperty('claimableP');
    expect(result.activity).toHaveLength(logs.length);
    expect(result.activity[2]?.data.ledgerP).toBe(String(amount));
    expect(run(f, logs, result.state).state).toBe(result.state);
  });
  it('rejects unbacked funding, repeated receipt identity, missing sequences and nonexistent ticket delivery', () => {
    const f = m3Fixture();
    expect(() => run(f, [fundingLog(f, 1n, 1n, 2n)])).toThrow(/funding/i);
    expect(() => run(f, [fundingLog(f, 1n, 2n), fundingLog(f, 1n, 2n, 2n, 2, 1)])).toThrow(/receipt/i);
    expect(() => run(f, [lifeLog(f, 2n, 1, H(1), 0n)])).toThrow(/sequence/i);
    expect(() => run(f, [lifeLog(f, 1n, 2, H(1), 0n, 1n)])).toThrow(/ticket/i);
  });
  it('rewinds funding and residue to the parent and matches a fresh canonical replay', () => {
    const f = m3Fixture(); const base = run(f, [fundingLog(f, 1n, 40n, 40n, 3)]).state;
    const event = parseAbiItem('event ResidueFlushed(uint256 p)');
    const orphan = logM3(event, f.at(16), { p: 3n }, 0, 102n, H(102));
    const old = run(f, [orphan], base, header(102)).state;
    expect(old.view.m3?.items?.flushedP).toBe(3n);
    const fresh = run(f, [], base, header(102, H(202))).state;
    expect(fresh.view.m3?.items?.flushedP).toBe(0n);
    expect(base.view.m3?.items?.flushedP).toBe(0n);
    expect(fresh).toEqual(run(f, [], run(f, [fundingLog(f, 1n, 40n, 40n, 3)]).state, header(102, H(202))).state);
    expect(() => run(f, [], old, header(102, H(202)))).toThrow(/rewind/);
  });
});

describe('M352 pile event history with role 3/19 alias', () => {
  it('routes seed, graduation and redemption once to the vault, keeping flow history separate from live balance', () => {
    const f = m3Fixture(true);
    const logs = [pileLog(f, 'event SeedLoaded(address indexed seeder,address indexed asset,uint256 amount)', { seeder: f.record.creator, asset: f.record.q, amount: SEED }, 0),
      pileLog(f, 'event GateOpened()', {}, 1),
      pileLog(f, 'event Redeemed(address indexed holder,address indexed to,uint256 tIn,uint256 assetOut)', { holder: A, to: B, tIn: 17n, assetOut: SEED + 3n }, 2)];
    const result = run(f, [...logs, ...logs]);
    expect(result.state.view.m3?.pile).toMatchObject({ seedLoaded: true, loadedAmount: SEED, redeemedT: 17n, redeemedAsset: SEED + 3n, graduated: true, failed: false });
    expect(result.activity.map(a => a.data.source)).toEqual(['vault', 'vault', 'vault']);
    expect(result.state.view.m3?.pile).not.toHaveProperty('balance');
  });
  it.each([true, false])('returns only the recorded received seed after failure, loaded=%s', loaded => {
    const f = m3Fixture(true); const logs = [];
    if (loaded) logs.push(pileLog(f, 'event SeedLoaded(address indexed seeder,address indexed asset,uint256 amount)', { seeder: f.record.creator, asset: f.record.q, amount: SEED }, 0));
    logs.push(pileLog(f, 'event FailureEntered()', {}, 1));
    const base = run(f, logs).state;
    expect(base.view.m3?.pile).toMatchObject({ failed: true, seedReturned: false, returnedAmount: 0n });
    const returned = logM3(parseAbiItem('event SeedReturned(address indexed seeder,uint256 amount)'), f.at(3), { seeder: f.record.creator, amount: loaded ? SEED : 0n }, 0, 102n, H(102));
    expect(run(f, [returned], base, header(102)).state.view.m3?.pile).toMatchObject({ seedReturned: true, returnedAmount: loaded ? SEED : 0n });
    const wrong = { ...returned, ...logM3(parseAbiItem('event SeedReturned(address indexed seeder,uint256 amount)'), f.at(3), { seeder: A, amount: SEED }, 0, 102n, H(102)) };
    expect(() => run(f, [wrong], base, header(102))).toThrow(/seed/i);
  });
});
