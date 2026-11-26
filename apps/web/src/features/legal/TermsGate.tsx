import { CastCharacter } from '@squarehole/design';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { Link, useLocation } from 'react-router';
import { PAGE_TITLE_ID, usePageTitle } from '../../pages/page-parts';
import { requestHeadingFocus } from '../../shell/heading-focus';
import { GATE_FREE_PATHS, TERMS_GATE, TERMS_PATH, TERMS_VERSION } from './terms';
import { TermsAccessContext, type TermsReturnState } from './terms-access';
import { TermsText } from './TermsText';
import { termsAcceptance, useTermsAccepted, type TermsAcceptanceStore } from './terms-acceptance';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Whether a path is one the gate never covers (the full Terms, About & risks, the privacy notice); a trailing slash is the same page. */
export function isGateFree(pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return GATE_FREE_PATHS.includes(path);
}

export interface TermsGateProps {
  children: ReactNode;
  /** Test seam: the acceptance store (production: this browser, current TERMS_VERSION). */
  store?: TermsAcceptanceStore;
}

/**
 * Entry terms gate (F19). Until the current Terms are accepted, every route except the full Terms, About & risks and
 * the privacy notice shows only the gate: the routes below are not rendered at all, so no page, data read or wallet
 * control exists behind it. On the gate-free pages the frame is told (TermsAccessContext) and leaves out its wallet,
 * launch and search controls until acceptance. Accept (after ticking the box) records the version on this device and renders the
 * app; Decline stores nothing and keeps the app closed. Nothing is sent anywhere.
 */
export function TermsGate({ children, store = termsAcceptance }: TermsGateProps) {
  const accepted = useTermsAccepted(store);
  const { pathname, search, hash } = useLocation();
  const blocked = !accepted && !isGateFree(pathname);
  const wasBlocked = useRef(blocked);

  // When the gate gives way (Accept, or its link to the full Terms), the page has just mounted: move focus to its
  // heading so it is announced, as on any page change. A lazy page (the box feed, a box) has no heading yet: focus waits
  // on the main region, and the page takes the request over once it has rendered (shell/heading-focus.ts).
  useEffect(() => {
    if (wasBlocked.current && !blocked) {
      const heading = document.getElementById(PAGE_TITLE_ID);
      if (heading) heading.focus({ preventScroll: true });
      else {
        document.querySelector<HTMLElement>('main')?.focus({ preventScroll: true });
        requestHeadingFocus();
      }
    }
    wasBlocked.current = blocked;
  }, [blocked]);

  if (!blocked) return <TermsAccessContext value={accepted}>{children}</TermsAccessContext>;
  return <TermsDialog from={`${pathname}${search}${hash}`} onAccept={() => store.accept()} />;
}

/** Tab and Shift+Tab stay inside the element (also from a focused non-control such as the title). */
function useDialogFocusTrap(ref: RefObject<HTMLElement | null>) {
  return function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Tab') return;
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    const inside = items.some((item) => item === active);
    if (event.shiftKey && (active === first || !inside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !inside)) {
      event.preventDefault();
      first.focus();
    }
  };
}

/**
 * The gate window. It has no dismiss handler, so Escape does nothing: only Accept opens the app. The heading takes
 * focus when it opens (and after "Review the terms again"); the decline message when declined.
 */
function TermsDialog({ from, onAccept }: { from: string; onAccept: () => void }) {
  usePageTitle('Before you enter');
  const titleId = useId();
  const statusId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const declinedRef = useRef<HTMLParagraphElement>(null);
  const [declined, setDeclined] = useState(false);
  const onKeyDown = useDialogFocusTrap(dialogRef);

  useEffect(() => {
    (declined ? declinedRef.current : headingRef.current)?.focus();
  }, [declined]);

  return (
    <div className="sh-terms-gate">
      <div
        ref={dialogRef}
        className="sh-terms-gate__dialog sh-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={`${statusId} ${descriptionId}`}
        data-state={declined ? 'declined' : 'open'}
        onKeyDown={onKeyDown}
      >
        <GateHeader titleId={titleId} statusId={statusId} headingRef={headingRef} />
        {declined ? (
          <DeclinedNotice id={descriptionId} messageRef={declinedRef} onReview={() => setDeclined(false)} />
        ) : (
          <>
            <GateSummary id={descriptionId} />
            <GateChoice from={from} onDecline={() => setDeclined(true)} onAccept={onAccept} />
          </>
        )}
      </div>
    </div>
  );
}

function GateHeader({ titleId, statusId, headingRef }: { titleId: string; statusId: string; headingRef: RefObject<HTMLHeadingElement | null> }) {
  return (
    <div className="sh-terms-gate__header">
      {/* Decoration: its alt text would be read inside a legal dialog before the heading. */}
      <div className="sh-terms-gate__cast" aria-hidden="true">
        <CastCharacter id="sorter" size={48} caption={false} />
      </div>
      <div>
        <h1 id={titleId} ref={headingRef} tabIndex={-1} className="sh-terms-gate__title">
          {TERMS_GATE.title}
        </h1>
        {/* The draft signal in words (it starts with "Draft"), read as part of the dialog's description. */}
        <p id={statusId} className="sh-terms-gate__status">
          <TermsText text={TERMS_GATE.status} />
        </p>
      </div>
    </div>
  );
}

/**
 * The essentials. The region is always a Tab stop: on short screens it scrolls, and keyboard users need a way to
 * scroll it (axe scrollable-region-focusable). Where it fits, that costs one extra stop (a deliberate trade-off).
 */
function GateSummary({ id }: { id: string }) {
  return (
    <div className="sh-terms-gate__body" role="region" aria-label={TERMS_GATE.summaryLabel ?? 'Summary of the Terms of Use'} tabIndex={0}>
      <p id={id} className="sh-terms-gate__lede">
        {TERMS_GATE.intro}
      </p>
      <ul className="sh-terms-gate__points">
        {/* The same marks as the full Terms: an open placeholder is highlighted, never passed off as final text. */}
        {TERMS_GATE.bullets.map((bullet) => (
          <li key={bullet}>
            <TermsText text={bullet} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Link to the full Terms (carrying the requested page), the agreement box, Decline and Accept. */
function GateChoice({ from, onDecline, onAccept }: { from: string; onDecline: () => void; onAccept: () => void }) {
  const [agreed, setAgreed] = useState(false);
  const state: TermsReturnState = { from };
  return (
    <div className="sh-terms-gate__footer">
      <p className="sh-terms-gate__more">
        <Link to={TERMS_PATH} state={state}>
          {TERMS_GATE.fullTermsLink}
        </Link>{' '}
        <span className="sh-terms-gate__version">Version {TERMS_VERSION}</span>
      </p>
      <label className="sh-terms-gate__check">
        <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.currentTarget.checked)} />
        <span>{TERMS_GATE.checkbox}</span>
      </label>
      <div className="sh-terms-gate__actions">
        <button type="button" className="sh-button" onClick={onDecline}>
          {TERMS_GATE.decline}
        </button>
        <button type="button" className="sh-button sh-button--primary" disabled={!agreed} onClick={onAccept}>
          {TERMS_GATE.accept}
        </button>
      </div>
    </div>
  );
}

function DeclinedNotice({ id, messageRef, onReview }: { id: string; messageRef: RefObject<HTMLParagraphElement | null>; onReview: () => void }) {
  return (
    <>
      <p id={id} ref={messageRef} tabIndex={-1} className="sh-terms-gate__declined">
        {TERMS_GATE.declined}
      </p>
      <div className="sh-terms-gate__actions">
        <button type="button" className="sh-button" onClick={onReview}>
          {TERMS_GATE.reviewAgain}
        </button>
      </div>
    </>
  );
}
