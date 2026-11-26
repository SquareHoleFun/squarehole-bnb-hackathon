/**
 * The state of a launch box (the Misfits, a rehearsal) from the live curve and the vault (BOX-INTERFACE § 3):
 * - before the open (window `before_open`): Upcoming;
 * - the 32-block launch window (`router_window`): Launch window;
 * - the curve open after the window: Bonding;
 * - the hook's `completed` phase: Graduating ("Target reached" is not graduated, BOX-SYSTEM § 4.1);
 * - the hook's `migrated` phase, or the vault's gate open: Graduated.
 * A launch box is never "failed": it has no deadline (F1, F4). Without readable data the state is null and the page
 * says "Unavailable"; it never guesses.
 */
import type { LiveData } from '../fit-pair/live-model';
import type { BoxState } from './box-model';

export interface GateRead {
  readonly gateOpen: boolean | null;
}

export function launchBoxState(live: Pick<LiveData, 'state' | 'window'> | null, vault: GateRead | null): BoxState | null {
  if (vault?.gateOpen === true) return 'graduated';
  if (live === null) return null;
  if (live.state.phase === 'migrated') return 'graduated';
  if (live.state.phase === 'completed') return 'graduating';
  switch (live.window.status) {
    case 'before_open':
      return 'upcoming';
    case 'router_window':
      return 'window';
    default:
      return 'bonding';
  }
}

/** The states a curve is running in (the progress bar and the curve figures apply). */
export const CURVE_STATES: ReadonlySet<BoxState> = new Set<BoxState>(['window', 'bonding', 'graduating']);
