/**
 * Mock items presented as a showcase concept (C14: ORCHARD is the intended first showcase launch and must not be
 * represented as deployed or endorsed). Matched by exact demo pair identity, never by name or ticker.
 */
import { canonicalPairId, isPairId } from '@squarehole/domain';

const SHOWCASE_PAIR_IDS: ReadonlySet<string> = new Set([
  '31337:0x0000000000000000000000000000000000000066', // ORCHARD (demo fixture)
]);

export const SHOWCASE_NOTE = 'Showcase concept · not deployed';

export function isShowcasePair(pairId: string): boolean {
  return isPairId(pairId) && SHOWCASE_PAIR_IDS.has(canonicalPairId(pairId));
}
