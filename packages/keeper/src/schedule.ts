/**
 * Box 0's rhythm, for every box (F95 R19U: "Deepen every hour, collect every 2 hours, never collect right before
 * deepen"; tickets § 8 applies it to v2). Hour slots are clock hours. In each slot the deepen comes first; a collect
 * follows only after that slot's deepen was tried, never in its block, and never in the guard window at the slot's
 * end, so no collect lands right before the next slot's deepen. A deepen that skipped is retried in the slot until a
 * collect ran there.
 */
export const HOUR = 3_600n;
export const COLLECT_EVERY = 7_200n;
/** The end of each slot where no collect is sent, so the next deepen never follows a collect closely [P]. */
export const COLLECT_GUARD = 900n;
/** A skipped deepen waits this many blocks before it is tried again in its slot [P]. */
export const DEEPEN_RETRY_BLOCKS = 25n;
/** While a slot's deepen has not run, a collect waits until this far into the slot, so the retries come first [P]. */
export const DEEPEN_FIRST_SECONDS = 1_800n;

export interface Cadence {
  readonly deepenSentSlot: bigint | null;
  readonly deepenTriedSlot: bigint | null;
  readonly deepenTriedBlock: bigint;
  readonly collectedAt: bigint | null;
  readonly collectSlot: bigint | null;
}

export const NO_CADENCE: Cadence = Object.freeze({
  deepenSentSlot: null,
  deepenTriedSlot: null,
  deepenTriedBlock: 0n,
  collectedAt: null,
  collectSlot: null,
});

const slotOf = (now: bigint) => now / HOUR;

export function deepenDue(c: Cadence, now: bigint, block?: bigint): boolean {
  const slot = slotOf(now);
  if (c.deepenSentSlot === slot || c.collectSlot === slot) return false;
  if (c.deepenTriedSlot !== slot) return true;
  return block !== undefined && block >= c.deepenTriedBlock + DEEPEN_RETRY_BLOCKS;
}

export function collectDue(c: Cadence, now: bigint, block: bigint): boolean {
  const slot = slotOf(now);
  const offset = now % HOUR;
  if (c.collectedAt !== null && now - c.collectedAt < COLLECT_EVERY) return false;
  if (c.deepenTriedSlot !== slot || block <= c.deepenTriedBlock) return false;
  if (offset >= HOUR - COLLECT_GUARD) return false;
  return c.deepenSentSlot === slot || offset >= DEEPEN_FIRST_SECONDS;
}

export function noteDeepen(c: Cadence, now: bigint, block: bigint, sent = true): Cadence {
  const slot = slotOf(now);
  return { ...c, deepenTriedSlot: slot, deepenTriedBlock: block, deepenSentSlot: sent ? slot : c.deepenSentSlot };
}

export function noteCollect(c: Cadence, now: bigint): Cadence {
  return { ...c, collectedAt: now, collectSlot: slotOf(now) };
}
