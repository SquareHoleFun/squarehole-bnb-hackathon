import { isTxSuccess, type TxState } from '@squarehole/domain';
import type { MockTxScriptName } from '@squarehole/providers';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useWallet } from '../wallet';
import { ChainTxFlowController } from './chain-flow-controller';
import type { ChainFlowInfo, ChainTxSpec } from './chain-types';
import { useTxFlowConfig } from './tx-config';
import { DemoTxFlowController, isTxBusy, type TxFlowController, type TxFlowEnvironment, type TxFlowKind, type TxFlowRequest } from './tx-flow-controller';
import { registerTxState } from './tx-registry';
import { useDemoTxScenario } from './demo-scenario';
import { IdleTxFlowController } from './idle-flow-controller';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

export interface TxFlowOptions {
  kind: TxFlowKind;
  label: string;
  requiredChainId: number;
  deadline?: string;
  script?: MockTxScriptName;
  /** Stage C: a real chain request (see `ChainTxSpec`); omit for a demo flow. Must stay set for the flow's lifetime. */
  chain?: ChainTxSpec;
}

export interface TxFlow {
  readonly state: TxState;
  /** Prepares and simulates a new request for the connected account (no-op while busy or disconnected). */
  start(): void;
  /** Signs in the demo wallet (only while awaiting a signature). */
  sign(): void;
  reject(): void;
  /** Asks the wallet to switch to `requiredChainId` (only on wrong_chain). Rejects if the wallet declines. */
  switchChain(): Promise<void>;
  reset(): void;
  /** A request is open: preparing, wrong network, awaiting signature, submitted, pending or included-not-final. */
  readonly isBusy: boolean;
  /** Only `finalized` is success; a hash, pending or included-not-final never is (UI-08). */
  readonly isSuccess: boolean;
  /** Chain flows: simulation, fee estimate, wallet progress and the verified result (null for demo flows). */
  readonly chain: ChainFlowInfo | null;
}

/**
 * A flow controller whose states the status panel can find (sign/reject, switch, retry). Owners that outlive a
 * component (the app-level claim store) create controllers with this and drive them with `useControlledTxFlow`.
 */
export function createTxFlowController(request: TxFlowRequest, env: TxFlowEnvironment): TxFlowController {
  if (request.chain) return new ChainTxFlowController({ ...request, chain: request.chain }, env, registerTxState);
  // The production site has no Demo flow to run a request without a chain spec in: it stays idle.
  return DEMO_BUILD ? new DemoTxFlowController(request, env, registerTxState) : new IdleTxFlowController(request, env, registerTxState);
}

/** The tester's "Demo scenario" choice; the production site has none (a constant hook per build). */
const useScenario: () => MockTxScriptName = DEMO_BUILD ? useDemoTxScenario : () => 'success';

/** The wallet, "Demo scenario" and clock a flow runs against, read from the current providers. */
export function useTxFlowEnvironment(): TxFlowEnvironment {
  const wallet = useWallet();
  const scenario = useScenario();
  const config = useTxFlowConfig();
  return {
    account: wallet.status === 'connected' ? wallet.account : null,
    chainId: wallet.status === 'connected' ? wallet.chainId : null,
    switchWalletChain: wallet.switchChain,
    scenario,
    now: config.now,
    stepMs: config.stepMs,
    signer: wallet.status === 'connected' ? wallet.signer : null,
    demoFlows: config.demoFlows ?? true,
  };
}

/**
 * Renders and drives a controller owned elsewhere: hands it the latest request options and wallet environment after
 * every render (wallet changes become reducer events there) and re-renders on its state changes. The owner decides
 * when the controller is disposed; unmounting this component does not stop the flow.
 */
export function useControlledTxFlow(controller: TxFlowController, request: TxFlowRequest, env: TxFlowEnvironment): TxFlow {
  useEffect(() => {
    controller.configure(request, env);
  });
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  return useMemo(
    () => ({
      state: snapshot.state,
      start: controller.start,
      sign: controller.sign,
      reject: controller.reject,
      switchChain: controller.switchChain,
      reset: controller.reset,
      isBusy: isTxBusy(snapshot),
      isSuccess: isTxSuccess(snapshot.state),
      chain: snapshot.chain ?? null,
    }),
    [snapshot, controller],
  );
}

/**
 * Transaction flow for creation and claims. Without `options.chain` it is the demo flow: the domain `txReducer` driven
 * by the mock executor script, the demo wallet and the demo clock. With `options.chain` it runs the real executor
 * through the connected browser wallet (`ChainTxFlowController`). Reacts to wallet account/chain changes (invalidation before signing) and to the quote
 * deadline passing. Wallet requests only follow the person's own actions (start, switch, sign). The flow belongs to
 * the calling component and stops with it; claims use the app-level claim store instead, so a signed claim outlives
 * its card (features/rewards/claim-flows.ts).
 */
export function useTxFlow(options: TxFlowOptions): TxFlow {
  const env = useTxFlowEnvironment();
  const [controller] = useState(() => createTxFlowController(options, env));
  useEffect(() => () => controller.dispose(), [controller]);
  return useControlledTxFlow(controller, options, env);
}
