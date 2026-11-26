// Chain adapters, write side (Stage C; ADR-0012): the injected wallet session, the transaction executor and the only
// writes the app makes (createLaunch, claim, claimAsT and the labelled sold-out Q fallback). No swap builder exists.
export {
  DEFAULT_LOCAL_RPC_URL,
  EIP7825_TX_GAS_CAP,
  LOCAL_CHAIN_ID,
  LOCAL_FINALITY_CONFIRMATIONS,
  SEPOLIA_CHAIN_ID,
  SEPOLIA_WRITE_CHAIN,
  TESTNET_CHAIN_ID,
  TESTNET_WRITE_CHAIN,
  UnsupportedWriteChainError,
  WRITE_CHAIN_IDS,
  chainIdHex,
  isWriteChainId,
  localChain,
  writeChain,
  type AddEthereumChainParameter,
  type FinalityPolicy,
  type WriteChain,
} from './chains';
export {
  NotSendableError,
  SENDABLE_SELECTORS,
  SENDABLE_SIGNATURES,
  assertSendableCall,
  claimAsQWhenSoldOutCall,
  claimAsTCall,
  claimCall,
  createLaunchCall,
  type LaunchParams,
  type WriteCall,
  type WriteFunction,
} from './calls';
export {
  CLAIM_AS_T_DEADLINE_SECONDS,
  CLAIM_AS_T_TOLERANCE_BPS,
  prepareClaim,
  prepareClaimAsQWhenSoldOut,
  prepareClaimAsT,
  quoteClaimAsT,
  readConversionStatus,
  type ClaimAsTQuote,
  type ClaimContext,
  type ClaimOutcome,
  type ConversionStatus,
} from './claims';
export {
  DeploymentManifestError,
  parseWriteDeployment,
  templateForQuote,
  testnetMockDisclosure,
  writeDeploymentOf,
  type WriteDeployment,
  type WriteTemplate,
} from './deployment';
export {
  RPC_CODES,
  cleanText,
  errorMessage,
  isUserRejection,
  parseAccounts,
  parseChainId,
  rpcErrorCode,
  type Eip1193Provider,
  type Eip1193Request,
  type Eip1193RequestArguments,
} from './eip1193';
export { MAX_ICON_LENGTH, discoverWallets, parseAnnouncement, safeWalletIcon, type DiscoveredWallet, type DiscoveryTarget } from './eip6963';
export {
  InsufficientGasFundsError,
  MIN_PRIORITY_FEE_WEI,
  TxTracker,
  WalletContextChangedError,
  WalletRejectedError,
  WalletRequestError,
  feeEstimateOf,
  readFeeEstimate,
  readSendFees,
  sendCostCap,
  tipCapOf,
  sendFeesOf,
  readsGasPrice,
  TIP_CAPS,
  DEFAULT_TIP_CAP,
  NetworkPriceError,
  checkRequestPrice,
  PreSendRefusalError,
  preSendRefusalText,
  simulateWrite,
  submitCreateWriteV2,
  submitWrite,
  type CreateSubmitOptionsV2,
  type FeeEstimate,
  type SendFeeInput,
  type SendFeeReader,
  type SendFees,
  type ReplacementInfo,
  type ReplacementKind,
  type Simulation,
  type SimulationResult,
  type SubmitOptions,
  type TrackerEnd,
  type TrackerOptions,
} from './executor';
export {
  InjectedWalletError,
  InjectedWalletSession,
  normalizeSignatureV,
  signTypedDataV4,
  type InjectedConnection,
  type InjectedSource,
  type InjectedWalletErrorCode,
  type InjectedWalletMeta,
} from './injected-wallet';
export {
  LAUNCHER_LIMITS,
  createLaunchInputFromDraft,
  createLaunchInputIssues,
  launchRecordMismatch,
  prepareCreateLaunch,
  readLaunchTemplateBounds,
  type CreateLaunchInput,
  type DraftConversionOptions,
  type LaunchTemplateBounds,
  type PrepareContext,
  type VerifiedLaunch,
} from './launch';
export { PrepareRefusal, type PreparedWrite, type RefusalCode, type VerifyOutcome, type VerifyStage, type WriteDetail, type WriteVerifier } from './prepared';
export { runChainWrite, type ChainWriteHooks, type ChainWriteOptions, type WalletErrorReason } from './run';
export { WiringError, appPairId, checkDeploymentWiring, readRegistryPair, registryPairId, type RegistryPair } from './registry-reads';
export { decodeRevert, revertDataOf, revertReason, rootRevertName, type DecodedRevert } from './revert';
export { MAX_RETRY_AFTER_MS, REFUSED_PAUSES_MS, refusedPauseMs, refusedRetryFetch, retryAfterMs, type FetchLike, type RefusedRetryOptions } from './refused-fetch';
export {
  RpcRequestError,
  createChainReader,
  createHttpRequest,
  type BlockTag,
  type CallRequest,
  type ChainReader,
  type RpcBlock,
  type RpcLog,
  type RpcTransaction,
  type TxReceipt,
} from './rpc';

export * from '../core/set-v2/tx';
export type { SetSubmitOptionsV2 } from './executor';
export { submitSetCreateWrite, type SetCreateSubmitOptionsV2 } from './executor';
