import { decodeEventLog, parseAbiItem, type Address, type Hex } from 'viem';
import { expect, it } from 'vitest';
import { batchesToRead, MAX_BATCHES_READ, type HolderSession } from '../../../../../../apps/web/src/features/core/v2/holder-claims';
import { m2ViewV2, type M2ViewV2 } from '../../../../../indexer/src/core/v2/m2-views-v2';
import { decodeV2Logs, routeV2, type CoreEventV2 } from '../../../../../indexer/src/core/v2/events-v2';
import { A, H, logM2, m2Fixture } from '../../../../../indexer/src/core/v2/m2-fixture.test-support';
import { coordinatorV2Abi } from '../abi-v2';

// Test-only owner handoffs. None substitutes for production in findings.test.ts/agreement.test.ts.
function selected(history: M2ViewV2, wallet: Address, session: HolderSession, extra: bigint | null) {
  const pending = Object.entries(session).filter(([, known]) => known.claim && (!known.read || known.read.block < known.claim.block)).map(([id]) => BigInt(id));
  const ids = [...(extra !== null && extra > 0n ? [extra] : []), ...pending, ...batchesToRead(history, wallet, session, null)];
  return [...new Set(ids)].slice(0, MAX_BATCHES_READ).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}
function checkedHistory(events: readonly CoreEventV2[], f: ReturnType<typeof m2Fixture>) {
  if (events.some(e => e.source === 'holderLedger' && e.name === 'HolderPaid' && e.args.tipP !== 0n)) throw new Error('F127: nonzero tip');
  return m2ViewV2(events, f.row.boxId, f.spec);
}

it('OC-01 local double: reserve space for the explicit batch and a receipt needing its deciding read', () => {
  const f = m2Fixture(false), history = m2ViewV2([], f.row.boxId, f.spec);
  const batch = { fundingP: 1n, complete: true, holderP: 1n, residueP: 0n, paidP: 0n, tipsP: 0n, flushedP: 0n, payments: {} };
  const backlog = { ...history, batches: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [String(i + 1), batch])) };
  const picked = selected(backlog, A, { '2': { claim: { tx: H(1), block: 100n, paidP: 1n } } }, 1n);
  expect(picked).toContain(1n); expect(picked).toContain(2n); expect(picked).toHaveLength(12);
});

it('OC-02 local double: zero-tip history remains conserved; a legacy tip is rejected before publication', () => {
  const f = m2Fixture(false), route = routeV2(f.release, f.manifest, [], [f.record]);
  const prefix = [
    logM2(parseAbiItem('event HolderBatchFunded(uint256 indexed batchId,uint256 netP)'), f.at(5), { batchId: 1n, netP: 100n }, 1),
    logM2(parseAbiItem('event BatchSettled(uint256 indexed batchId,uint256 fundingP,uint256 holderP,uint256 residueP)'), f.at(17), { batchId: 1n, fundingP: 100n, holderP: 100n, residueP: 0n }, 2),
  ];
  const payment = parseAbiItem('event HolderPaid(uint256 indexed batchId,address indexed holder,address indexed to,uint256 grossP,uint256 tipP)');
  const events = (tipP: bigint) => decodeV2Logs([...prefix, logM2(payment, f.at(17), { batchId: 1n, holder: A, to: A, grossP: 100n, tipP }, 3)], route);
  expect(checkedHistory(events(0n), f).batches['1']?.paidP).toBe(100n);
  expect(() => checkedHistory(events(1n), f)).toThrow('F127');
});

it('OC-04 local ABI double: reserve-forward bytes decode without changing their amount or destination', () => {
  const event = parseAbiItem('event ClaimsForwarded(address indexed to,uint256 amount)');
  const f = m2Fixture(), amount = 2n ** 120n + 1n;
  const raw = logM2(event, f.at(0), { to: f.at(5), amount }, 1);
  expect(decodeEventLog({ abi: [...coordinatorV2Abi, event], data: raw.data, topics: raw.topics as [Hex, ...Hex[]] })).toMatchObject({ eventName: 'ClaimsForwarded', args: { to: f.at(5), amount } });
});
