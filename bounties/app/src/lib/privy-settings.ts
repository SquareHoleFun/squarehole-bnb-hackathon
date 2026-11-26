/**
 * SH-280: Privy's client settings on the launch pages: the platform's (apps/web/src/features/trade-sepolia/privy-live.tsx
 * `privyClientConfigOf` for BNB Chain testnet). No code of Privy's here (types only), so the page's first load and the
 * tests read these without the SDK; made-wallet.test.ts compares the chain with the platform's profile.
 */
import type { PrivyClientConfig } from '@privy-io/react-auth';
import { defineChain, type Chain } from 'viem';

/** BNB Chain testnet as the platform's profile has it (packages/chain/src/config/testnet-profile.ts `BNB`). */
export const PRIVY_CHAIN: Chain = defineChain({
  id: 97,
  name: 'BNB Chain Testnet',
  nativeCurrency: { name: 'BNB', symbol: 'tBNB', decimals: 18 },
  rpcUrls: { default: { http: ['https://bsc-testnet-rpc.publicnode.com', 'https://bsc-prebsc-dataseed.bnbchain.org'] } },
  blockExplorers: { default: { name: 'BscScan (Testnet)', url: 'https://testnet.bscscan.com' } },
  testnet: true,
});

/** The platform's client settings (apps/web/src/features/trade-sepolia/privy-live.tsx `privyClientConfigOf`). */
export const PRIVY_CLIENT_CONFIG: PrivyClientConfig = Object.freeze({
  loginMethods: ['twitter'],
  appearance: { theme: 'dark', walletChainType: 'ethereum-only' },
  embeddedWallets: { ethereum: { createOnLogin: 'off' }, showWalletUIs: false },
  externalWallets: { walletConnect: { enabled: false }, disableAllExternalWallets: true },
  defaultChain: PRIVY_CHAIN,
  supportedChains: [PRIVY_CHAIN],
  sessions: { cookieWriteBehavior: 'never' },
}) as PrivyClientConfig;

