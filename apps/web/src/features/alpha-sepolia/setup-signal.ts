/**
 * F166 af2 (SH-ALPHA-ONBOARDING): whether a "Set me up" run of this visit is under way or ended and not put away. The
 * run itself lives in the trade folders (trade-sepolia/setup-run.ts, a lazily loaded chunk); the shell's welcome mount
 * (shell/AlphaWelcomeMount.tsx) loads only this folder's small gate (welcome-gate.ts re-exports these), so this one flag
 * is how the mount learns that a run started anywhere (the Claim card too) and keeps the run's chip in the top bar on
 * every page. One module instance for the page: both chunks import it. Nothing here runs a step, and nothing is stored.
 */
let live = false;
const listeners = new Set<() => void>();

/** The run module says whether its run shows (any phase but `idle`). */
export function noteSetupRun(on: boolean): void {
  if (live === on) return;
  live = on;
  for (const listener of [...listeners]) listener();
}

/** Whether a run of this visit shows now. */
export const setupRunLive = (): boolean => live;

/** A listener for each change (the mount's `useSyncExternalStore`). */
export function subscribeSetupRun(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
