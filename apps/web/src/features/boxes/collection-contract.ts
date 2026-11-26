/**
 * The collection contract row every box page shows (F71 (1): "check or link their collections in the box so users can
 * verify what really is in there"; box creation flow § 3.3). Identity is the address, never the name:
 *
 * - a launch box: its collection's address from the market record, with the explorer link where one is reviewed
 *   (`fitExplorerHref`: Ethereum and Sepolia);
 * - a new collection built from a BoxSpec: its own contract, known only at creation ("Address at creation" in the Demo);
 * - existing NFTs: the source collection's address, fixed in the box, "Unverified collection" unless it is on the
 *   curated list (none is, today);
 * - a token-only box: no collection.
 *
 * Marketplace links: no marketplace origin is reviewed in the link allowlist yet and Sepolia has no NFT marketplace view
 * (docs/research/sepolia-infrastructure.md, B-DISC-03), so the row says why instead of linking. Nothing is fetched.
 *
 * A core v1 box (a registry row) has its collection's address from the row, and its reasons and links follow its SOURCE,
 * never its chain id (S10a review): the local twin carries Sepolia's chain id but is a local chain (no explorer, no
 * marketplace), and only a Sepolia row gets the Sepolia explorer.
 */
import { fitExplorerHref } from '@squarehole/links';
import { TESTNET, testnetContractHref } from '../data-source/testnet';
import type { Address } from '@squarehole/domain';
import type { BoxRecord } from './box-model';
import { chainRowOf } from '../core/row-record';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

export interface LinkState {
  readonly href: string | null;
  /** Why there is no link (shown in place of it). */
  readonly reason: string;
}

export interface CollectionContract {
  /** "Collection", or "Source collection" for existing NFTs. */
  readonly label: string;
  readonly address: Address | null;
  /** What stands in for the address, or a note beside it. */
  readonly note: string | null;
  /** F71 (1): existing NFTs are "Unverified" unless the collection is on the curated list. */
  readonly verification: 'verified' | 'unverified' | null;
  readonly explorer: LinkState;
  readonly marketplace: LinkState;
}

const SEPOLIA = TESTNET.chainId;
const MAINNET = 1;

function marketplaceReason(chainId: number, demo: boolean): string {
  if (DEMO_BUILD && (demo || chainId === 31_337)) return 'No marketplace on a local chain';
  if (chainId === SEPOLIA) return `${TESTNET.networkName} has no NFT marketplace view`;
  if (chainId === MAINNET) return 'No reviewed marketplace link yet';
  return 'No reviewed marketplace for this chain';
}

function explorer(chainId: number, address: Address | null, demo: boolean): LinkState {
  if (address === null) return { href: null, reason: 'No address yet' };
  if (DEMO_BUILD && demo) return { href: null, reason: 'No explorer for a local chain' };
  const href = fitExplorerHref(chainId, { address });
  return href ? { href, reason: '' } : { href: null, reason: 'No public explorer for this chain' };
}

/** A row box's reasons by its source (demo, the local twin, Sepolia), never by its chain id. */
function rowMarketplaceReason(network: 'local' | 'sepolia'): string {
  return network === 'local' ? 'No marketplace on a local chain' : `${TESTNET.networkName} has no NFT marketplace view`;
}

function rowExplorer(network: 'local' | 'sepolia', address: Address | null): LinkState {
  if (address === null) return { href: null, reason: 'No address yet' };
  const href = testnetContractHref(network, address);
  return href ? { href, reason: '' } : { href: null, reason: network === 'local' ? 'No explorer for a local chain' : 'No public explorer for this chain' };
}

/** The row for a box. */
export function collectionContract(record: BoxRecord): CollectionContract {
  const none: LinkState = { href: null, reason: 'No collection' };
  if (record.kind === 'token') {
    return { label: 'Collection', address: null, note: 'None: a token box', verification: null, explorer: none, marketplace: none };
  }
  // A core v1 box on a chain source: its collection from its row, links and reasons by its source (the Demo's row box
  // keeps the Demo market's rules below).
  const chainRow = chainRowOf(record);
  if (chainRow) {
    const { row, network } = chainRow;
    const address = (row.contracts.collection as Address | null) ?? null;
    return {
      label: 'Collection',
      address,
      note: address === null ? 'No collection in this box' : null,
      verification: null,
      explorer: rowExplorer(network, address),
      marketplace: { href: null, reason: rowMarketplaceReason(network) },
    };
  }
  const marketplace: LinkState = { href: null, reason: marketplaceReason(record.chainId, record.demo) };
  if (record.market) {
    const address = record.market.collection;
    return { label: 'Collection', address, note: address === null ? 'Not in this market record' : null, verification: null, explorer: explorer(record.chainId, address, record.demo), marketplace };
  }
  if (record.kind === 'existing') {
    return { label: 'Source collection', address: null, note: 'Fixed in the box', verification: 'unverified', explorer: explorer(record.chainId, null, record.demo), marketplace };
  }
  // A new collection: its own contract, made by the factory with the box (the Demo deploys nothing).
  return { label: 'Collection', address: null, note: 'Address at creation', verification: null, explorer: { href: null, reason: 'No address yet' }, marketplace };
}
