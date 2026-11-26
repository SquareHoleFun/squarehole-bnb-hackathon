/**
 * SH-289: the launches on Flap and Four.meme among the boxes, on the Boxes page of the BNB Chain testnet build. The
 * founder: "We are adding a new dimension to their launchpads - the box dimension."
 *
 * - One card per launch, in the look of a box card: the plain cover with a badge naming the rail, name and symbol, its
 *   state in the launch page's own words, one short line of its rules; it leads to the launch's own page.
 * - Read when the rail is selected or the boxes have answered (`ready`), the launch page's way (launch-reads.ts), at most two reads at a
 *   time, kept for the visit. Meanwhile a quiet line; a failed read says so once, with "Try again".
 * - Its own component and error boundary: nothing here can delay or break the boxes.
 * - Under "All", found by name or symbol. Each rail also has its own view. Box counts always count boxes.
 * - Any other network shows nothing; a mainnet build (production, not a test network) folds the export to `NoCards`,
 *   so none of this (words, reads, ABIs) reaches it.
 */
import { Component, useEffect, useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { TESTNET } from '@squarehole/chain/write/wallet';
import { BoxGlyph } from '../boxes/BoxParts';
import { arweavePicture } from '../pictures/arweave-read';
import { loadLaunchCards, type LaunchCardData, type LaunchRail } from './launch-reads';
import type { LaunchPictureRef } from './launch-picture';

/**
 * SH-294: the launch's picture as its cover, read the platform's way (arweave-read.ts `arweavePicture`: the link's item
 * only, no search; the withheld list; raster only; checked against the hash). No picture, a withheld one or a failed
 * read: the plain cover, silently.
 */
function useLaunchPicture(ref: LaunchPictureRef | null): string | null {
  const read = useQuery({
    queryKey: ['sh-294', 'launch-picture', ref?.sha256 ?? '', ref?.id ?? ''],
    queryFn: async () => {
      if (!ref) return null;
      const found = await arweavePicture(`0x${ref.sha256}`, { hint: ref.id, search: false });
      return found !== null && 'bytes' in found ? found : null;
    },
    enabled: ref !== null,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const picture = read.data ?? null;
  const url = useMemo(() => (picture ? URL.createObjectURL(new Blob([new Uint8Array(picture.bytes)], { type: picture.type })) : null), [picture]);
  // The blob: URL lives as long as it is shown.
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  return url;
}

function Cover({ card }: { card: LaunchCardData }) {
  const url = useLaunchPicture(card.picture);
  return url
    ? <span className="sh-box-cover" data-art="image" data-slot="card" data-launch-picture=""><img src={url} alt="" /></span>
    : <span className="sh-box-cover" data-art="plain" data-slot="card"><BoxGlyph /></span>;
}

export interface LaunchCardsProps {
  /** A single rail on its own tab, or both under the boxes. */
  readonly rail?: LaunchRail;
  /** Read immediately on a rail, or once the boxes have answered in the combined feed. */
  readonly ready: boolean;
  /** The feed's search: a launch shows when its name or symbol holds it. */
  readonly query: string;
  /** The build's test network (tests pass both). */
  readonly network?: string;
  /** The read (tests pass their own). */
  readonly load?: () => Promise<LaunchCardData[]>;
}

const WORDS = { reading: 'Reading the launches…', failed: 'Could not read the launches.', retry: 'Try again', list: 'Launches', rail: { flap: 'Flap', four: 'Four.meme' } } as const;
const QUERY_KEY = ['sh-289', 'launch-cards'] as const;

function Card({ card }: { card: LaunchCardData }) {
  const rail = WORDS.rail[card.rail];
  return (
    <li className="sh-box-card" data-launch-card={card.rail}>
      <a href={card.href} className="sh-box-card__link" aria-label={`${card.name}, ${card.symbol}, ${rail}`}>
        <span className="sh-box-card__cover">
          <Cover card={card} />
          <span className="sh-box-state sh-box-card__state" data-launch-rail={card.rail}>{rail}</span>
        </span>
        <span className="sh-box-card__body">
          <span className="sh-box-card__name">{card.name}</span>
          <span className="sh-box-card__ticker">{card.symbol}</span>
          <span className="sh-box-card__figure">{card.state}</span>
          {card.rules ? <span className="sh-box-card__meta">{card.rules}</span> : null}
        </span>
      </a>
    </li>
  );
}

function Failed({ retry }: { retry: () => void }) {
  return (
    <div className="sh-panel sh-part-failed" data-launch-cards="failed">
      <p role="status">{WORDS.failed}</p>
      <button type="button" className="sh-button" onClick={retry}>{WORDS.retry}</button>
    </div>
  );
}

function CardsRead({ ready, query, load, rail }: LaunchCardsProps) {
  const read = useQuery({
    queryKey: QUERY_KEY,
    queryFn: load ?? (() => loadLaunchCards(TESTNET.publicRpcUrls)),
    enabled: ready,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
  });
  if (read.isError) return <Failed retry={() => { void read.refetch(); }} />;
  if (!ready || read.data === undefined) return <p className="sh-muted" role="status" data-launch-cards="reading">{WORDS.reading}</p>;
  const q = query.trim().toLowerCase();
  const cards = read.data.filter((card) => (!rail || card.rail === rail)
    && (!q || card.name.toLowerCase().includes(q) || card.symbol.toLowerCase().includes(q)));
  if (cards.length === 0) return rail ? <div className="sh-panel sh-box-empty"><p role="status">No launches yet</p></div> : null;
  return (
    <ul className="sh-box-grid" aria-label={WORDS.list} data-launch-cards="shown">
      {cards.map((card) => <Card key={`${card.rail}:${card.address}`} card={card} />)}
    </ul>
  );
}

/** Whatever goes wrong in the cards stays in the cards: the failure line, with "Try again" starting them over. */
class CardsBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  override render(): ReactNode {
    return this.state.failed ? <Failed retry={() => this.setState({ failed: false })} /> : this.props.children;
  }
}

function Cards(props: LaunchCardsProps) {
  if ((props.network ?? TESTNET.name) !== 'bnb') return null;
  return <CardsBoundary><CardsRead {...props} /></CardsBoundary>;
}

function NoCards(): null { return null; }

/** A mainnet build (production and not a test network) folds this to nothing. */
export const LaunchCards: (props: LaunchCardsProps) => ReactNode = import.meta.env?.SH_PRODUCTION === true && import.meta.env?.SH_TEST_NETWORK !== true ? NoCards : Cards;
