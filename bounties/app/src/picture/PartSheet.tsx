/**
 * SH-281: a part's fields, opened in place: a bottom sheet on a phone, a popover beside the part on a wide screen.
 * Copied from the platform (apps/web/src/features/create/picture/PartSheet.tsx at main b8fbcef9) without its (?) and
 * its guided walk: a non-modal dialog; when it opens, focus moves to its title; Escape or Close shut it and the page
 * puts focus back on the part; focus or a click leaving it (and the picture's parts) shuts it without moving focus.
 */
import { useEffect, useId, useLayoutEffect, useRef, type FocusEvent, type ReactNode } from 'react';
import { WORDS } from './launch-picture';

export const WIDE_QUERY = '(min-width: 900px)';
const wide = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(WIDE_QUERY).matches;

export type CloseWay = 'escape' | 'close' | 'left';

export interface PartSheetProps {
  readonly title: string;
  readonly icon: ReactNode;
  readonly anchor: () => Element | null;
  readonly stage: () => HTMLElement | null;
  readonly onClose: (way: CloseWay) => void;
  readonly children?: ReactNode;
}

/** Escape that belongs to something else: an input method composing. */
const escapeTaken = (event: KeyboardEvent): boolean => event.defaultPrevented || event.isComposing;

export function PartSheet({ title, icon, anchor, stage, onClose, children }: PartSheetProps) {
  const titleId = useId();
  const ref = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);

  // A popover beside its part on a wide screen, kept inside the window; the bottom sheet's place is the stylesheet's.
  useLayoutEffect(() => {
    const sheet = ref.current;
    if (!sheet) return undefined;
    const place = () => {
      const box = stage();
      const part = anchor();
      if (!wide() || !box || !part) {
        sheet.style.removeProperty('left');
        sheet.style.removeProperty('top');
        return;
      }
      const outer = box.getBoundingClientRect();
      const own = part.getBoundingClientRect();
      const width = sheet.offsetWidth;
      const height = sheet.offsetHeight;
      const middle = own.left + own.width / 2 - outer.left;
      let left = middle < outer.width / 2 ? own.right - outer.left + 12 : own.left - outer.left - width - 12;
      left = Math.max(8, Math.min(left, outer.width - width - 8));
      const bar = 72;
      const lowest = Math.max(bar, window.innerHeight - height - 8);
      const top = Math.max(bar, Math.min(own.top - 12, lowest)) - outer.top;
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || escapeTaken(event)) return;
      event.preventDefault();
      onClose('escape');
    };
    const since = performance.now();
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (event.timeStamp < since) return;
      if (!(target instanceof Element) || !target.isConnected || ref.current?.contains(target) || target.closest('[data-part], [data-problem]')) return;
      onClose('left');
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onClick);
    };
  }, [onClose]);

  const onBlur = (event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && !event.currentTarget.contains(next) && !(next instanceof Element && next.closest('[data-problem]'))) onClose('left');
  };

  return (
    <section ref={ref} className="sh-pic-sheet" role="dialog" aria-modal="false" aria-labelledby={titleId} data-sheet="" onBlur={onBlur} data-testid="part-sheet">
      <div className="sh-pic-sheet__grab" aria-hidden="true" />
      <div className="sh-pic-sheet__head">
        <span className="sh-pic-sheet__icon" aria-hidden="true">
          {icon}
        </span>
        <h2 ref={titleRef} id={titleId} className="sh-pic-sheet__title" tabIndex={-1}>
          {title}
        </h2>
        <button type="button" className="sh-pic-sheet__close" aria-label={WORDS.close} onClick={() => onClose('close')} data-testid="part-close">
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <div className="sh-pic-sheet__body">{children}</div>
    </section>
  );
}
