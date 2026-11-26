// Transaction flow feature: demo flows over the domain txReducer and the mock executor (SH-015), and real chain flows
// over the same reducer and the write-side executor of @squarehole/chain (Stage C, ADR-0012).
export { DEMO_WALLET_CANNOT_SIGN, ChainTxFlowController } from './chain-flow-controller';
export { chainCreateLaunchFromDraftSpec, chainCreateLaunchSpec, chainClaimSpec, chainClaimAsTSpec, chainClaimAsQFallbackSpec, type ChainWriteTarget } from './chain-requests';
export { EMPTY_CHAIN_INFO, type ChainFlowInfo, type ChainTxSpec, type WalletSigner } from './chain-types';
export { demoNow, demoNowMs } from './demo-clock';
export { DEMO_SCENARIO_LABELS, getDemoTxScenario, isMockTxScriptName, setDemoTxScenario, useDemoTxScenario } from './demo-scenario';
export { CHAIN_TX_FLOW_CONFIG, DEFAULT_TX_FLOW_CONFIG, TX_DEMO_MODE, TxFlowConfigProvider, useTxFlowConfig, type TxFlowConfig } from './tx-config';
export { explainReason, txCopy, type TxCopy, type TxCopyMode, type TxTone } from './tx-copy';
export { networkFeeText, txExplorerHref } from './tx-format';
export {
  DemoTxFlowController,
  TxSwitchDeclinedError,
  isTxBusy,
  type ChainFlowControls,
  type TxFlowController,
  type TxFlowControls,
  type TxFlowEnvironment,
  type TxFlowKind,
  type TxFlowRequest,
  type TxFlowSnapshot,
} from './tx-flow-controller';
export { txScriptProfile, type TxScriptProfile } from './tx-script';
export { DemoScenarioPicker, TxStatusPanel, type TxStatusPanelProps } from './TxStatusPanel';
export {
  createTxFlowController,
  useControlledTxFlow,
  useTxFlow,
  useTxFlowEnvironment,
  type TxFlow,
  type TxFlowOptions,
} from './useTxFlow';
