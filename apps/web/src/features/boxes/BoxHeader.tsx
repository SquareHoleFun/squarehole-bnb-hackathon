/**
 * The box header, the same for every box (BOX-INTERFACE § 4; the approved mock-up's header): the cover with the state
 * band along its bottom edge (the state in words, its colour and its one figure), the chips (kind, chain, Demo or
 * Rehearsal), the name and its one line, the token's address with Copy, the phase line (the launch tax whenever it
 * applies; graduation pending), and on the right the peek strip (a few ordinary examples, a tap opens "What's in the
 * box?") with the "Owning one" row; then a stats row (2 × 2 on a phone) and the counters (a row on wide screens; on a
 * phone a sticky bar).
 *
 * On a phone the cover is a 96 px square with the peek strip beside it and the band under both, so a Misfit is on the
 * first screen.
 */
import type { ReactNode } from 'react';
import { PAGE_TITLE_ID } from '../../pages/page-parts';
import { CloseBox } from '../core/v2/CloseBox';
import { CLOSED } from '../core/v2/v2-words';
import { InfoButton, InfoPanel, useInfoTip } from '../fit-pair/InfoTip';
import { KIND_LABELS, rehearsalShown, type BoxRecord, type BoxState } from './box-model';
import { BoxCover, BoxGlyph, ChainChip, CoverTape, StateBand } from './BoxParts';
import { Counters, PhoneCounterBar } from './CounterRow';
import type { Counter } from './counters';
import { headerSlot } from './picture-slot';


export interface Stat {
  readonly label: string;
  readonly value: ReactNode;
  /** A short unit under the value ("ETH per 1M FIT"). */
  readonly unit?: string;
  /** What the cell means, behind its (i). */
  readonly info?: string;
  /** One line, its size fitted to the cell (the exact raise, "4.206980085", on a phone's three columns), never broken. */
  readonly fit?: boolean;
}

function StatCell({ stat }: { stat: Stat }) {
  const tip = useInfoTip();
  return (
    <div className="sh-box-stat">
      <dt>
        {stat.label}
        {stat.info ? <InfoButton tip={tip} label={`About ${stat.label}`} /> : null}
      </dt>
      <dd data-fit={stat.fit || undefined}>
        {stat.value}
        {stat.unit ? <small>{stat.unit}</small> : null}
        {stat.info ? (
          <InfoPanel tip={tip}>
            <p>{stat.info}</p>
          </InfoPanel>
        ) : null}
      </dd>
    </div>
  );
}

/** The stats row (2 × 2 on a phone): the header's own, also beside the creation page's card preview. */
export function BoxStats({ stats }: { stats: readonly Stat[] }) {
  return (
    <dl className={`sh-box-stats${stats.length === 3 ? ' sh-box-stats--three' : stats.length === 5 ? ' sh-box-stats--five' : ''}`}>
      {stats.map((stat) => (
        <StatCell key={stat.label} stat={stat} />
      ))}
    </dl>
  );
}

/** The state band's figure (the state's one number) and its bar while a curve runs. */
export interface Band {
  readonly figure: string | null;
  readonly barBps: number | null;
}

export interface BoxHeaderProps {
  readonly record: BoxRecord;
  readonly state: BoxState | null;
  readonly band: Band;
  /** One line under the name (the tagline), or null. */
  readonly line: string | null;
  /** The token's address line (compact). */
  readonly idLine: ReactNode;
  readonly phase: ReactNode;
  readonly stats: readonly Stat[];
  /** The counters row; null for a page with its own controls below the header (a core v2 box's, SH-224). */
  readonly counters: readonly Counter[] | null;
  /** Honesty notes that are never cut (stale, unverified, unavailable, a failed vault read). */
  readonly notice?: ReactNode;
  /** The right-hand side: the peek strip and the "Owning one" row. */
  readonly side: ReactNode;
  /**
   * A preview of a box not created yet (the creation page): the name is a second-level heading, not the page's title,
   * and there are no counters (nothing can be done with a box that does not exist).
   */
  readonly preview?: boolean;
  /** The tape across the cover: "Preview" for a box not created yet; none otherwise (no Demo tape since F130). */
  readonly tape?: string | null;
  /** The collection page's banner (F71 (2)) as an image URL: a 4:1 strip across the top of the header; null = none. */
  readonly banner?: string | null;
  /** An extra class on the header (the v2 box page's arrangement, SH-224). */
  readonly className?: string;
}

export function BoxHeader({ record, state, band, line, idLine, phase, stats, counters, notice, side, preview = false, tape = null, banner = null, className = '' }: BoxHeaderProps) {
  return (
    <header className={`sh-box-head${banner ? ' sh-box-head--banner' : ''}${className ? ` ${className}` : ''}`} data-state={state ?? 'unavailable'} data-v2={record.v2 ? '' : undefined}>
      {banner ? (
        <div className="sh-box-head__banner">
          <img src={banner} width={1200} height={300} alt={`${record.name} banner`} decoding="async" />
        </div>
      ) : null}
      <div className="sh-box-head__visual">
        <div className="sh-box-head__cover">
          {/* SH-223: the Genesis box shows its box picture here, every other box its logo (picture-slot.ts). */}
          <BoxCover record={record} slot={headerSlot(record)} />
          {tape ? <CoverTape label={tape} /> : null}
        </div>
        <StateBand state={state} figure={band.figure} barBps={band.barBps} className="sh-box-head__band" label={(record.v2 || record.v2Chain) && state === 'failed' ? CLOSED : undefined} />
      </div>
      <div className="sh-box-head__id">
        <p className="sh-box-head__chips">
          <span className="sh-box-kind">
            <BoxGlyph />
            {KIND_LABELS[record.kind]}
          </span>
          <ChainChip record={record} />
          {/* A v1 rehearsal record's chip. SH-224 phase 3: not on a core v2 box, whose local records carry the flag only
             for being local (record-v2.ts); its chain chip says "Local chain". */}
          {rehearsalShown(record) ? (
            <span className="sh-status-chip sh-box-rehearsal" data-disclosure="">
              Rehearsal · test set<span className="sh-visually-hidden">: neutral names, test tokens with no value</span>
            </span>
          ) : null}
        </p>
        {preview ? (
          <h2 className="sh-page__title sh-box-head__title">{record.name}</h2>
        ) : (
          <h1 id={PAGE_TITLE_ID} className="sh-page__title sh-box-head__title" tabIndex={-1}>
            {record.name}
          </h1>
        )}
        {line ? <p className="sh-box-head__line">{line}</p> : null}
        {idLine}
        {phase}
        {notice}
        {/* A v2 box anyone may close now: "Close box", which asks for a wallet only when pressed (F99). */}
        {record.v2 && !preview ? <CloseBox record={record} /> : null}
      </div>
      <div className="sh-box-head__side">{side}</div>
      <BoxStats stats={stats} />
      {preview || counters === null ? null : (
        <>
          <Counters counters={counters} />
          <PhoneCounterBar counters={counters} state={state} v2={record.v2 !== undefined} />
        </>
      )}
    </header>
  );
}
