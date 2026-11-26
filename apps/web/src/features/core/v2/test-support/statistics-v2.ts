/**
 * SH-TA-29 fixture views: the indexer's own `statistics` (SH-TA-28) for a native-P life of the production contracts,
 * recorded offline (packages/indexer/test/core/stats-v2/recorded.json, checked against Solidity state reads there),
 * at a bonding stage, a filled curve and after graduation with a pool sale and a public burn; a native-ETH life and one
 * whose P is a six-decimal coin.
 */
import recorded from '../../../../../../../packages/indexer/test/core/stats-v2/recorded.json' with { type: 'json' };

export type RecordedStageV2 = 'buy' | 'sell' | 'filled' | 'graduated' | 'poolBuy' | 'poolSellBurn';

/** The wire `statistics` object (decimal strings) of a recorded life at `stage`: native ETH, or a six-decimal coin as P. */
export function recordedStatisticsV2(stage: RecordedStageV2, life: 'native' | 'sixDecimals' = 'native'): Record<string, unknown> {
  return structuredClone(recorded[life].expected[stage]) as Record<string, unknown>;
}
