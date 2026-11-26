/**
 * Release time is earned only by matching wall and monotonic deltas in one browser lifetime.
 * Both readings must be nonnegative safe integers. Backward time or drift over 1 second resets
 * the wait and refuses this release. A new lifetime (including reload) starts a fresh wait.
 * The previous reading and earned elapsed time live with the intent in the shared journal.
 * No wall-only gap, browser suspension with a stopped monotonic clock, or NaN grants elapsed time.
 */
import { saveRevealIntent, validClock, type ReleaseClock, type RevealProgress, type RevealProgressStore, type RevealIntent } from './reveal-items-store';
export type RevealClock = () => Omit<ReleaseClock, 'elapsed'>;
export const browserRevealClock = (): RevealClock => {
  const epoch = crypto.randomUUID();
  return () => ({ wall: Date.now(), tick: Math.floor(performance.now()), epoch });
};
export function startReleaseClock(clock: RevealClock): ReleaseClock {
  const next = { ...clock(), elapsed: 0 };
  if (!validClock(next)) throw new Error('invalid-clock');
  return next;
}
/**
 * SH-203 af5 (R4-L2b): how long, with this tab open, every read has found a sent transaction gone from the node: the
 * node knows no such transaction (pending or mined, at its latest block) and has no receipt for it. One read that finds
 * it, finds a receipt, or fails ends the window (a failed read never counts as absence); so do a gap between two reads
 * of more than `ABSENCE_GAP_MS`, backward time, wall and monotonic drift over a second, and a new tab lifetime, as for
 * `releaseWait`. The window lives in the session's memory only: a reload or a new session starts it again.
 */
export const ABSENCE_GAP_MS = 120_000;
type ClockReading = ReturnType<RevealClock>;
export interface AbsenceWindow { readonly hash: string; readonly start: number; readonly last: ClockReading; readonly elapsed: number }
export function observeAbsence(previous: AbsenceWindow | undefined, hash: string, now: ClockReading, absent: boolean): AbsenceWindow | undefined {
  if (!absent) return undefined;
  const fresh: AbsenceWindow = { hash, start: now.wall, last: { ...now }, elapsed: 0 };
  if (!previous || previous.hash !== hash || previous.last.epoch !== now.epoch) return fresh;
  const wall = now.wall - previous.last.wall, tick = now.tick - previous.last.tick;
  if (!(wall >= 0 && tick >= 0 && Math.abs(wall - tick) <= 1_000 && Math.min(wall, tick) <= ABSENCE_GAP_MS)) return fresh;
  return { hash, start: previous.start, last: { ...now }, elapsed: previous.elapsed + Math.min(wall, tick) };
}
export async function releaseWait(store: RevealProgressStore, key: string, progress: RevealProgress, intent: RevealIntent, clock: RevealClock): Promise<boolean> {
  const now = startReleaseClock(clock), before = intent.clock;
  let valid = false, elapsed = 0;
  if (before && before.epoch === now.epoch) {
    const wall = now.wall - before.wall, tick = now.tick - before.tick;
    valid = wall >= 0 && tick >= 0 && Math.abs(wall - tick) <= 1_000;
    if (valid) elapsed = before.elapsed + Math.min(wall, tick);
  }
  const next = { ...now, elapsed };
  if (!validClock(next)) return false;
  await saveRevealIntent(store, key, progress, { ...intent, clock: next });
  return valid && elapsed >= 1_800_000;
}
