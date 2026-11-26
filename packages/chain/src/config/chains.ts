/**
 * The two chains the app may read (ADR-0012): the local anvil chain 31337 and the build's test network (Ethereum
 * Sepolia 11155111, or BNB Chain testnet 97 under `SH_TESTNET=bnb`; SH-258). The values live in `networks.ts` (the
 * single, viem-free chain table shared with the write side); this module adds the viem chain objects. There is no
 * mainnet definition anywhere in this package (G08).
 */
import { defineChain, type Chain } from 'viem';
import { LOCAL_CHAIN_ID, NETWORKS, TESTNET, TESTNET_CHAIN_ID, type SupportedChainId } from './networks';

export {
  BNB_TESTNET_CHAIN_ID,
  DEFAULT_LOCAL_RPC_URL,
  LOCAL_CHAIN_ID,
  NETWORKS,
  SEPOLIA_CANONICAL_QUOTES,
  SEPOLIA_CHAIN_ID,
  SEPOLIA_EXPLORERS,
  SEPOLIA_MULTICALL3,
  SEPOLIA_PUBLIC_RPC_URLS,
  SEPOLIA_TESTNET_CHAIN_ID,
  SEPOLIA_UNISWAP_V4,
  SUPPORTED_CHAIN_IDS,
  TESTNET,
  TESTNET_CHAIN_ID,
  TESTNET_PROFILES,
  TESTNET_SETTING,
  TESTNET_UNISWAP_V4,
  isSupportedChainId,
  readTestnetSetting,
  testnetNameOf,
  testnetProfileOfChain,
  type SupportedChainId,
  type TestnetAddChain,
  type TestnetChainId,
  type TestnetExplorer,
  type TestnetName,
  type TestnetProfile,
  type TestnetSwitches,
} from './networks';

/** viem chain objects built here (not imported from viem/chains) so the RPC list is exactly ours. */
export function viemChain(chainId: SupportedChainId, rpcUrls: readonly string[]): Chain {
  const network = NETWORKS[chainId];
  if (chainId === TESTNET_CHAIN_ID) {
    const [explorer] = TESTNET.explorers;
    return defineChain({
      id: TESTNET_CHAIN_ID,
      name: network.name,
      nativeCurrency: { name: network.nativeName, symbol: network.nativeSymbol, decimals: 18 },
      rpcUrls: { default: { http: [...rpcUrls] } },
      blockExplorers: explorer ? { default: { name: explorer.name, url: explorer.origin } } : undefined,
      contracts: { multicall3: { address: TESTNET.multicall3 } },
      testnet: true,
    });
  }
  // The other test network's id is a SupportedChainId by type only: this build does not read it.
  if (chainId !== LOCAL_CHAIN_ID) throw new Error(`Chain ${String(chainId)} is not this build's test network (${TESTNET_CHAIN_ID})`);
  return defineChain({
    id: LOCAL_CHAIN_ID,
    name: network.name,
    nativeCurrency: { name: network.nativeName, symbol: network.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [...rpcUrls] } },
    testnet: true,
  });
}
