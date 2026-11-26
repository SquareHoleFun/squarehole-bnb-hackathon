/**
 * The right-hand side of the box header (the approved mock-up's `.bh-strip` and `.bh-own`):
 *
 * - the peek strip: four small pictures and the count of the rest ("+4,265 · Sneak peek"); a tap opens "What's in the
 *   box?". The Misfits show four ordinary examples (F45 (2) "spoil a few Misfits"; F47 never a rare one), Toy Trains
 *   four of its Demo toy blocks, hidden art with teasers its teasers in dashed frames, "Teasers · not items" (F71 (2):
 *   never items), a box with no preview its sealed box and its count ("50 · Sealed"), a token-only box one tile: its
 *   logo and "Token" (F70 "Nothing", a launch in its own right, not an empty collection);
 * - "Owning one": what owning an item means, as four icons with a few words each (the full tiles are under the tab);
 *   none for a token-only box (no items to own).
 */
import { boxArt } from '@squarehole/design';
import type { ReactNode } from 'react';
import { formatCount } from '../fit-pair/fit-format';
import type { BoxRecord, BoxState } from './box-model';
import { BoxGlyph, ClaimGlyph, InGlyph, LockGlyph, OutGlyph, TokenMark, ToyBlock, UserGlyph } from './BoxParts';
import { TEASERS } from './misfits-content';
import { SealedPicture } from './SealedPicture';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

const THUMBS = 4;

export interface PeekStripProps {
  readonly record: BoxRecord;
  readonly state: BoxState | null;
  /** N, from the data. */
  readonly size: bigint;
  /** The launch's own names (a rehearsal shows no art and no teasers). */
  readonly launchContent: boolean;
  readonly onOpen: () => void;
}

/** The sealed box: its spec's hidden picture (SealedPicture.tsx: checked against our withheld list), else its art. */
function sealedThumb(record: BoxRecord): ReactNode {
  const art = record.art ? boxArt(record.art.sealed) : null;
  const fallback = art ? <img src={art.src} width={art.width} height={art.height} alt="" loading="lazy" decoding="async" /> : <BoxGlyph />;
  return <SealedPicture record={record} size={96} tileClassName="sh-withheld--fill" fallback={fallback} />;
}

export function PeekStrip({ record, state, size, launchContent, onOpen }: PeekStripProps) {
  let thumbs: ReactNode[];
  let count: string;
  let label: string;
  let heard: string;
  let kind: 'peek' | 'examples' | 'sealed' | 'teasers' | 'token';
  const teasers = record.spec?.teaserUrls ?? [];
  if (record.kind === 'token') {
    kind = 'token';
    thumbs = [<TokenMark key="token" record={record} size={40} />];
    count = 'Token';
    label = 'No NFTs · no vault';
    heard = `Token: ${record.ticker}, no NFTs, no vault. Opens What’s in the box?`;
  } else if (launchContent) {
    kind = 'peek';
    thumbs = TEASERS.slice(0, THUMBS).map((teaser) => {
      const art = boxArt(`m-${teaser.slug}-256`);
      return art ? <img key={teaser.slug} src={art.src} width={art.width} height={art.height} alt="" loading="lazy" decoding="async" /> : null;
    });
    count = `+${formatCount(size > BigInt(THUMBS) ? size - BigInt(THUMBS) : 0n)}`;
    label = state === 'graduated' ? 'Examples' : 'Sneak peek';
    heard = `${label}: four examples of ${formatCount(size)} ${record.itemNoun}. Opens What’s in the box?`;
  } else if (DEMO_BUILD && record.art?.toyBlocks) {
    kind = 'examples';
    thumbs = Array.from({ length: THUMBS }, (_, index) => <ToyBlock key={index} index={index} />);
    count = `+${formatCount(size > BigInt(THUMBS) ? size - BigInt(THUMBS) : 0n)}`;
    label = 'Examples';
    heard = `Examples: four of ${formatCount(size)} ${record.itemNoun}, example art. Opens What’s in the box?`;
  } else if (record.spec && record.spec.artMode === 'hidden' && teasers.length > 0) {
    // Hidden art with teasers (F71 (2)): the teasers, labelled, never counted as items.
    kind = 'teasers';
    const shown = teasers.slice(0, THUMBS);
    thumbs = shown.map((url, index) => <img key={index} src={url} width={96} height={96} alt="" loading="lazy" decoding="async" />);
    // The teasers are counted as teasers, never as items (the stats row has the items).
    count = formatCount(BigInt(shown.length));
    label = `${shown.length === 1 ? 'Teaser' : 'Teasers'} · not items`;
    heard = `${shown.length} ${shown.length === 1 ? 'teaser' : 'teasers'}, not items; ${formatCount(size)} ${record.itemNoun} sealed. Opens What’s in the box?`;
  } else if (record.spec && record.spec.artMode === 'open' && record.spec.thumbs.length > 0) {
    // Open art (a box built from its BoxSpec): its own pictures, shown through <img> only.
    kind = 'examples';
    const shown = record.spec.thumbs.slice(0, THUMBS);
    thumbs = shown.map((url, index) => <img key={index} src={url} width={96} height={96} alt="" loading="lazy" decoding="async" />);
    count = `+${formatCount(size > BigInt(shown.length) ? size - BigInt(shown.length) : 0n)}`;
    label = 'Open art';
    heard = `Open art: ${shown.length} of ${formatCount(size)} ${record.itemNoun}. Opens What’s in the box?`;
  } else {
    // No preview shared (the header's line says so): the sealed box and the count.
    kind = 'sealed';
    thumbs = [<span key="sealed">{sealedThumb(record)}</span>];
    count = formatCount(size);
    label = record.rehearsal ? 'Test set' : record.kind === 'existing' ? 'Held' : 'Sealed';
    heard = `${count} ${record.itemNoun}, ${label.toLowerCase()}. Opens What’s in the box?`;
  }
  return (
    <button type="button" className="sh-box-peekstrip" data-kind={kind} aria-label={heard} onClick={onOpen}>
      {thumbs.map((thumb, index) => (
        <span key={index} className="sh-box-peekstrip__thumb">
          {thumb}
        </span>
      ))}
      <span className="sh-box-peekstrip__text" aria-hidden="true">
        <strong>{count}</strong>
        <small>{label}</small>
      </span>
    </button>
  );
}

export interface OwnItem {
  readonly icon: ReactNode;
  readonly text: string;
  /** Not part of this box's set-up (shown muted). */
  readonly off?: boolean;
}

/** Where a spec box's fees go, in three or four words ("Fees to the creator", "Fees burn FIT"). */
function feeWords(record: BoxRecord): string {
  const sides = [record.spec?.buyers, record.spec?.sellers];
  if (sides.some((side) => side?.kind === 'creator')) return 'Fees to the creator';
  if (sides.some((side) => side?.kind === 'holders')) return 'Fees to holders';
  if (sides.some((side) => side?.kind === 'burn' && side.token === 'FIT')) return 'Fees burn FIT';
  // The box's own ticker: shorter than "the token", so the tile keeps one line beside its icon (SH-V2-FE3).
  return `Fees burn ${record.ticker}`;
}

/** What owning an item means, in a few words each (the mock-up's `ownItems`): the same four as the tab's tiles. */
export function ownItems(record: BoxRecord, state: BoxState | null): OwnItem[] {
  if (record.kind === 'token') {
    // A token box: nothing to take out or put back; the fees say where they go.
    return [
      { icon: <OutGlyph />, text: 'No items', off: true },
      { icon: <ClaimGlyph />, text: feeWords(record), off: true },
    ];
  }
  const items: OwnItem[] = [
    { icon: <OutGlyph />, text: record.kind === 'existing' ? 'Pick one out' : 'Take one out' },
    { icon: <InGlyph />, text: 'Put it back' },
  ];
  if (record.claims === 'per-item') items.push({ icon: <ClaimGlyph />, text: 'Claims while outside' });
  else if (record.claims === 'holders') items.push({ icon: <ClaimGlyph />, text: 'Holder claims' });
  else items.push({ icon: <ClaimGlyph />, text: feeWords(record), off: true });
  if (record.market && !record.rehearsal) items.push({ icon: <UserGlyph />, text: 'Your companion' });
  else if (record.kind === 'existing') items.push({ icon: <LockGlyph />, text: 'Original NFTs' });
  else if (record.spec?.artMode === 'open') items.push({ icon: <LockGlyph />, text: state === 'graduated' ? 'Shows in My Box' : 'Art shown now' });
  else items.push({ icon: <LockGlyph />, text: state === 'graduated' ? 'Shows in My Box' : 'Placeholder first' });
  return items;
}

export function OwnRow({ record, state, onOpen }: { record: BoxRecord; state: BoxState | null; onOpen: () => void }) {
  // A token box: nothing to take out or put back (the Owning one tab still says so).
  if (record.kind === 'token') return null;
  return (
    <div className="sh-box-own">
      <button type="button" className="sh-box-own__label" onClick={onOpen}>
        Owning one
      </button>
      <ul className="sh-box-own__row">
        {ownItems(record, state).map((item) => (
          <li key={item.text} data-off={item.off ? '' : undefined}>
            <span className="sh-box-own__icon">{item.icon}</span>
            {item.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
