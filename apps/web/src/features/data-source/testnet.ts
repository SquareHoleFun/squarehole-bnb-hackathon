/**
 * SH-258: this build's test network, as the site's pages use it. The profile itself lives in the chain package
 * (packages/chain/src/config/testnet-profile.ts, chosen by `SH_TESTNET`: Sepolia by default, BNB Chain testnet under
 * `SH_TESTNET=bnb`); this module adds the site's explorer links for it. The data source named `sepolia` is this
 * network, whatever its name.
 */
import { TESTNET } from '@squarehole/chain/write/wallet';
import { boxContractHref, isTestnetExplorerId, sepoliaExplorerHref, type BoxNetwork, type TestnetExplorerId } from '@squarehole/links';

export { TESTNET };

/** The test network's first explorer (Etherscan's Sepolia site, or BscScan's testnet). */
const first = TESTNET.explorers[0]?.id;
export const TESTNET_EXPLORER: TestnetExplorerId = isTestnetExplorerId(first) ? first : 'etherscan-sepolia';

/** An address or transaction page on the test network's explorer; null on any other chain (links.sepoliaExplorerHref). */
export const testnetExplorerHref = (target: { readonly chainId: number; readonly address?: string; readonly txHash?: string }): string | null =>
  sepoliaExplorerHref(TESTNET_EXPLORER, target);

/** A box contract's page on the test network's explorer (the `sepolia` source only). */
export const testnetContractHref = (network: BoxNetwork, address: string): string | null =>
  boxContractHref(network, address, TESTNET_EXPLORER === 'bscscan-testnet' ? 'bscscan-testnet' : 'etherscan-sepolia');
