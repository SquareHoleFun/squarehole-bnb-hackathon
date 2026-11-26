import type { WalletBoxRead } from '@squarehole/chain';
import type { Address } from '@squarehole/domain';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useDataSource } from '../features/data-source';
import { SEPOLIA_CHAIN_ID } from '../features/data-source/data-source';
import { parseAddress } from '../features/boxes/box-id';
import type { BoxRecord } from '../features/boxes/box-model';
import { useBoxSources } from '../features/boxes/useBoxSources';
import { useLaunchSummary } from '../features/boxes/useLaunchBox';
import { chainWalletBox, coreWalletBox, demoWalletBox, isOwnWallet, type WalletBox } from '../features/boxes/wallet-box';
import type { BoxSources } from '../features/boxes/box-sources';
import { NETWORK_LABELS, recordFromRow, rowBoxId } from '../features/core/row-record';
import { useCoreSource, useCoreWallet } from '../features/core/useCore';
import { WalletBoxView } from '../features/boxes/WalletBoxView';
import { claimsWaiting, useWalletClaimsV2, type WalletClaims } from '../features/core/v2/WalletClaimsV2';
import { HoldingsViewV2, holdingsCountsV2, useHoldingsV2 } from '../features/core/v2/HoldingsV2';
import { directReaderFor } from '../features/fit-pair/direct-source';
import type { FitBuild, FitMarketTarget } from '../features/fit-pair/fit-target';
import { BackIcon } from '../features/pair/pair-icons';
import { useWallet } from '../features/wallet';
import { PAGE_TITLE_ID, PageHeading, usePageTitle } from './page-parts';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

function BackToBoxes() {
  return (
    <p className="sh-pair-back">
      <Link to="/" className="sh-pair-back__link">
        <BackIcon />
        Boxes
      </Link>
    </p>
  );
}

export interface WalletBoxPageProps {
  /** `/my-box`: the connected account; otherwise `/wallet/:address`. */
  readonly mine?: boolean;
  /** Test seams. */
  readonly build?: FitBuild;
  readonly readWallet?: (target: FitMarketTarget, account: Address) => Promise<WalletBoxRead>;
}

/**
 * `/wallet/:address` (any address, view only) and `/my-box` (the connected account). Read-only; a disconnected
 * `/my-box` says how to connect and never opens a wallet by itself (UI-09). On a chain source the wallet is read over
 * the market's RPC (never the wallet's provider); the Demo has two box wallets (A during the curve, B after graduation).
 */
export function WalletBoxPage({ mine = false, build, readWallet }: WalletBoxPageProps) {
  const { address: raw } = useParams();
  const wallet = useWallet();
  const connected = wallet.status === 'connected' ? wallet.account : null;
  const address = mine ? connected : parseAddress(raw);
  usePageTitle(mine ? 'My Box' : address ? 'Wallet' : 'Not a wallet address');
  if (address === null) {
    return (
      <section className="sh-page sh-box-page" aria-labelledby={PAGE_TITLE_ID}>
        <BackToBoxes />
        <div className="sh-page__header">
          <PageHeading>{mine ? 'My Box' : 'Not a wallet address'}</PageHeading>
        </div>
        <div className="sh-panel sh-box-empty">
          <p>{mine ? 'Connect a wallet (top right) to see your box. Nothing opens by itself.' : 'A wallet link is a full 0x address.'}</p>
        </div>
      </section>
    );
  }
  return <WalletBoxFor key={address.toLowerCase()} address={address} own={isOwnWallet(address, connected)} build={build} readWallet={readWallet} />;
}

function WalletBoxFor({ address, own, build, readWallet }: { address: Address; own: boolean; build?: FitBuild; readWallet?: WalletBoxPageProps['readWallet'] }) {
  const source = useDataSource();
  const sources = useBoxSources(build);
  const core = useCoreSource();
  const target = sources.launch;
  const record = target ? (sources.boxes.find((box) => box.market === target) ?? null) : null;
  // F128: on a chain source, the wallet's own claims across its v2 boxes, behind one Claim all (the Demo has none).
  const demo = DEMO_BUILD && source.isDemo;
  const v2Claims = useWalletClaimsV2(demo ? NO_BOXES : sources.boxes, address, own);
  const claims = demo ? null : (v2Claims ?? claimsWaiting(sources.v2 ?? null, sources.retry));
  return (
    <section className="sh-page sh-box-page sh-box-page--wallet" aria-labelledby={PAGE_TITLE_ID}>
      <BackToBoxes />
      {demo ? (
        <WalletBoxView wallet={demoWalletBox(address, sources.boxes)} unavailable={null} address={address} own={own} demo chainId={31_337} networkLabel="Local chain 31337" />
      ) : core.status === 'ready' ? (
        <CoreWalletBox address={address} own={own} sources={sources} claims={claims} />
      ) : target && record ? (
        <ChainWalletBox address={address} own={own} target={target} record={record} readWallet={readWallet} claims={claims} />
      ) : (
        <WalletBoxView wallet={null} unavailable={sources.missing ?? 'No market in this build.'} address={address} own={own} demo={false} chainId={source.id === 'sepolia' ? SEPOLIA_CHAIN_ID : 31_337} networkLabel={source.dataLabel} claims={claims} />
      )}
    </section>
  );
}

/**
 * A wallet across the source's core v1 boxes (S10a § 6; BC-089): one answer (the indexer's, or direct reads at one
 * block), one holding per box keyed by its token address, its state from the feed's own card.
 */
const NO_BOXES: readonly BoxRecord[] = Object.freeze([]);

function CoreWalletBox({ address, own, sources, claims }: { address: Address; own: boolean; sources: BoxSources; claims: WalletClaims | null }) {
  const core = useCoreSource();
  const source = useDataSource();
  const loaded = useCoreWallet(core, address);
  // SH-291: where the source has no first box generation (BNB Chain testnet), My Box lists the v2 holdings.
  const v2Only = core.status === 'ready' && core.version1 === null;
  const holdings = useHoldingsV2(sources.boxes, v2Only ? address : null, sources.v2 ?? null, sources.retry);
  const wallet: WalletBox | null = useMemo(() => {
    // SH-258: no core v1 version (BNB Chain testnet): no v1 holdings, never asked; the v2 claims show alone.
    if (core.status === 'ready' && core.version1 === null) return { ...coreWalletBox(address, [], null), holdingsRead: false };
    if (loaded?.status !== 'ready' || core.status !== 'ready') return null;
    const summaries = sources.core.status === 'ready' ? sources.core.summaries : new Map();
    const boxes = loaded.value.boxes.map(({ row, box, itemCount, ticketCount }) => {
      const record = sources.boxes.find((b) => b.id === rowBoxId(row)) ?? recordFromRow({ row, network: core.network }, { nowMs: 0, artGateways: core.artGateways });
      return { record, state: summaries.get(record.id)?.state ?? null, t: BigInt(box.t), tickets: ticketCount, items: itemCount, itemIds: box.items.map((id) => BigInt(id)), streamOwed: box.streamOwed === null ? null : BigInt(box.streamOwed) };
    });
    return coreWalletBox(address, boxes, loaded.value.asOf ? BigInt(loaded.value.asOf.block) : null);
  }, [loaded, core, sources, address]);
  return (
    <WalletBoxView
      wallet={wallet}
      unavailable={loaded?.status === 'error' ? loaded.reason : null}
      address={address}
      own={own}
      demo={false}
      chainId={core.status === 'ready' ? core.chainId : SEPOLIA_CHAIN_ID}
      networkLabel={core.status === 'ready' ? NETWORK_LABELS[core.network] : source.dataLabel}
      local={core.status === 'ready' && core.network === 'local'}
      claims={claims}
      holdings={v2Only ? { contents: <HoldingsViewV2 state={holdings} claims={own ? (claims?.boxes ?? null) : null} claimsKnown={!own || (claims === null ? sources.v2?.answered === true : claims.known === true)} />, counts: holdingsCountsV2(holdings) } : null}
    />
  );
}

type ReadState = { readonly status: 'loading' } | { readonly status: 'ready'; readonly read: WalletBoxRead } | { readonly status: 'unavailable'; readonly reason: string };

function ChainWalletBox({ address, own, target, record, readWallet, claims }: { address: Address; own: boolean; target: FitMarketTarget; record: BoxRecord; readWallet?: WalletBoxPageProps['readWallet']; claims: WalletClaims | null }) {
  const summary = useLaunchSummary(record, target, 'curve');
  const reader = useMemo(() => (readWallet ? (account: Address) => readWallet(target, account) : (directReaderFor(target)?.readWallet ?? null)), [target, readWallet]);
  const [loaded, setLoaded] = useState<ReadState>({ status: 'loading' });
  useEffect(() => {
    if (reader === null) return undefined;
    let active = true;
    reader(address).then(
      (value) => {
        if (active) setLoaded({ status: 'ready', read: value });
      },
      (error: unknown) => {
        if (active) setLoaded({ status: 'unavailable', reason: error instanceof Error && error.message ? error.message : 'The wallet could not be read.' });
      },
    );
    return () => {
      active = false;
    };
  }, [address, reader]);
  const read: ReadState = useMemo(() => (reader === null ? { status: 'unavailable', reason: 'This market has no RPC to read the wallet from.' } : loaded), [reader, loaded]);
  const wallet: WalletBox | null = useMemo(() => (read.status === 'ready' ? chainWalletBox(read.read, record, summary.state) : null), [read, record, summary.state]);
  return (
    <WalletBoxView
      wallet={wallet}
      unavailable={read.status === 'unavailable' ? read.reason : null}
      address={address}
      own={own}
      demo={false}
      chainId={target.chainId}
      networkLabel={target.networkLabel}
      claims={claims}
    />
  );
}

export default WalletBoxPage;
