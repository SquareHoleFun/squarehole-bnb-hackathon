/**
 * Feed cards (BOX-INTERFACE § 3): one card shape for every box, one figure, the state as a chip, and the words that are
 * never hidden ("Stale · since block B" or "Unverified" when the live data is not current, § 8; no Demo label since F130).
 * A card is one link to the box page; its accessible name says everything the card shows, the network included. The
 * Misfits launch is a wide card pinned first ("Featured", platform placement) with its families' ordinary avatars,
 * cropped to the character; a rehearsal is a normal card. A wallet found by the search is a card of the same shape: the
 * wallet's box shell, what it holds, "View only". A token box says "Token" (with a coin) where others
 * count items. A collection page's banner (F71 (2)) is for the box page only: every card keeps the same cover and body,
 * so a row of cards lines up.
 */
import { Link } from 'react-router';
import { formatCount, shortAddress } from '../fit-pair/fit-format';
import { walletPath } from './box-id';
import { KIND_LABELS, rehearsalShown, STATE_LABELS, type BoxSummary } from './box-model';
import { BoxCover, Bar, CoinGlyph, CoverTape, EthGlyph, FamilyAvatar, StateChip, TokenMark, WalletShell } from './BoxParts';
import { compositionFor } from './misfits-content';
import { headerSlot } from './picture-slot';
import { demoData } from '../../build-mode';
import { nativePriced } from './box-feed';
import { TESTNET } from '../data-source/testnet';
import { SparkV2 } from '../core/v2/StatsV2';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

export interface CardLinkProps {
  readonly summary: BoxSummary;
  /** Where the card goes (`/box/<id>`, with the Demo scenario when one is chosen). */
  readonly to: string;
}

/** "120 items", or nothing for a token box (its kind already says "Token"). */
export const itemsText = (record: BoxSummary['record']): string | null => (record.kind === 'token' ? null : `${formatCount(record.itemCount)} ${record.itemNoun}`);

function cardLabel({ record, state, figure, notice, cells }: BoxSummary): string {
  const parts = [record.name, record.ticker, KIND_LABELS[record.kind], state ? STATE_LABELS[state] : 'Unavailable', figure.text];
  if (notice) parts.push(notice);
  // SH-TA-12, SH-TA-29: a chain box's short numbers, as its card shows them.
  const stats = cellsLabel(cells);
  if (stats) parts.push(stats);
  const items = itemsText(record);
  if (items) parts.push(items);
  parts.push(record.networkLabel);
  if (record.featured) parts.push('Featured');
  if (rehearsalShown(record)) parts.push('Rehearsal, test set');
  return parts.join(', ');
}

const CELL_WORDS: Readonly<Record<string, string>> = { Mcap: 'Market cap', '24h': '24h volume' };

/** The cells in words, for the card's accessible name ("Price 0.0042, Burned 2.56M, …"). */
function cellsLabel(cells: BoxSummary['cells']): string | null {
  if (!cells || cells.length === 0) return null;
  return cells.map(([label, value]) => `${CELL_WORDS[label] ?? label} ${value === '—' ? 'not available' : value}`).join(', ');
}

/** A chain box's short numbers under its figure, and a v2 box's price line (decoration: the name says the numbers). */
function Cells({ summary }: { summary: BoxSummary }) {
  if (!summary.cells || summary.cells.length === 0) return null;
  return (
    <span className="sh-v2-card-stats">
      {summary.cells.map(([label, value]) => (
        <span key={label} className="sh-v2-card-stats__cell">
          <span className="sh-v2-card-stats__label">{label}</span>
          <span className="sh-v2-card-stats__value">{value}</span>
        </span>
      ))}
      {summary.spark ? <SparkV2 candles={summary.spark} /> : null}
    </span>
  );
}

function Figure({ summary }: { summary: BoxSummary }) {
  return (
    <>
      <span className="sh-box-card__figure">{summary.figure.text}</span>
      {summary.figure.barBps !== null ? <Bar bps={summary.figure.barBps} /> : null}
      {summary.notice ? (
        <span className="sh-box-card__notice" data-disclosure="">
          {summary.notice}
        </span>
      ) : null}
    </>
  );
}

function Cover({ summary, tape }: { summary: BoxSummary; tape?: string }) {
  const { record, state } = summary;
  const label = tape ?? null;
  return (
    <span className="sh-box-card__cover">
      <BoxCover record={record} small />
      <StateChip state={state} className="sh-box-card__state" />
      <span className="sh-box-card__chain" title={record.networkLabel}>
        <EthGlyph />
      </span>
      {label ? <CoverTape label={label} /> : null}
    </span>
  );
}

export interface BoxCardProps extends CardLinkProps {
  /**
   * A preview of a box not created yet (the creation page): the same card, not a link, with the tape it carries
   * ("Preview"); its accessible name says it is a preview.
   */
  readonly preview?: { readonly tape: string };
}

export function BoxCard({ summary, to, preview }: BoxCardProps) {
  const { record } = summary;
  const body = (
    <>
      <Cover summary={summary} tape={preview?.tape} />
      <span className="sh-box-card__body">
        <span className="sh-box-card__name">{record.name}</span>
        <span className="sh-box-card__ticker">
          <TokenMark record={record} size={16} />
          {record.ticker}
          {/* The native coin is not named on its card ("· ETH" never was; "· BNB" on BNB Chain testnet, SH-258), told by
              the price coin's address (the zero address), never by its symbol (round 3). */}
          {/* Sepolia keeps its rule by symbol (parity, round 3b). */}
          {!(TESTNET.name === 'sepolia' ? record.pairAsset === 'ETH' : nativePriced(record)) ? <span className="sh-box-card__pair"> · {record.pairAsset}</span> : null}
        </span>
        <Figure summary={summary} />
        <Cells summary={summary} />
        <span className="sh-box-card__meta">
          {record.kind === 'token' ? <CoinGlyph size={12} /> : null}
          {itemsText(record) ?? KIND_LABELS.token}
          {rehearsalShown(record) ? <span className="sh-box-card__rehearsal"> · Rehearsal · test set</span> : null}
        </span>
      </span>
    </>
  );
  return (
    <li className="sh-box-card" data-state={summary.state ?? 'unavailable'} {...demoData(record.demo)}>
      {preview ? (
        <div className="sh-box-card__link" role="group" aria-label={`Preview: ${cardLabel(summary)}${DEMO_BUILD && record.demo ? '' : `, ${preview.tape}`}`}>
          {body}
        </div>
      ) : (
        <Link to={to} className="sh-box-card__link" aria-label={cardLabel(summary)}>
          {body}
        </Link>
      )}
    </li>
  );
}

/** The wide first card for the Misfits launch, with "What's in the box?" and the families' ordinary avatars. */
export function FeaturedBoxCard({ summary, to }: CardLinkProps) {
  const { record } = summary;
  const composition = compositionFor(record.itemCount);
  const avatars = (composition?.families ?? []).filter((row) => row.avatar !== null);
  return (
    <li className="sh-box-card sh-box-card--featured" data-state={summary.state ?? 'unavailable'} {...demoData(record.demo)}>
      <Link to={to} className="sh-box-card__link" aria-label={cardLabel(summary)}>
        <Cover summary={summary} />
        <span className="sh-box-card__body">
          <span className="sh-box-featured">Featured</span>
          <span className="sh-box-card__name">{record.name}</span>
          <span className="sh-box-card__ticker">
            <TokenMark record={record} size={16} />
            {record.ticker}
          </span>
          <Figure summary={summary} />
          <Cells summary={summary} />
          <span className="sh-box-card__meta">{`${formatCount(record.itemCount)} ${record.itemNoun}`}</span>
          {avatars.length > 0 ? (
            <span className="sh-box-card__avatars" aria-hidden="true">
              {avatars.map((row) => (
                <FamilyAvatar key={row.id} row={row} />
              ))}
            </span>
          ) : null}
        </span>
      </Link>
    </li>
  );
}

/** The List view: one row per box (a table, so the columns are read with their headers). */
export function BoxTable({ rows }: { rows: readonly CardLinkProps[] }) {
  return (
    <div className="sh-box-table-wrap">
      <table className="sh-box-table">
        <caption className="sh-visually-hidden">Boxes</caption>
        <thead>
          <tr>
            <th scope="col">Box</th>
            <th scope="col">State</th>
            <th scope="col">Now</th>
            <th scope="col">Items</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ summary, to }) => (
            <tr key={summary.record.id} {...demoData(summary.record.demo)}>
              <th scope="row">
                <Link to={to} className="sh-box-table__box" aria-label={cardLabel(summary)}>
                  {/* SH-223: the Genesis box's thumbnail is its box picture, every other box's its logo (picture-slot.ts). */}
                  <BoxCover record={summary.record} small slot={headerSlot(summary.record)} className="sh-box-table__thumb" />
                  <span>
                    {summary.record.name}
                    <small>
                      {summary.record.ticker}
                      {summary.record.featured ? ' · Featured' : ''}
                      {rehearsalShown(summary.record) ? ' · Rehearsal' : ''}
                    </small>
                  </span>
                </Link>
              </th>
              <td>
                <StateChip state={summary.state} />
              </td>
              <td>
                {summary.figure.text}
                {summary.notice ? (
                  <span className="sh-box-card__notice" data-disclosure="">
                    {summary.notice}
                  </span>
                ) : null}
              </td>
              <td>{summary.record.kind === 'token' ? <span className="sh-muted">None</span> : formatCount(summary.record.itemCount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** What a wallet found by the search holds, when the source can say it without a read (Demo); else null. */
export interface WalletCardFacts {
  readonly items: bigint | null;
  readonly boxes: number;
}

/** A wallet found by the search, as a box-shaped card: its box shell, what it holds, "View only". */
export function WalletCard({ address, facts, demo }: { address: string; facts: WalletCardFacts | null; demo: boolean }) {
  const held = facts === null ? null : `${formatCount(facts.items ?? 0n)} ${facts.items === 1n ? 'item' : 'items'} from ${facts.boxes} ${facts.boxes === 1 ? 'box' : 'boxes'}`;
  const name = `Wallet ${shortAddress(address)}`;
  return (
    <li className="sh-box-card sh-box-card--wallet" {...demoData(demo)}>
      <Link to={walletPath(address)} className="sh-box-card__link" aria-label={[name, held, 'View only'].filter(Boolean).join(', ')}>
        <span className="sh-box-card__cover">
          <WalletShell slot={null} small />
        </span>
        <span className="sh-box-card__body">
          <span className="sh-box-card__name">{name}</span>
          <span className="sh-box-card__figure">{held ?? 'Open to read what it holds'}</span>
          <span className="sh-box-card__meta">View only</span>
        </span>
      </Link>
    </li>
  );
}
