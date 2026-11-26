/**
 * SH-251: a part's choice, opened in place: a bottom sheet on a phone, a popover beside the part on a wider screen. It
 * is a non-modal dialog. When it opens, focus moves to its title (the header stays in view while the sheet scrolls).
 * Escape or Close shut it and the page puts focus back on the part (CreatePicture); when focus moves out of it, or a
 * click lands outside it and off the picture's parts, it shuts WITHOUT moving focus, so nothing focused is ever hidden
 * under it. Its (?) starts closed (the InfoTip toggletip); everything needed to choose is visible without it.
 */
import { useEffect, useId, useLayoutEffect, useRef, type FocusEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { InfoButton, InfoPanel, useInfoTip } from '../../fit-pair/InfoTip';
import { PICTURE_WORDS } from '../../box-picture/picture-words';

/** Wide enough for the popover beside the picture (the stylesheet's own breakpoint). */
export const WIDE_QUERY = '(min-width: 900px)';
const wide = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(WIDE_QUERY).matches;

/** How the sheet was shut: by the person on purpose (focus goes back to the part) or by leaving it (focus stays). */
export type CloseWay = 'escape' | 'close' | 'left';

export interface PartSheetProps {
  readonly title: string;
  readonly icon: ReactNode;
  /** What the (?) says, one paragraph per line, and the (?)'s name; no (?) without a name. */
  readonly why: readonly string[];
  readonly whyLabel: string | null;
  /** The element the sheet belongs to (the open part), for the popover's place on a wide screen. */
  readonly anchor: () => Element | null;
  /** The box the popover is placed in (the picture's stage). */
  readonly stage: () => HTMLElement | null;
  readonly onClose: (way: CloseWay) => void;
  /** SH-254: false when the guided walk opened it: focus stays on the walk's controls (default: focus to its title). */
  readonly takeFocus?: boolean;
  readonly children?: ReactNode;
}

/**
 * SH-254: controls that open a sheet themselves never shut one by a press or by taking focus: the guided walk's
 * (Walk.tsx) and each problem button (it opens the sheet where it is fixed, also when that sheet is already open; the
 * list around them is not exempt, and focus leaving a problem for elsewhere shuts the sheet: CreatePicture).
 */
const WALK = '[data-walk], [data-problem]';

/** Escape that belongs to something else: an input method composing, or a search field that still holds text. */
function escapeTaken(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing) return true;
  const target = event.target;
  return target instanceof HTMLInputElement && target.type === 'search' && target.value !== '';
}

export function PartSheet({ title, icon, why, whyLabel, anchor, stage, onClose, takeFocus = true, children }: PartSheetProps) {
  const titleId = useId();
  const tip = useInfoTip();
  // SH-255: the (?)'s state for the sheet's Escape, read through a ref so the key and click listeners (SH-254's, with
  // their own start time) are set up once per sheet, never again when the (?) opens or shuts.
  const tipRef = useRef(tip);
  useLayoutEffect(() => { tipRef.current = tip; });
  const ref = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  // Focus moves in once, to the title, when the sheet opens (each part's sheet is a new element: CreatePicture keys it).
  // (Not when the guided walk opened it: the walk's controls keep focus.) The first value is the one that counts.
  const focusFirst = useRef(takeFocus);
  useEffect(() => { if (focusFirst.current) titleRef.current?.focus({ preventScroll: true }); }, []);

  // A popover beside its part on a wide screen; the bottom sheet's place is the stylesheet's. SH-254: the popover never
  // leaves the window. The stylesheet caps its height at the window below the top bar (it scrolls inside itself), and
  // here its top is kept between the top bar and the window's bottom, again whenever it grows (a choice adds rows, a
  // Details opens) or the page scrolls or the window changes.
  useLayoutEffect(() => {
    const sheet = ref.current;
    if (!sheet) return undefined;
    const place = () => {
      const box = stage();
      const part = anchor();
      if (!wide() || !box || !part) { sheet.style.removeProperty('left'); sheet.style.removeProperty('top'); return; }
      const outer = box.getBoundingClientRect();
      const own = part.getBoundingClientRect();
      const width = sheet.offsetWidth;
      const height = sheet.offsetHeight;
      const middle = own.left + own.width / 2 - outer.left;
      let left = middle < outer.width / 2 ? own.right - outer.left + 12 : own.left - outer.left - width - 12;
      left = Math.max(8, Math.min(left, outer.width - width - 8));
      const bar = Number.parseInt(getComputedStyle(sheet).getPropertyValue('--sh-topbar-h'), 10) || 64; // a length in px, not an amount
      const highest = bar + 8;
      const lowest = Math.max(highest, window.innerHeight - height - 8);
      const top = Math.max(highest, Math.min(own.top - 12, lowest)) - outer.top;
      sheet.style.left = `${Math.round(left)}px`;
      sheet.style.top = `${Math.round(top)}px`;
    };
    place();
    const grows = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null;
    grows?.observe(sheet);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, { passive: true });
    return () => {
      grows?.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place);
    };
  }, [anchor, stage]);

  // On a phone: the part stays in sight above the sheet.
  useEffect(() => {
    const sheet = ref.current;
    const part = anchor();
    if (!sheet || !part || wide()) return;
    const bottom = part.getBoundingClientRect().bottom;
    const room = sheet.getBoundingClientRect().top - 12;
    if (bottom > room && typeof window.scrollBy === 'function') window.scrollBy({ top: bottom - room });
  }, [anchor]);

  // Escape shuts it unless something else owns that Escape (an open (?) shuts first: its handler stops the key); a
  // click outside it and off the picture's parts shuts it without moving focus.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || escapeTaken(event)) return;
      event.preventDefault();
      // SH-255: an open (?) shuts first wherever focus is in the sheet (its Close button too), then the sheet.
      const open = tipRef.current;
      if (open.open) { open.setOpen(false); document.getElementById(open.buttonId)?.focus(); return; }
      onClose('escape');
    };
    // SH-254: a click that began before this listener existed is the one that opened the sheet (a problem in the list,
    // whose effects run inside that click in a browser): it never shuts it again.
    const since = performance.now();
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (event.timeStamp < since) return;
      if (!(target instanceof Element) || !target.isConnected || ref.current?.contains(target) || target.closest(`[data-part], ${WALK}`)) return;
      onClose('left');
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onClick);
    };
  }, [onClose]);

  // SH-254: a (?) opened in a scrolled sheet brings its panel into view (below the sticky head: scroll-padding).
  const onPress = (event: ReactMouseEvent<HTMLElement>) => {
    const button = event.target instanceof Element ? event.target.closest('[aria-controls]') : null;
    const panelId = button?.getAttribute('aria-controls');
    if (!button || !panelId) return;
    window.setTimeout(() => {
      const panel = document.getElementById(panelId);
      if (button.getAttribute('aria-expanded') === 'true' && panel && typeof panel.scrollIntoView === 'function') panel.scrollIntoView({ block: 'nearest' });
    }, 0);
  };

  // Focus moving out of the sheet (Tab past its end, a click on another control) shuts it, without moving focus.
  const onBlur = (event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && !event.currentTarget.contains(next) && !(next instanceof Element && next.closest(WALK))) onClose('left');
  };

  return (
    <section ref={ref} className="sh-pic-sheet" role="dialog" aria-modal="false" aria-labelledby={titleId} data-sheet="" onBlur={onBlur} onClick={onPress}>
      <div className="sh-pic-sheet__grab" aria-hidden="true" />
      <div className="sh-pic-sheet__head">
        <span className="sh-pic-sheet__icon" aria-hidden="true">{icon}</span>
        <h2 ref={titleRef} id={titleId} className="sh-pic-sheet__title" tabIndex={-1}>{title}</h2>
        {why.length > 0 && whyLabel ? <InfoButton tip={tip} label={whyLabel} /> : null}
        <button type="button" className="sh-pic-sheet__close" aria-label={PICTURE_WORDS.close} onClick={() => onClose('close')}>
          <span aria-hidden="true">×</span>
        </button>
      </div>
      {why.length > 0 && whyLabel ? <InfoPanel tip={tip}>{why.map((line) => <p key={line}>{line}</p>)}</InfoPanel> : null}
      <div className="sh-pic-sheet__body">{children}</div>
    </section>
  );
}
