/**
 * Box 0 in terminal mode (SH-BOX0-EXITS): the hidden item a take by number names, and its pool index.
 * `BoxTickets.takeByNumber(itemId, poolIndex, …)` accepts:
 *
 * - numbered (the graduation word stored, or no placeholders): an item whose position π_w⁻¹(itemId − firstId) is in the
 *   draw pool at `poolIndex` (index < R = N − q − settled draws, `poolPositionAt(index)` equal to that position), so the
 *   page walks the pool's indexes and maps each position forward (π_w; the identity when q = 0);
 * - without numbers (placeholders, no word stored): any item, `poolIndex` unused.
 *
 * Either way the vault delivers only a hidden item (`NotHidden`): a take by number leaves its position in the pool, so
 * each candidate is checked with `isHidden`. Public reads only; at most `limit` candidates, read 8 at a time.
 *
 * The walk starts at `start` (folded into the span) and wraps around its end. Takes never leave the pool, so after 64
 * of them a walk that always began at index 0 would meet only taken items and hide the take for good (review of
 * SH-BOX0-EXITS); the reads pass a random start (`takeSearchStart`). Terminal mode has no randomness of its own: the
 * start only spreads the page's reads, the art is unrevealed either way.
 */
import { permutePlaceholderShuffle } from '@squarehole/chain';
import type { Hex } from 'viem';

export interface PoolReader {
  positionAt(index: bigint): Promise<bigint>;
  isHidden(itemId: bigint): Promise<boolean>;
}

export interface TakeCandidate {
  readonly itemId: bigint;
  readonly poolIndex: bigint;
}

const BATCH = 8;
export const TAKE_SEARCH_LIMIT = 64;

export async function findTakeable(
  s: { readonly slots: bigint; readonly wordAcceptedAt: bigint; readonly drawsSettled: bigint },
  pool: { readonly word: Hex; readonly firstId: bigint; readonly size: bigint },
  reader: PoolReader,
  limit = TAKE_SEARCH_LIMIT,
  start = 0n,
): Promise<TakeCandidate | null> {
  const numbered = !(s.slots !== 0n && s.wordAcceptedAt === 0n);
  const span = takeSpan(s, pool.size);
  const count = span <= 0n ? 0n : span < BigInt(limit) ? span : BigInt(limit);
  const from = span <= 0n ? 0n : ((start % span) + span) % span;
  const candidate = async (i: bigint): Promise<TakeCandidate> => {
    if (!numbered) return { itemId: pool.firstId + i, poolIndex: 0n };
    const position = await reader.positionAt(i);
    const offset = s.slots === 0n ? position : permutePlaceholderShuffle(pool.word, position, pool.size);
    return { itemId: pool.firstId + offset, poolIndex: i };
  };
  for (let step = 0n; step < count; step += BigInt(BATCH)) {
    const indexes: bigint[] = [];
    for (let j = step; j < count && j < step + BigInt(BATCH); j += 1n) indexes.push((from + j) % span);
    const found = await Promise.all(indexes.map(async (i) => {
      const c = await candidate(i);
      return (await reader.isHidden(c.itemId)) ? c : null;
    }));
    const first = found.find((c): c is TakeCandidate => c !== null);
    if (first) return first;
  }
  return null;
}

/** What the walk runs over: the draw pool's R = N − q − settled indexes once numbered, else every item offset. */
export function takeSpan(s: { readonly slots: bigint; readonly wordAcceptedAt: bigint; readonly drawsSettled: bigint }, size: bigint): bigint {
  const numbered = !(s.slots !== 0n && s.wordAcceptedAt === 0n);
  return numbered ? size - s.slots - s.drawsSettled : size;
}

/** A random index in [0, span) for the walk's start (0 for an empty span). An index, never an amount. */
export function takeSearchStart(span: bigint, random: () => number = Math.random): bigint {
  if (span <= 0n) return 0n;
  return BigInt(Math.floor(random() * Number.MAX_SAFE_INTEGER)) % span;
}
