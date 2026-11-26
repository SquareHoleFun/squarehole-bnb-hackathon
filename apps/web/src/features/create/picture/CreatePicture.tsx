/**
 * SH-251: the visual Create: the picture is the form. A tap on a part opens its choice in place (PartSheet); the
 * sheets hold the SAME field components the six steps use (CreateV2Flow passes them in, `sheetBody`), on the SAME
 * draft, so the picture redraws at once and a box made here is made by the same code as one made from the steps. The
 * Overview and everything after it are the steps' own. "What happens" plays made-up trades after graduation and
 * changes nothing but this page's numbers.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FocusEvent, type ReactNode } from 'react';
import { TEMPLATE_ICONS } from '../../brand/template-icons';
import { InfoButton, InfoPanel, useInfoTip } from '../../fit-pair/InfoTip';
import { NO_TRADES, addTrade, HUNDRED_TRADES, type SimTotals } from '../../box-picture/fee-split';
import { LOCK_ICON } from '../../box-picture/mini';
import { iconOf, ledgerOf, pictureOf, whyOf, type PartId, type PictureInput, type Side, type StationIcon } from '../../box-picture/picture';
import { PART_WHY, PICTURE_WORDS, aboutOf, pictureWords } from '../../box-picture/picture-words';
import { BoxPictureSvg } from './BoxPictureSvg';
import { playTrade, prefersReducedMotion } from './flight';
import { PartSheet, type CloseWay } from './PartSheet';
import { WALK_ORDER, WALK_STEP_MS, Walk, walkSwitch, type WalkStop } from './Walk';
import { WhatHappens, type Play } from './WhatHappens';

/** One of the steps' issues as the picture lists it: its line, the part that fixes it and the control to focus. */
export interface PictureIssue {
  readonly key: string;
  readonly line: string;
  readonly part: PartId;
  readonly control: string;
}

export interface CreatePictureProps {
  /** The picture's input from the draft (picture-input.ts), without a run of "What happens". */
  readonly input: Omit<PictureInput, 'totals'>;
  /** The steps' own template row (TemplateRow, with the picture's small boxes), or null while a loaded setup holds the recipe. */
  readonly templates: ReactNode;
  /** The open sheet: kept by the page, so the reads a sheet needs (the fees' sale list) follow it. */
  readonly open: PartId | null;
  readonly onOpen: (part: PartId | null) => void;
  /** SH-254: the open sheet came with the page (a problem pressed on the Overview): it does not take focus itself. */
  readonly openQuietly?: boolean;
  /** The steps' own fields for a part's sheet (null: the sheet only shows its split and its (?)). */
  readonly sheetBody: (part: PartId) => ReactNode;
  /** The issues the steps would show now (a control left, or Overview pressed), in the steps' words. */
  readonly issues: readonly PictureIssue[];
  readonly onIssue: (issue: PictureIssue) => void;
  /** Overview: the steps' own rule decides whether it opens the Overview or reveals what to fix (CreateV2Flow). */
  readonly onOverview: () => void;
  /** Grows each time Overview revealed issues instead of opening: the list's title takes focus. */
  readonly revealKey: number;
  /** The box coin's name for the sale-fees line (the ticker, or the site's "the box coin"). */
  readonly boxCoin: string;
  /** Above the picture: a loaded setup's note (the steps' own). */
  readonly notice?: ReactNode;
}

const TITLE: Readonly<Record<PartId, string>> = {
  token: PICTURE_WORDS.token, contents: PICTURE_WORDS.contents, price: PICTURE_WORDS.pricedIn, raise: PICTURE_WORDS.raise, creator: PICTURE_WORDS.creator,
  holders: PICTURE_WORDS.holders, buyers: PICTURE_WORDS.buyersFees, sellers: PICTURE_WORDS.sellersFees, pool: PICTURE_WORDS.pool, mark: PICTURE_WORDS.squareHole,
};
const ID_PREFIX = 'sh-pic';

/** The sheet's icon: what the part shows (a side's own station, the box's own contents). */
function sheetIcon(part: PartId, input: Omit<PictureInput, 'totals'>): StationIcon | 'blank' {
  if (part === 'buyers' || part === 'sellers') return iconOf(input[part], input.eatBurns) ?? 'blank';
  if (part === 'contents') return input.contents === 'collection' ? 'collection' : input.contents === 'shop' ? 'shop' : input.pile ? 'pile' : input.contents === 'token' ? 'liquidity' : 'blank';
  const fixed: Readonly<Record<Exclude<PartId, 'buyers' | 'sellers' | 'contents'>, StationIcon | 'blank'>> = { token: 'liquidity', price: 'liquidity', raise: 'pile', creator: 'creator', holders: 'holders', pool: 'liquidity', mark: 'blank' };
  return fixed[part];
}

function SheetIcon({ icon }: { icon: StationIcon | 'blank' }) {
  return (
    <svg viewBox="0 0 24 24" className="sh-pic-icon" focusable="false">
      {icon === 'lock' ? <path d={LOCK_ICON} /> : TEMPLATE_ICONS[icon].art}
    </svg>
  );
}

/** The split of every fee, as the trays show it: 10 for the side's pick, 2 for the pool, 3 for Square Hole. */
function Split() {
  return (
    <div className="sh-pic-split">
      <div className="sh-pic-split__bar" aria-hidden="true"><span className="sh-pic-cell--pick" /><span className="sh-pic-cell--pool" /><span className="sh-pic-cell--mark" /></div>
      <p className="sh-pic-split__words"><span>{PICTURE_WORDS.pickParts}</span><span>{PICTURE_WORDS.poolParts}</span><span>{PICTURE_WORDS.markParts}</span></p>
    </div>
  );
}

export function CreatePicture({ input, templates, open, onOpen, openQuietly = false, sheetBody, issues, onIssue, onOverview, revealKey, boxCoin, notice = null }: CreatePictureProps) {
  // A run belongs to the price coin it ran in (its amounts are in that coin): another coin shows no run.
  const [run, setRun] = useState<{ readonly symbol: string; readonly totals: SimTotals }>({ symbol: '', totals: NO_TRADES });
  const totals = run.symbol === input.price.symbol ? run.totals : NO_TRADES;
  const setTotals = (next: (before: SimTotals) => SimTotals) => setRun((before) => ({ symbol: input.price.symbol, totals: next(before.symbol === input.price.symbol ? before.totals : NO_TRADES) }));
  const [playing, setPlaying] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const issuesTitleRef = useRef<HTMLParagraphElement>(null);
  const hint = useInfoTip();
  const headingId = useId();
  const hintId = useId();
  const issuesId = useId();
  const issuesTitleId = useId();
  const picture = useMemo(() => pictureOf({ ...input, totals }), [input, totals]);
  const rows = useMemo(() => ledgerOf({ ...input, totals }), [input, totals]);
  const trade = 10n ** BigInt(input.price.decimals);

  // SH-254: the walk through the parts (Walk.tsx). `owns`: the open sheet is the walk's (it opened it without moving
  // focus); a press on a part makes it the person's again.
  const [walk, setWalk] = useState<{ readonly at: number; readonly playing: boolean; readonly owns: boolean }>({ at: -1, playing: false, owns: false });
  const overviewRef = useRef<HTMLButtonElement>(null);
  const walkOn = walkSwitch.on;
  const walkAt: WalkStop | null = walkOn && walk.at >= 0 ? WALK_ORDER[walk.at] ?? null : null;
  const goStep = useCallback((index: number, playing: boolean) => {
    const stop = WALK_ORDER[index];
    if (stop === undefined) return;
    setWalk({ at: index, playing, owns: stop !== 'overview' });
    onOpen(stop === 'overview' ? null : stop);
    const button = overviewRef.current;
    if (stop === 'overview' && button && typeof button.scrollIntoView === 'function') button.scrollIntoView({ block: 'nearest' });
  }, [onOpen]);
  // While it plays it moves on by itself, never with reduced motion (there Play goes one step).
  useEffect(() => {
    if (!walk.playing) return undefined;
    const timer = window.setTimeout(() => {
      if (walk.at + 1 < WALK_ORDER.length) goStep(walk.at + 1, true);
      else setWalk((before) => ({ ...before, playing: false }));
    }, WALK_STEP_MS);
    return () => window.clearTimeout(timer);
  }, [walk, goStep]);
  // Any press or key elsewhere on the page stops it where it is: the person takes over.
  useEffect(() => {
    if (!walk.playing) return undefined;
    const stop = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('[data-walk]')) return;
      setWalk((before) => ({ ...before, playing: false }));
    };
    document.addEventListener('pointerdown', stop, true);
    document.addEventListener('keydown', stop, true);
    return () => {
      document.removeEventListener('pointerdown', stop, true);
      document.removeEventListener('keydown', stop, true);
    };
  }, [walk.playing]);
  const playWalk = () => {
    if (walk.playing) { setWalk((before) => ({ ...before, playing: false })); return; }
    const from = walk.at < 0 || walk.at >= WALK_ORDER.length - 1 ? 0 : walk.at;
    if (prefersReducedMotion()) goStep(walk.at < 0 || walk.at >= WALK_ORDER.length - 1 ? 0 : walk.at + 1, false);
    else goStep(from, true);
  };
  const walkSteps = WALK_ORDER.map((stop) => ({
    id: stop,
    name: stop === 'overview' ? PICTURE_WORDS.overview : TITLE[stop],
    icon: stop === 'overview' ? <span className="sh-pic-walk__end" aria-hidden="true" /> : <SheetIcon icon={sheetIcon(stop, input)} />,
  }));

  // Overview revealed what to fix: the list's title takes focus (the steps' summary does the same).
  useEffect(() => { if (revealKey > 0) issuesTitleRef.current?.focus(); }, [revealKey]);

  const anchor = useCallback(() => (open ? svgRef.current?.querySelector(`[data-part="${open}"]`) ?? null : null), [open]);
  const stage = useCallback(() => stageRef.current, []);
  // Escape and Close give focus back to what opened the sheet: the part, or (SH-254) the problem that opened it while
  // it is still listed; leaving the sheet (focus or a click elsewhere) leaves focus where it went.
  const openedBy = useRef<string | null>(null);
  const close = useCallback((way: CloseWay) => {
    const was = open;
    const problem = openedBy.current ?? (openQuietly ? '' : null);
    openedBy.current = null;
    onOpen(null);
    if (!was || way === 'left') return;
    window.setTimeout(() => {
      // Back to that problem while it is listed; when it is gone and others remain, to the list's title (it says how
      // many); only when the list is empty (or the sheet was the part's own), to the part.
      const buttons = Array.from(document.querySelectorAll<HTMLElement>('[data-problem]'));
      const button = problem ? buttons.find((element) => element.dataset.problem === problem) : undefined;
      const list = problem !== null && buttons.length > 0 ? issuesTitleRef.current : null;
      (button ?? list ?? svgRef.current?.querySelector<SVGGElement>(`[data-part="${was}"]`))?.focus();
    }, 0);
  }, [open, onOpen, openQuietly]);
  const toggle = (part: PartId) => {
    openedBy.current = null;
    setWalk((before) => ({ ...before, owns: false }));
    onOpen(open === part ? null : part);
  };
  const openProblem = (issue: PictureIssue) => {
    openedBy.current = issue.key;
    onIssue(issue);
  };
  // A problem only keeps the sheet while it is pressed: focus moving from it on to anything outside the sheet (other
  // than another problem, or a part of the drawing, whose own press decides) shuts the sheet like any other departure.
  const leaveProblem = (event: FocusEvent<HTMLButtonElement>) => {
    const next = event.relatedTarget;
    if (open && next instanceof Element && !next.closest('[data-sheet], [data-problem], [data-part]')) close('left');
  };

  const play = async (what: Play) => {
    if (playing) return;
    setPlaying(true);
    try {
      const warn = (side: Side) => input[side].warn || input[side].choice === null;
      const one = async (side: Side, quick = false) => {
        await playTrade(svgRef.current, ID_PREFIX, side, { quick, warn: warn(side) });
        setTotals((before) => addTrade(before, side, trade));
      };
      if (what === 'buy') await one('buyers');
      else if (what === 'sell') await one('sellers');
      else {
        // 100 trades: a few are drawn, every one is counted, each split on its own side with its own carry.
        const drawn = prefersReducedMotion() ? 0 : 6;
        for (const side of HUNDRED_TRADES.slice(0, drawn)) await one(side, true);
        setTotals((before) => HUNDRED_TRADES.slice(drawn).reduce((sum, side) => addTrade(sum, side, trade), before));
      }
    } finally {
      setPlaying(false);
    }
  };

  const body = open ? sheetBody(open) : null;
  const pictureAbout = aboutOf('picture');
  return (
    <div className="sh-pic-page" data-walk-on={walkOn || undefined} data-walking={(walkOn && walk.at >= 0) || undefined}>
      {notice}
      {/* Phone: the templates, the picture, then What happens. Wide: the picture left; the templates and What happens beside it. */}
      <div className="sh-pic-layout">
        {templates ? <div className="sh-pic-tpl">{templates}</div> : null}
        <div className="sh-pic-main">
          <h2 id={headingId} className="sh-visually-hidden">{PICTURE_WORDS.pictureName}</h2>
          <div ref={stageRef} className="sh-pic-stage">
            <BoxPictureSvg picture={picture} open={open} onPart={toggle} svgRef={svgRef} idPrefix={ID_PREFIX} labelledBy={headingId} describedBy={hintId} />
            {open ? (
              <PartSheet key={open} takeFocus={!openQuietly && !(walk.owns && walkAt === open)} title={TITLE[open]} icon={<SheetIcon icon={sheetIcon(open, input)} />} why={whyOf(open, input)} whyLabel={aboutOf(open)} anchor={anchor} stage={stage} onClose={close}>
                {/* The steps' fields sit in a form of their own, as on the steps; Enter in a field never leaves the picture. */}
                <form className="sh-pic-sheet__form" noValidate onSubmit={(event) => event.preventDefault()}>
                  {open === 'pool' || open === 'mark' || open === 'buyers' || open === 'sellers' ? <Split /> : null}
                  {body}
                </form>
              </PartSheet>
            ) : null}
          </div>
          {walkOn ? <Walk steps={walkSteps} at={walk.at} playing={walk.playing} onPlay={playWalk} onStep={(index) => goStep(index, false)} onNext={() => goStep(walk.at + 1, false)} /> : null}
          <div className="sh-pic-hint">
            <span id={hintId}>{PICTURE_WORDS.hint}</span>
            {pictureAbout ? <InfoButton tip={hint} label={pictureAbout} /> : null}
          </div>
          {pictureAbout ? <InfoPanel tip={hint}>{PART_WHY.picture.map((line) => <p key={line}>{line}</p>)}</InfoPanel> : null}
        </div>
        <div className="sh-pic-side">
          <WhatHappens symbol={input.price.symbol} decimals={input.price.decimals} trade={trade} totals={totals} rows={rows} playing={playing} boxCoin={boxCoin}
            onPlay={(what) => { void play(what); }} onClear={() => setTotals(() => NO_TRADES)} />
          <section className="sh-pic-card">
            <button ref={overviewRef} type="button" className="sh-button sh-button--primary sh-pic-overview" data-walk-here={walkAt === 'overview' || undefined} aria-describedby={issues.length > 0 ? issuesId : undefined} onClick={onOverview}>{PICTURE_WORDS.overview}</button>
            {/* What to fix, as the steps say it and when the steps would (a control left, or Overview pressed). */}
            <p ref={issuesTitleRef} id={issuesTitleId} className="sh-pic-issues__title" role="status" tabIndex={-1}>{issues.length > 0 ? pictureWords.toFix(issues.length) : ''}</p>
            {issues.length > 0 ? (
              <ul id={issuesId} className="sh-pic-issues" aria-labelledby={issuesTitleId}>
                {issues.map((issue) => (
                  <li key={issue.key}><button type="button" className="sh-newbox-text-button" data-problem={issue.key} onClick={() => openProblem(issue)} onBlur={leaveProblem}>{issue.line}</button></li>
                ))}
              </ul>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}
