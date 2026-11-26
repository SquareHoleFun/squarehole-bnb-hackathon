/**
 * Adapts a fixture pair detail (pair-details.json, valid at the fixture asOf) to the record a scenario serves.
 * A snapshot cannot know the future: observations and activity after the snapshot asOf are dropped, and the
 * provenance follows the served record (e.g. `stale`, `partial`). Supply values follow the record unchanged.
 */
import { parseIsoTimestamp, type PairDetail, type PairRecord, type Provenance } from '@squarehole/domain';
import { demoBlockAt } from './demo-chain';

export function detailForRecord(base: PairDetail, record: PairRecord, asOf: string): PairDetail {
  const served = record.provenance;
  if (served.asOf === base.provenance.asOf && served.state === base.provenance.state && served.coverage === base.provenance.coverage) {
    return base;
  }
  const limit = parseIsoTimestamp(asOf);
  const known = (at: string): boolean => parseIsoTimestamp(at) <= limit;
  let priceHistory: PairDetail['priceHistory'] = base.priceHistory;
  if (priceHistory.state === 'observed') {
    const points = priceHistory.points.filter((point) => known(point.t));
    priceHistory = points.some((point) => point.priceUsd !== null)
      ? { state: 'observed', unit: priceHistory.unit, points }
      : { state: 'unavailable', reason: 'not_indexed' };
  }
  const provenance: Provenance = {
    state: served.state,
    asOf: served.asOf,
    blockNumber: served.blockNumber ?? demoBlockAt(served.asOf),
    source: base.provenance.source,
    coverage: served.coverage,
  };
  return { ...base, priceHistory, activity: base.activity.filter((row) => known(row.at)), provenance };
}
