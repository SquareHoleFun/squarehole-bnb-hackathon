// The browser-wallet half of the write side (`@squarehole/chain/write/wallet`): EIP-1193 helpers, EIP-6963 discovery,
// the injected wallet session and the write-chain table. No ABI coder and no executor, so the app can import it with
// the page while the executor (`@squarehole/chain/write`, which brings viem) loads with the first chain request.
export {
  DEFAULT_LOCAL_RPC_URL,
  LOCAL_CHAIN_ID,
  SEPOLIA_CHAIN_ID,
  TESTNET_CHAIN_ID,
  WRITE_CHAIN_IDS,
  chainIdHex,
  isWriteChainId,
  localChain,
  writeChain,
  type WriteChain,
} from './chains';
// SH-258: the build's test network (its name, coin, explorer and switches), viem-free like the rest of this entry.
export { TESTNET, TESTNET_PROFILES, type TestnetProfile, type TestnetSwitches } from '../config/testnet-profile';
export { RPC_CODES, cleanText, errorMessage, isUserRejection, parseAccounts, parseChainId, rpcErrorCode, type Eip1193Provider, type Eip1193Request } from './eip1193';
export { MAX_ICON_LENGTH, discoverWallets, parseAnnouncement, safeWalletIcon, type DiscoveredWallet, type DiscoveryTarget } from './eip6963';
export { InjectedWalletError, InjectedWalletSession, normalizeSignatureV, signTypedDataV4, type InjectedConnection, type InjectedSource, type InjectedWalletErrorCode, type InjectedWalletMeta } from './injected-wallet';
// SH-278: the reads' one retry rule (HTTP 429 only), for the page's viem transports; no dependency.
export { MAX_RETRY_AFTER_MS, REFUSED_PAUSES_MS, refusedPauseMs, refusedRetryFetch, retryAfterMs, type FetchLike, type RefusedRetryOptions } from './refused-fetch';
