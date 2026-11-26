/**
 * Links a state object to the flow that produced it, so `TxStatusPanel({ state })` can offer that flow's demo wallet
 * buttons (sign/reject), switch and retry without extra props. Reducer states are frozen and a new object is created
 * on every transition, so the object itself identifies the flow; entries go away with the states (WeakMap).
 */
import type { TxState } from '@squarehole/domain';
import type { TxFlowControls } from './tx-flow-controller';

const controlsByState = new WeakMap<TxState, TxFlowControls>();

export function registerTxState(state: TxState, controls: TxFlowControls): void {
  controlsByState.set(state, controls);
}

export function txControlsFor(state: TxState): TxFlowControls | null {
  return controlsByState.get(state) ?? null;
}
