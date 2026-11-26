/**
 * SH-255: the top of a v2 box's page as its picture (the founder, 24 November 2026: "Yes: into the app, after the
 * Create picture is live"). The same drawing as Create (create/picture/BoxPictureSvg.tsx, box-picture/picture.ts) with
 * the box page's own input (live-picture.ts) and layers (LiveLayers.tsx): what IS and what HAPPENED. A tap on a part
 * opens what today's page said about it (LiveSheets.tsx) in the shared sheet (create/picture/PartSheet.tsx).
 *
 * In its place on the page: the name and its line, the life strip, the picture; the header's number tiles as the
 * figures row and Where the fees go, which are the picture's numbers as text; What you can do here, whose entries take
 * the reader to the page's own controls below (nothing here asks a wallet or sends anything).
 * Loaded on its own (V2BoxPage's lazy import), so the drawing's code is a chunk of its own.
 */
import { memo, useCallback, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { TEMPLATE_ICONS } from '../../../brand/template-icons';
import type { BoxRecord } from '../../../boxes/box-model';
import { BoxStats } from '../../../boxes/BoxHeader';
import { BoxCover, ChainChip } from '../../../boxes/BoxParts';
import { headerSlot } from '../../../boxes/picture-slot';
import { InfoButton, InfoPanel, useInfoTip } from '../../../fit-pair/InfoTip';
import { LOCK_ICON } from '../../../box-picture/mini';
import { PART_WHY, aboutOf } from '../../../box-picture/picture-words';
import { BoxPictureSvg } from '../../../create/picture/BoxPictureSvg';
import { PartSheet, type CloseWay } from '../../../create/picture/PartSheet';
import '../../../create/picture/create-picture.css';
import { PAGE_TITLE_ID } from '../../../../pages/page-parts';
import { headerStatsV2 } from '../V2BoxPage';
import type { V2Snapshot } from '../indexer-v2';
import { LifeStripV2 } from '../LifeViewV2';
import type { LifeStageV2, LifeStepV2 } from '../life-state';
import { formatBps } from '../../../fit-pair/fit-format';
import { liveLayers } from './LiveLayers';
import { deadlinePassedV2, liveModelOf, livePictureOf, type LiveCoin, type LiveModel } from './live-picture';
import { sheetOf, type LivePartId, type LiveSheet } from './LiveSheets';
import { BOX_PICTURE_WORDS as W } from './box-picture-words';
import './box-page-picture.css';

/** An entry of What you can do here: its words and the place on the page it takes the reader to. */
export interface DoEntry {
  readonly key: string;
  readonly icon: 'claim' | 'pile' | 'in';
  readonly label: string;
  readonly note: string | null;
  /** The element id of the card it leads to; inside it, its controls carry `data-entry-target` = this entry's key. */
  readonly target: string;
  /** Without its marked control shown and enabled, focus lands on the card's first control (review fix 7), not the card. */
  readonly firstControl?: boolean;
}

export interface BoxPagePictureProps {
  readonly record: BoxRecord;
  readonly view: V2Snapshot;
  readonly life: { readonly steps: readonly LifeStepV2[]; readonly stage: LifeStageV2; readonly nowSec: bigint };
  readonly alchemist: { readonly buyers: boolean; readonly sellers: boolean };
  readonly pileCoin: LiveCoin | null;
  /** Under the name: the token's address with Copy and the creator's links (the page's own). */
  readonly idLine: ReactNode;
  /** The notices that are never cut (stale, checking, a picture to add). */
  readonly notice: ReactNode;
  /** The Creator's claim as today's card reads it. */
  readonly creatorClaim: ReactNode;
  readonly entries: readonly DoEntry[];
  /** The page's own decision that anyone may close the box now (closeStateOf), for the hatch's words in the raise sheet. */
  readonly closable?: boolean;
}

const ID_PREFIX = 'sh-bpic';

/**
 * The drawing, rendered again only when its own inputs change (the snapshot, the open part, the checks): never on a tick
 * of the page's clock, which only the strip and an open raise sheet ("Full ... ago") read (the full run of 25 November:
 * the whole SVG re-rendered every second).
 */
const Drawing = memo(BoxPictureSvg);

function SheetIcon({ icon }: { icon: LiveSheet['icon'] }) {
  if (icon === 'mark') return <svg viewBox="0 0 24 24" className="sh-bpic-mark-icon" focusable="false"><rect x="2" y="2" width="20" height="20" rx="6" /><rect x="7.5" y="7.5" width="9" height="9" rx="1.8" /></svg>;
  if (icon === 'inbox') return <svg viewBox="0 0 24 24" className="sh-pic-icon" focusable="false"><rect x="3" y="5.5" width="18" height="13" rx="2" /><path d="M3.5 6.5 12 13l8.5-6.5" /></svg>;
  return <svg viewBox="0 0 24 24" className="sh-pic-icon" focusable="false">{icon === 'lock' ? <path d={LOCK_ICON} /> : TEMPLATE_ICONS[icon].art}</svg>;
}

const DO_ICON: Readonly<Record<DoEntry['icon'], ReactNode>> = {
  claim: <><path d="M4 12.6v5.9A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-5.9" /><path d="M12 3.6v10.2M8.4 10.2l3.6 3.6 3.6-3.6" /></>,
  pile: <><ellipse cx="9.5" cy="9.5" rx="5.5" ry="2" /><path d="M4 9.5v9c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-9M4 12.5c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2M4 15.5c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2" /><circle cx="18.5" cy="17.5" r="3" /></>,
  in: <><path d="M12 4v11M8 11l4 4 4-4" /><path d="M4 13v5.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V13" /></>,
};

/** Shown: neither it nor an ancestor is hidden or drawn as `display: none` (a loading chunk's empty place). */
function shown(el: Element): boolean {
  for (let node: Element | null = el; node; node = node.parentElement) {
    if (node.hasAttribute('hidden') || getComputedStyle(node).display === 'none') return false;
  }
  return true;
}
/** Enabled: not disabled itself and not inside a disabled fieldset. */
const enabled = (el: Element): boolean => !(el as HTMLButtonElement).disabled && el.closest('fieldset:disabled') === null;

/**
 * Takes the reader to the card an entry leads to and puts focus on its action (round 3, D11): the first control in the
 * card marked for this entry (`data-entry-target`: the Redeem amount, Claim all, a Put back) that is shown and enabled;
 * else the card itself, made focusable for it (tabindex -1), when it is shown. Never a list's first button, a disclosure,
 * a model viewer or a place hidden while its chunk loads. Returns whether focus moved.
 */
/** The controls a card's first-control fallback may land on: enabled and focusable as they are. */
const CONTROL = 'button, input, select, textarea, a[href], summary';
export function goTo(target: string, key: string, firstControl = false): boolean {
  const place = document.getElementById(target);
  if (!place || !shown(place)) return false;
  const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  place.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
  const own = [...place.querySelectorAll<HTMLElement>(`[data-entry-target="${key}"]`)].find((el) => shown(el) && enabled(el));
  const first = firstControl ? [...place.querySelectorAll<HTMLElement>(CONTROL)].find((el) => shown(el) && enabled(el)) : undefined;
  const focusable = own ?? first ?? place;
  if (focusable === place && !place.hasAttribute('tabindex')) place.setAttribute('tabindex', '-1');
  focusable.focus({ preventScroll: true });
  return document.activeElement === focusable;
}

function stageWord(model: LiveModel, view: V2Snapshot): string {
  switch (model.stage) {
    case 'graduated': return W.graduated;
    case 'graduating': return W.graduating;
    case 'failed': return W.closed;
    case 'scheduled': return W.upcoming;
    default: {
      // Past its deadline (chain time) every buy reverts: the site's own words, never "Raising".
      if (deadlinePassedV2(view)) return W.deadlinePassed;
      const progress = view.statistics?.raiseProgress ?? null;
      return progress ? `${W.raising} · ${formatBps(Number(progress.progressBps))}` : W.raising;
    }
  }
}

export default function BoxPagePicture({ record, view, life, alchemist, pileCoin, idLine, notice, creatorClaim, entries, closable = false }: BoxPagePictureProps) {
  const [open, setOpen] = useState<LivePartId | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const hint = useInfoTip();
  const hintId = useId();
  const doId = useId();
  const ledgerId = useId();
  // The model reads no clock (every time in it is the snapshot's, chain time): its inputs are the snapshot and the page's
  // checks, by value, so a parent's new object on a clock tick (the Alchemist flags, the pile coin) changes nothing.
  const alchemistBuyers = alchemist.buyers; const alchemistSellers = alchemist.sellers;
  const pileSymbol = pileCoin?.symbol ?? null; const pileDecimals = pileCoin?.decimals ?? null;
  const model = useMemo(() => liveModelOf(record, view, {
    alchemist: { buyers: alchemistBuyers, sellers: alchemistSellers },
    pileCoin: pileSymbol === null || pileDecimals === null ? null : { symbol: pileSymbol, decimals: pileDecimals },
    closable,
  }), [record, view, alchemistBuyers, alchemistSellers, pileSymbol, pileDecimals, closable]);
  const picture = useMemo(() => livePictureOf(model), [model]);
  const toggle = useCallback((part: LivePartId) => setOpen((was) => (was === part ? null : part)), []);
  const openInbox = useCallback(() => toggle('inbox'), [toggle]);
  const inboxOpen = open === 'inbox';
  const layers = useMemo(() => liveLayers(model, ID_PREFIX, { open: inboxOpen, onOpen: openInbox }), [model, inboxOpen, openInbox]);
  const anchor = useCallback(() => (open ? svgRef.current?.querySelector(`[data-part="${open}"]`) ?? null : null), [open]);
  const stage = useCallback(() => stageRef.current, []);
  const close = useCallback((way: CloseWay) => {
    const was = open;
    setOpen(null);
    // Focus back to the part, a moment after the sheet is gone; only focus that went nowhere (SH-273: on a busy page the
    // moment can come after the reader opened the next sheet, and taking focus from it shut that sheet).
    if (was && way !== 'left') window.setTimeout(() => {
      const active = document.activeElement;
      if (active !== null && active !== document.body) return;
      (svgRef.current?.querySelector(`[data-part="${was}"]`) as SVGGElement | null)?.focus();
    }, 0);
  }, [open]);
  const sheet = open ? sheetOf(open, { record, view, model, nowSec: life.nowSec, pileCoin, creatorClaim }) : null;
  // The figures row is the header's tiles: their dollar values (SH-266) with the page's clock, as the header shows them.
  const stats = headerStatsV2(record, view, life.nowSec);
  const pictureAbout = aboutOf('picture');
  return (
    <div className="sh-pic-page sh-bpic" data-stage={model.stage}>
      <div className="sh-bpic-layout">
        <header className="sh-bpic-head">
          <p className="sh-bpic-chips">
            <span className="sh-bpic-phase" data-stage={model.stage}>{stageWord(model, view)}</span>
            <ChainChip record={record} />
          </p>
          <div className="sh-bpic-name">
            {/* The box's own logo (or cover), checked against its committed hash before it shows (BoxCover). */}
            <BoxCover record={record} slot={headerSlot(record)} small className="sh-bpic-cover" />
            <h1 id={PAGE_TITLE_ID} className="sh-page__title sh-bpic-title" tabIndex={-1}>{record.name}</h1>
            <span className="sh-bpic-ticker">{record.ticker}</span>
          </div>
          {record.line ? <p className="sh-bpic-line">{record.line}</p> : null}
          {idLine}
          {notice}
          <LifeStripV2 steps={life.steps} stage={life.stage} />
        </header>
        <div className="sh-bpic-main">
          <div ref={stageRef} className="sh-pic-stage">
            <Drawing picture={picture} open={open === 'inbox' ? null : open} onPart={toggle} svgRef={svgRef} idPrefix={ID_PREFIX} labelledBy={PAGE_TITLE_ID} describedBy={hintId} layers={layers} />
            {sheet && open ? (
              <PartSheet key={open} title={sheet.title} icon={<SheetIcon icon={sheet.icon} />} why={sheet.why} whyLabel={sheet.whyLabel} anchor={anchor} stage={stage} onClose={close}>
                {sheet.body}
              </PartSheet>
            ) : null}
          </div>
          <div className="sh-pic-hint">
            <span id={hintId}>{W.hint}</span>
            {pictureAbout ? <InfoButton tip={hint} label={pictureAbout} /> : null}
          </div>
          {pictureAbout ? <InfoPanel tip={hint}>{PART_WHY.picture.map((line) => <p key={line}>{line}</p>)}</InfoPanel> : null}
        </div>
        <div className="sh-bpic-side">
          <BoxStats stats={stats} />
          {entries.length > 0 ? (
            <section className="sh-pic-card" aria-labelledby={doId}>
              <h2 id={doId} className="sh-pic-card__title">{W.whatYouCanDo}</h2>
              <ul className="sh-bpic-do">
                {entries.map((entry) => (
                  <li key={entry.key}>
                    <button type="button" className="sh-bpic-do__entry" onClick={() => goTo(entry.target, entry.key, entry.firstControl)}>
                      <span className="sh-bpic-do__icon" aria-hidden="true"><svg viewBox="0 0 24 24" className="sh-pic-icon" focusable="false">{DO_ICON[entry.icon]}</svg></span>
                      <span className="sh-bpic-do__text"><b>{entry.label}</b>{entry.note ? <small>{entry.note}</small> : null}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section className="sh-pic-card" aria-labelledby={ledgerId}>
            <h2 id={ledgerId} className="sh-pic-card__title">{W.whereFeesGo}</h2>
            {model.feesLine ? <p className="sh-pic-muted-text">{model.feesLine}</p> : null}
            <ul className="sh-pic-ledger">
              {model.ledger.map((line) => (
                <li key={line.key} data-place={line.choice} data-side={line.key}>
                  <span aria-hidden="true">{line.choice === 'mark' ? <SheetIcon icon="mark" /> : <SheetIcon icon={line.choice === 'pool' ? 'liquidity' : picture.sides[line.key === 'sellers' ? 'sellers' : 'buyers'].icon ?? 'blank'} />}</span>
                  <span className="sh-pic-ledger__label"><span className="sh-bpic-ledger-place">{line.label}</span>{line.note ? <>{' '}<small className="sh-bpic-ledger-note">{line.note}</small></> : null}</span>{' '}
                  <span className="sh-pic-ledger__amount">{line.amount !== null ? <><b>{line.amount}</b>{' '}<small>{model.coin}</small></> : null}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
