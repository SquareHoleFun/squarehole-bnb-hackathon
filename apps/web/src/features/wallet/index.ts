// Wallet feature: the demo adapter (SH-015) and the injected browser-wallet adapter (Stage C, EIP-6963 / EIP-1193).
export { BROWSER_WALLET_TITLE, BrowserWalletDialog, type BrowserWalletDialogProps } from './BrowserWalletDialog';
export { ConnectWalletButton } from './ConnectWalletButton';
export {
  BROWSER_WALLET_ID,
  createInjectedWalletAdapter,
  type BrowserWalletOption,
  type InjectedWalletAdapter,
  type InjectedWalletAdapterOptions,
  type ProvidedWallet,
} from './injected-adapter';
export { DEMO_WALLET_TITLE, DemoWalletDialog, type DemoWalletDialogProps } from './DemoWalletDialog';
export { BOX_PERSONAS, DEMO_WALLET_A, DEMO_WALLET_B, PICKER_PERSONAS, PickerPersonasContext, WALLET_PERSONAS, personaCopy, type PersonaCopy, type WalletPersona } from './personas';
export {
  DEMO_WRONG_CHAIN_ID,
  WalletError,
  chainLabel,
  createDemoWalletAdapter,
  liveChainLabel,
  personaForAccount,
  shortAddress,
  type DemoWalletAdapterOptions,
  type WalletAdapter,
  type WalletConnectRequest,
  type WalletConnection,
  type WalletErrorCode,
  type WalletKind,
} from './wallet-adapter';
export {
  WalletProvider,
  useOptionalWallet,
  useWallet,
  type ConnectedSigner,
  type ProvidedResume,
  type WalletConnectOptions,
  type WalletContextValue,
  type WalletProviderProps,
  type WalletKinds,
  type WalletStatus,
} from './wallet-context';
