import { describe, expect, it } from 'vitest';
import { batchesToRead, MAX_BATCHES_READ } from '../../../../../../apps/web/src/features/core/v2/holder-claims';
import { m2ViewV2, type M2ViewV2 } from '../../../../../indexer/src/core/v2/m2-views-v2';
import { decodeV2Logs, routeV2 } from '../../../../../indexer/src/core/v2/events-v2';
import { A, H, logM2, m2Fixture } from '../../../../../indexer/src/core/v2/m2-fixture.test-support';
import { parseAbiItem } from 'viem';

export function backlog(): M2ViewV2 {
  return { failed: false, shop: null, starter: null, batches: Object.fromEntries(
    Array.from({ length: MAX_BATCHES_READ + 1 }, (_, i) => [String(i + 1), {
      fundingP: 1n, complete: true, holderP: 1n, residueP: 0n, paidP: 0n, tipsP: 0n, flushedP: 0n, payments: {},
    }]),
  ) };
}

describe('M263 open properties (ordinary failing tests; no expected-failure masking)', () => {
  it('OC-01: an explicitly selected old batch remains reachable with twelve newer unpaid batches', () => {
    const batches = batchesToRead(backlog(), A, {}, 1n);
    expect(batches.length).toBeLessThanOrEqual(MAX_BATCHES_READ);
    expect(batches).toContain(1n);
  });

  it('OC-02: an authenticated F127 history refuses a nonzero holder claim tip', () => {
    const f = m2Fixture(false);
    const route = routeV2(f.release, f.manifest, [], [f.record]);
    const events = decodeV2Logs([
      logM2(parseAbiItem('event HolderBatchFunded(uint256 indexed batchId,uint256 netP)'), f.at(5), { batchId: 1n, netP: 100n }, 1),
      logM2(parseAbiItem('event BatchSettled(uint256 indexed batchId,uint256 fundingP,uint256 holderP,uint256 residueP)'), f.at(17), { batchId: 1n, fundingP: 100n, holderP: 100n, residueP: 0n }, 2),
      logM2(parseAbiItem('event HolderPaid(uint256 indexed batchId,address indexed holder,address indexed to,uint256 grossP,uint256 tipP)'), f.at(17), { batchId: 1n, holder: A, to: A, grossP: 100n, tipP: 1n }, 3),
    ], route);
    expect(events).toHaveLength(3);
    expect(() => m2ViewV2(events, f.row.boxId, f.spec)).toThrow();
  });

  it('OC-01: a claimed old batch still receives its deciding read despite twelve newer batches', () => {
    expect(batchesToRead(backlog(), A, { '1': { claim: { tx: H(1), block: 100n, paidP: 1n } } }, null)).toContain(1n);
  });
});
