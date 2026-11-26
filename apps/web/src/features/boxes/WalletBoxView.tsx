/**
 * A wallet as a box (BOX-INTERFACE § 4, wallet box): the header (the box shell with the companion's lid slot, which
 * says what goes there for this wallet; chips "Wallet box", the chain, "View only" when it is not yours, Demo), the
 * name ("My Box", or "Wallet" with the address once, on the Copy line), three stats, and the same four slots as a
 * collection box: What's in the box? (grouped by source box), Claims, Companion, About. Revealed items are shown as
 * items (Demo example art, or a stack and the count until the indexer lists ids), never as the sealed box. Read-only: no
 * totals across assets, no USD, an unread value is "Not available", never 0; nothing is signed or sent.
 */
import { boxArt } from '@squarehole/design';
import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { PAGE_TITLE_ID } from '../../pages/page-parts';
import { formatCount, formatTokenShort, shortAddress } from '../fit-pair/fit-format';
import { InfoButton, InfoPanel, useInfoTip } from '../fit-pair/InfoTip';
import { CopyButton } from '../pair/CopyButton';
import { boxPath } from './box-id';
import { BoxCover, ChainChip, LockGlyph, StackGlyph, StateChip, ToyBlock, TokenMark, WalletGlyph, WalletShell } from './BoxParts';
import { ChainItems } from './ChainItems';
import { TEASERS } from './misfits-content';
import { SectionBar, useSectionParam, type Section } from './SectionBar';
import { companionOf, holdsSomething, walletStats, type WalletBox, type WalletHolding } from './wallet-box';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

type WalletTab = 'contents' | 'claims' | 'companion' | 'about';
const SECTIONS: readonly Section<WalletTab>[] = [
  { id: 'contents', label: 'What’s in the box?' },
  { id: 'claims', label: 'Claims' },
  { id: 'companion', label: 'Companion' },
  { id: 'about', label: 'About' },
];

const na = <span className="sh-na">Not available</span>;

function AddressInfo() {
  const tip = useInfoTip();
  return (
    <>
      <InfoButton tip={tip} label="About wallet boxes" />
      <InfoPanel tip={tip}>
        <p>A view of this wallet. Opening it moves nothing and asks for nothing.</p>
      </InfoPanel>
    </>
  );
}

function OtherAssets() {
  const tip = useInfoTip();
  return (
    <div className="sh-box-note">
      <p>
        Other assets not shown <InfoButton tip={tip} label="Why other assets are not shown" />
      </p>
      <InfoPanel tip={tip}>
        <p>Only items and tokens of supported boxes on this data source are shown. Different assets are never added up.</p>
      </InfoPanel>
    </div>
  );
}

function boxLink(holding: WalletHolding): string {
  return DEMO_BUILD && holding.scenario && holding.scenario !== 'curve' && holding.record.demo ? `${boxPath(holding.record.id)}?scenario=${holding.scenario}` : boxPath(holding.record.id);
}

/**
 * Revealed items as items: a Demo wallet's as example art of that box (the Misfits' ordinary examples, Toy Trains' toy
 * blocks), a chain wallet's as a stack with the count (ids need the indexer). Never the sealed box.
 */
function RevealedArt({ holding }: { holding: WalletHolding }) {
  const { record } = holding;
  const shown = holding.revealed === null ? 0 : Number(holding.revealed > 4n ? 4n : holding.revealed);
  if (DEMO_BUILD && record.demo && record.art?.toyBlocks) {
    return (
      <span className="sh-box-wtile__art sh-box-mosaic" data-count={shown}>
        {Array.from({ length: shown }, (_, index) => (
          <ToyBlock key={index} index={index} />
        ))}
      </span>
    );
  }
  if (DEMO_BUILD && record.demo && record.market && !record.rehearsal) {
    return (
      <span className="sh-box-wtile__art sh-box-mosaic" data-count={shown}>
        {TEASERS.slice(0, shown).map((teaser) => {
          const art = boxArt(`m-${teaser.slug}-256`);
          return art ? <img key={teaser.slug} src={art.src} width={art.width} height={art.height} alt="" loading="lazy" decoding="async" /> : null;
        })}
      </span>
    );
  }
  return (
    <span className="sh-box-wtile__art sh-box-wtile__art--stack">
      <StackGlyph size={40} />
    </span>
  );
}

function Holding({ holding }: { holding: WalletHolding }) {
  const { record } = holding;
  const sealedArt = record.art ? boxArt(record.art.sealed) : record.market && !record.rehearsal && !(import.meta.env?.SH_BNB === true) ? boxArt('cover-misfits-256') : null;
  const tiles: ReactNode[] = [];
  if (holding.tokenRaw === null || holding.tokenRaw > 0n) {
    tiles.push(
      <li key="token" className="sh-box-wtile">
        <span className="sh-box-wtile__art sh-box-wtile__art--token">
          <TokenMark record={record} size={40} />
        </span>
        <strong>{holding.tokenRaw === null ? na : formatTokenShort(holding.tokenRaw, record.ticker)}</strong>
        <span>Token</span>
      </li>,
    );
  }
  if (holding.sealed === null || holding.sealed > 0n) {
    tiles.push(
      <li key="sealed" className="sh-box-wtile">
        <span className="sh-box-wtile__art">{sealedArt ? <img src={sealedArt.src} width={96} height={96} alt="" loading="lazy" decoding="async" /> : <LockGlyph />}</span>
        <strong>{holding.sealed === null ? na : `${formatCount(holding.sealed)} sealed`}</strong>
        <span>
          <LockGlyph /> Opens at graduation
        </span>
      </li>,
    );
  }
  if (holding.revealed === null || holding.revealed > 0n) {
    tiles.push(
      <li key="revealed" className="sh-box-wtile">
        <RevealedArt holding={holding} />
        <strong>{holding.revealed === null ? na : `${formatCount(holding.revealed)} ${record.itemNoun}`}</strong>
        <span>{DEMO_BUILD && holding.record.demo ? 'Example art' : holding.itemIds && holding.itemIds.length > 0 ? holding.itemIds.slice(0, 6).map((id) => `#${id}`).join(' ') : 'Ids load from the indexer'}</span>
      </li>,
    );
  }
  if (holding.streamOwed !== undefined && holding.streamOwed !== null && holding.streamOwed > 0n) {
    tiles.push(
      <li key="stream" className="sh-box-wtile">
        <span className="sh-box-wtile__art sh-box-wtile__art--token">
          <TokenMark record={record} size={40} />
        </span>
        <strong>{formatTokenShort(holding.streamOwed, record.ticker)}</strong>
        <span>{`Per-${record.itemNoun.replace(/s$/, '')} share owed`}</span>
      </li>,
    );
  }
  return (
    <section className="sh-box-card-block sh-box-holding" aria-label={record.name}>
      <div className="sh-box-block-head">
        <h3>{record.name}</h3>
        <StateChip state={holding.state} />
        <Link to={boxLink(holding)} className="sh-box-holding__open">
          Open box
        </Link>
      </div>
      <ul className="sh-box-wtiles">{tiles}</ul>
      {!(DEMO_BUILD && record.demo) && record.row && holding.itemIds?.length ? <ChainItems record={record} ids={holding.itemIds.map(String)} /> : null}
    </section>
  );
}

/** Boxes this wallet created (OpenSea profile's "Created"): each links to its box page. */
function CreatedBoxes({ boxes }: { boxes: readonly WalletBox['created'][number][] }) {
  if (boxes.length === 0) return null;
  return (
    <section className="sh-box-card-block sh-box-created" aria-labelledby="wallet-created-title">
      <div className="sh-box-block-head">
        <h3 id="wallet-created-title">Created</h3>
        <span className="sh-muted">{`${boxes.length} ${boxes.length === 1 ? 'box' : 'boxes'}`}</span>
      </div>
      <ul className="sh-box-created__list">
        {boxes.map((record) => (
          <li key={record.id}>
            <Link to={boxPath(record.id)} className="sh-box-created__link" aria-label={`${record.name}, ${record.ticker}, ${record.kind === 'token' ? 'Token' : `${formatCount(record.itemCount)} ${record.itemNoun}`}`}>
              <BoxCover record={record} small className="sh-box-created__cover" />
              <span className="sh-box-created__name">{record.name}</span>
              <StateChip state={DEMO_BUILD ? record.demoState : null} />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export interface WalletBoxViewProps {
  readonly wallet: WalletBox | null;
  /** Why the wallet could not be read (chain sources). */
  readonly unavailable: string | null;
  readonly address: string;
  readonly own: boolean;
  readonly demo: boolean;
  readonly chainId: number;
  readonly networkLabel: string;
  /** The wallet is read on a local chain (the core twin carries Sepolia's chain id). */
  readonly local?: boolean;
  /** F128 on a chain source: the Claims tab (one Claim all for every claim) and the header's "Claims ready". */
  readonly claims?: { readonly lead: string; readonly ready: ReactNode; readonly panel: ReactNode } | null;
  /**
   * SH-291: the current box generation's holdings (core/v2/HoldingsV2.tsx) in place of the first generation's contents,
   * with the header's counts (null while unknown).
   */
  readonly holdings?: { readonly contents: ReactNode; readonly counts: { readonly boxes: number; readonly items: number } | null } | null;
}

export function WalletBoxView({ wallet, unavailable, address, own, demo, chainId, networkLabel, local = false, claims = null, holdings = null }: WalletBoxViewProps) {
  const [tab, setTab] = useSectionParam(SECTIONS);
  // Arriving from "Box created" (its My Box link): the boxes this wallet created come first, not two screens down.
  const createdFirst = (useLocation().state as { createdFirst?: boolean } | null)?.createdFirst === true;
  // SH-258 round 3b: holdings not read here (no core v1 on BNB) are unknown counts, never zeros.
  const stats = wallet && wallet.holdingsRead !== false ? walletStats(wallet) : null;
  const held = wallet?.holdings.filter(holdsSomething) ?? [];
  // SH-291: the v2 holdings say nothing of a companion: the slot says none is chosen (never "Empty" beside held coins).
  const companion = holdings ? { slot: 'No companion yet', lead: 'No companion selected', line: 'Choosing a companion is not in this app yet.' } : companionOf(wallet, own);
  const panels: Record<WalletTab, ReactNode> = {
    contents: holdings ? (
      <div className="sh-box-contents">
        {holdings.contents}
        {createdFirst ? <CreatedBoxes boxes={wallet?.created ?? []} /> : null}
      </div>
    ) : (
      <div className="sh-box-contents">
        <div className="sh-box-lead">
          <h2>{wallet === null ? (unavailable ? 'Not available' : 'Reading the wallet…') : wallet.holdingsRead === false ? 'Box inventory not read on this page' : held.length === 0 ? (wallet.created.length > 0 ? 'Nothing held yet' : 'Nothing from supported boxes') : `From ${held.length} ${held.length === 1 ? 'box' : 'boxes'}`}</h2>
        </div>
        {unavailable ? <p className="sh-box-notice" data-disclosure="">{`Unavailable: ${unavailable}`}</p> : null}
        {createdFirst ? <CreatedBoxes boxes={wallet?.created ?? []} /> : null}
        {held.map((holding) => (
          <Holding key={holding.record.id} holding={holding} />
        ))}
        {createdFirst ? null : <CreatedBoxes boxes={wallet?.created ?? []} />}
        <OtherAssets />
      </div>
    ),
    claims: claims ? (
      <div className="sh-box-contents">
        <div className="sh-box-lead">
          <h2>{claims.lead}</h2>
        </div>
        {claims.panel}
      </div>
    ) : (
      <div className="sh-box-contents">
        <div className="sh-box-lead">
          <h2>Nothing yet</h2>
        </div>
        <p className="sh-muted">Claims are not built yet.</p>
      </div>
    ),
    companion: (
      <div className="sh-box-contents">
        <div className="sh-box-lead">
          <h2>{companion.lead}</h2>
        </div>
        <p className="sh-muted">{companion.line}</p>
      </div>
    ),
    about: (
      <div className="sh-box-about">
        <h2 className="sh-box-about__line">A view of this wallet. Opening it moves nothing.</h2>
        <dl className="sh-box-kv">
          <div>
            <dt>Address</dt>
            <dd className="sh-box-kv__address">
              <code>{address}</code>
            </dd>
          </div>
          <div>
            <dt>Chain</dt>
            <dd>{networkLabel}</dd>
          </div>
          <div>
            <dt>Shows</dt>
            <dd>Items and tokens of supported boxes</dd>
          </div>
          <div>
            <dt>Totals</dt>
            <dd>None. Different assets are never added up.</dd>
          </div>
        </dl>
      </div>
    ),
  };
  return (
    <>
      <header className="sh-box-head sh-box-head--wallet">
        <div className="sh-box-head__visual">
          <div className="sh-box-head__cover sh-box-head__cover--wallet">
            <WalletShell slot={companion.slot} />
          </div>
        </div>
        <div className="sh-box-head__id">
          <p className="sh-box-head__chips">
            <span className="sh-box-kind">
              <WalletGlyph />
              Wallet box
            </span>
            <ChainChip record={{ chainId, demo, networkLabel, local }} />
            {own ? null : <span className="sh-box-kind">View only</span>}
          </p>
          <h1 id={PAGE_TITLE_ID} className="sh-page__title sh-box-head__title" tabIndex={-1}>
            {own ? 'My Box' : 'Wallet'}
          </h1>
          <div className="sh-fit-ca sh-fit-ca--compact">
            <code className="sh-fit-ca__short" title={address}>
              {shortAddress(address)}
            </code>
            <CopyButton value={address} label="Copy the wallet address" />
            <AddressInfo />
          </div>
          {wallet?.snapshot ? <p className="sh-box-phase">{wallet.snapshot}</p> : null}
          {wallet?.block != null ? <p className="sh-box-phase">{`Chain read · block ${formatCount(wallet.block)}`}</p> : null}
        </div>
        <dl className="sh-box-stats sh-box-stats--three">
          <div className="sh-box-stat">
            <dt>Boxes</dt>
            <dd>{holdings ? (holdings.counts ? formatCount(BigInt(holdings.counts.boxes)) : na) : stats === null ? na : formatCount(BigInt(stats.boxes))}</dd>
          </div>
          <div className="sh-box-stat">
            <dt>Items</dt>
            <dd>{holdings ? (holdings.counts ? formatCount(BigInt(holdings.counts.items)) : na) : stats?.items == null ? na : formatCount(stats.items)}</dd>
          </div>
          <div className="sh-box-stat">
            <dt>Claims ready</dt>
            <dd>{claims ? claims.ready : <span className="sh-na">Not built yet</span>}</dd>
          </div>
        </dl>
      </header>
      <SectionBar sections={SECTIONS} selected={tab} onSelect={setTab} label="Wallet sections" idPrefix="wallet">
        {panels[tab]}
      </SectionBar>
    </>
  );
}
