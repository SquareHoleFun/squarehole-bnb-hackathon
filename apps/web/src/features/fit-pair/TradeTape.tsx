import { fitExplorerHref } from '@squarehole/links';
import { useState } from 'react';
import { blocks as blockCount, formatAgo, formatBlock, formatEth, formatToken, formatUtc, isoTime, shortAddress } from './fit-format';
import type { FitMarketTarget } from './fit-target';
import { InfoButton, InfoPanel, useInfoTip } from './InfoTip';
import { tierOfBlock, type LiveData, type LiveTrade } from './live-model';


/** More trades than this in one block fold into one row ("7 buys · 1 sell", VL-5). */
export const FOLD_ABOVE = 3;
/** Rows shown before "Show all". */
export const TAPE_ROWS = 10;

export type TapeRow =
  | { readonly kind: 'trade'; readonly trade: LiveTrade }
  | {
      readonly kind: 'folded';
      readonly block: bigint;
      readonly timestamp: bigint;
      readonly buys: number;
      readonly sells: number;
      /** ETH into the pool (tax excluded), as on a single row. */
      readonly ethIn: bigint;
      /** Launch-window tax on those buys, shown apart, as on a single row. */
      readonly taxIn: bigint;
      readonly ethOut: bigint;
      readonly id: string;
    };

/**
 * Newest first; a block with more than `FOLD_ABOVE` trades becomes one row with its counts and ETH totals. ETH is
 * always what went into or out of the pool; the launch tax is always shown apart, on a single row and a folded one.
 */
export function tapeRows(trades: readonly LiveTrade[]): TapeRow[] {
  const rows: TapeRow[] = [];
  let i = 0;
  while (i < trades.length) {
    const first = trades[i];
    if (first === undefined) break;
    let j = i;
    while (j < trades.length && trades[j]?.block === first.block) j += 1;
    const group = trades.slice(i, j);
    if (group.length > FOLD_ABOVE) {
      const buys = group.filter((trade) => trade.side === 'buy');
      rows.push({
        kind: 'folded',
        block: first.block,
        timestamp: first.timestamp,
        buys: buys.length,
        sells: group.length - buys.length,
        ethIn: buys.reduce((sum, trade) => sum + trade.ethRaw, 0n),
        taxIn: buys.reduce((sum, trade) => sum + trade.taxRaw, 0n),
        ethOut: group.filter((trade) => trade.side === 'sell').reduce((sum, trade) => sum + trade.ethRaw, 0n),
        id: `${first.blockHash}:folded`,
      });
    } else {
      rows.push(...group.map((trade) => ({ kind: 'trade' as const, trade })));
    }
    i = j;
  }
  return rows;
}

const TIER_TEXT = { head: 'not final', confirmed: 'confirmed', safe: 'safe', finalized: 'final' } as const;

/**
 * A trade's finality, shown only when it is news: "not final" (dashed) for the newest blocks. Confirmed, safe and final
 * rows show nothing and say their tier to screen readers only.
 */
function Tier({ block, data }: { block: bigint; data: LiveData }) {
  const tier = tierOfBlock(block, data);
  return tier === 'head' ? (
    <span className="sh-fit-tier" data-tier={tier}>
      {TIER_TEXT[tier]}
    </span>
  ) : (
    <span className="sh-visually-hidden" data-tier={tier}>
      , {TIER_TEXT[tier]}
    </span>
  );
}

/** "4 min ago", counted from the newest block; the exact UTC time in the title and for screen readers. */
function When({ block, timestamp, data }: { block: bigint; timestamp: bigint; data: LiveData }) {
  const utc = formatUtc(timestamp);
  return (
    <span className="sh-fit-tape__when">
      <time dateTime={isoTime(timestamp) ?? undefined} title={utc}>
        {formatAgo(data.head.timestamp - timestamp)}
      </time>
      <span className="sh-visually-hidden">
        , block {formatBlock(block)}, {utc}
      </span>
      <Tier block={block} data={data} />
    </span>
  );
}

function Side({ side }: { side: 'buy' | 'sell' }) {
  // A word and a glyph, never colour alone and never green or red (VL-5).
  return (
    <span className="sh-fit-side" data-side={side}>
      <span aria-hidden="true">{side === 'buy' ? '▲' : '▼'}</span> {side === 'buy' ? 'Buy' : 'Sell'}
    </span>
  );
}

function Trader({ trade, chainId }: { trade: LiveTrade; chainId: number }) {
  if (trade.trader === null) return <span className="sh-muted">not known yet</span>;
  const href = fitExplorerHref(chainId, { address: trade.trader });
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className="sh-fit-trader">
      <code>{shortAddress(trade.trader)}</code>
      <span className="sh-visually-hidden"> (opens the explorer in a new tab)</span>
    </a>
  ) : (
    <code className="sh-fit-trader">{shortAddress(trade.trader)}</code>
  );
}

/** The launch tax, always apart from the pool ETH ("+ 0.0373 ETH tax"); the genesis buy says what happened to its tokens. */
function RouteNote({ trade, symbol }: { trade: LiveTrade; symbol: string }) {
  if (trade.route === 'bootstrap') return <span className="sh-fit-tape__note">{`Genesis · ${symbol} burned`}</span>;
  if (trade.route === 'launch_router' && trade.taxRaw > 0n) return <span className="sh-fit-tape__note">+ {formatEth(trade.taxRaw)} tax</span>;
  return null;
}

function TradeRow({ trade, data, chainId, symbol }: { trade: LiveTrade; data: LiveData; chainId: number; symbol: string }) {
  return (
    <li className="sh-fit-tape__row" data-side={trade.side} data-route={trade.route}>
      <Side side={trade.side} />
      <span className="sh-fit-tape__eth">
        {formatEth(trade.ethRaw)} <RouteNote trade={trade} symbol={symbol} />
      </span>
      <span className="sh-fit-tape__fit">{formatToken(trade.tokenRaw, symbol, { compact: true })}</span>
      <span className="sh-fit-tape__who">
        <Trader trade={trade} chainId={chainId} />
      </span>
      <When block={trade.block} timestamp={trade.timestamp} data={data} />
    </li>
  );
}

function FoldedRow({ row, data }: { row: Extract<TapeRow, { kind: 'folded' }>; data: LiveData }) {
  const counts = [row.buys > 0 ? `${row.buys} ${row.buys === 1 ? 'buy' : 'buys'}` : '', row.sells > 0 ? `${row.sells} ${row.sells === 1 ? 'sell' : 'sells'}` : ''].filter(Boolean);
  const flows = [row.ethIn > 0n ? `${formatEth(row.ethIn)} in` : '', row.ethOut > 0n ? `${formatEth(row.ethOut)} out` : ''].filter(Boolean);
  return (
    <li className="sh-fit-tape__row" data-kind="folded">
      <span className="sh-fit-side">{counts.join(' · ')}</span>
      <span className="sh-fit-tape__eth">
        {flows.join(' · ')} {row.taxIn > 0n ? <span className="sh-fit-tape__note">+ {formatEth(row.taxIn)} tax</span> : null}
      </span>
      <When block={row.block} timestamp={row.timestamp} data={data} />
    </li>
  );
}

/**
 * The tape (VL-5), one compact row per trade: side as a word and glyph, ETH (the launch tax apart), the token amount
 * in the market's symbol, the trader, the time since (counted from the newest block) and "not final" while it is.
 * What the columns mean is behind the (i).
 */
export function TradeTape({ data, target, direct }: { data: LiveData | null; target: FitMarketTarget; direct: boolean }) {
  const tip = useInfoTip();
  const [all, setAll] = useState(false);
  const symbol = target.names.tokenSymbol;
  const rows = data ? tapeRows(data.trades) : [];
  const shown = all ? rows : rows.slice(0, TAPE_ROWS);
  return (
    <section className="sh-detail-card sh-fit-tape" aria-labelledby="fit-tape-title">
      <div className="sh-detail-card__head">
        <h2 id="fit-tape-title" className="sh-detail-card__title">
          Recent trades
        </h2>
        <div className="sh-fit-card-tools">
          <InfoButton tip={tip} label="About recent trades" />
        </div>
      </div>
      <InfoPanel tip={tip}>
        <p>
          Newest first, seen on the pool, never made here. ETH went into or out of the pool; launch tax is shown apart. A block with more than {FOLD_ABOVE} trades folds into one
          row.
        </p>
        <p>
          Times count back from the newest block (exact UTC time on hover). “Not final” marks a block that can still change
          {data ? `; ${blockCount(BigInt(data.confirmations))} deep counts as confirmed` : ''}.
        </p>
        {data && !direct && data.trades.length > 0 ? (
          <p>
            The last {data.trades.length} trades the live service holds, up to block {formatBlock(data.head.number)}.
          </p>
        ) : null}
      </InfoPanel>
      {data === null ? (
        <p className="sh-fit-tape__empty">Shown once the curve can be read.</p>
      ) : direct ? (
        <p className="sh-fit-tape__empty">No trades: a direct chain read carries none.</p>
      ) : rows.length === 0 ? (
        <p className="sh-fit-tape__empty">No trades in the recent blocks.</p>
      ) : (
        <ol className="sh-fit-tape__list">
          {shown.map((row) =>
            row.kind === 'folded' ? <FoldedRow key={row.id} row={row} data={data} /> : <TradeRow key={row.trade.id} trade={row.trade} data={data} chainId={target.chainId} symbol={symbol} />,
          )}
        </ol>
      )}
      {rows.length > TAPE_ROWS && !direct ? (
        <p className="sh-fit-tape__more">
          <button type="button" className="sh-button sh-fit-tape__toggle" aria-expanded={all} onClick={() => setAll((value) => !value)}>
            {/* The space stays in the same text node, so the name reads "Show all 25 trades" everywhere. */}
            {all ? `Show the newest ${TAPE_ROWS} ` : `Show all ${rows.length} `}
            <span className="sh-visually-hidden">trades</span>
          </button>
        </p>
      ) : null}
    </section>
  );
}
