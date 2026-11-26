/**
 * A flow that never starts (the production site, SH-V2-FE6). A request without a chain spec would run in the Demo,
 * and the production site has none: like a demo flow on a chain data source (`demoFlows: false`), it stays idle, so
 * nothing scripted can ever show next to real chain data. The Demo's controller and its mock scripts are not shipped.
 */
import type { TxState } from '@squarehole/domain';
import type { TxFlowController, TxFlowControls, TxFlowEnvironment, TxFlowRequest, TxFlowSnapshot, TxStateListener } from './tx-flow-controller';

const noop = (): void => undefined;
const nothing = (): Promise<void> => Promise.resolve();

export class IdleTxFlowController implements TxFlowController {
  /** This flow's own idle object, so the status panel can find the flow's label. */
  private readonly idle: TxState = Object.freeze({ status: 'idle' });
  private readonly snapshot: TxFlowSnapshot = Object.freeze({ state: this.idle, switching: false });

  constructor(request: TxFlowRequest, _env: TxFlowEnvironment, onState?: TxStateListener) {
    const controls: TxFlowControls = Object.freeze({ label: request.label, interactive: false, scriptLocked: true, sign: noop, reject: noop, switchChain: nothing, retry: noop, cancel: noop });
    onState?.(this.idle, controls);
  }

  readonly subscribe = (): (() => void) => noop;
  readonly getSnapshot = (): TxFlowSnapshot => this.snapshot;
  configure(): void {}
  readonly start = noop;
  readonly sign = noop;
  readonly reject = noop;
  readonly switchChain = nothing;
  readonly reset = noop;
  dispose(): void {}
}
