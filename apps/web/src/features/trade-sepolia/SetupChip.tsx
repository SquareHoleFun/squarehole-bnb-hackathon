/**
 * F166 af2 (SH-ALPHA-ONBOARDING; the founder, 2026-11-01: "The onboarding flow on automatic should handle all that in
 * parallel while the user can investigate the page and the boxes"): "Set me up" runs in the background after its one
 * press, and this chip in the app's top bar is where it shows: the run's four ticks, tiny, on every page, while the
 * person browses. A tap opens its details (SetupPanel.tsx: the ticks with their names, the line, Try again after a stop,
 * Close, the test-coin page at the end); nothing opens by itself. After a reload mid-run it offers "Finish setup" in
 * those details (one press: a run never resumes by itself). Its end is said once in a short toast with the numbers
 * (`SetupToast`), and its stop on the chip itself.
 *
 * Its presses are armed a moment after it appears (`ARM_MS`), as the welcome sheet's are: it comes late into the bar,
 * and a tap meant for what stood there before opens nothing. The chip only ever opens its details; every step still
 * needs the press inside them ("Finish setup", "Try again"), which a wallet's own open window greys (SetupPanel.tsx).
 */
import { useEffect, useId, useRef, useState } from 'react';
import { SETUP_WORDS } from '../alpha-sepolia/alpha-words';
import { pAmountV2 } from '../core/v2/stats-v2';
import { ARM_MS, SetupPanel, markOf, type SetupPanelProps } from './SetupPanel';
import { SETUP_STEPS, useSetupState, type SetupState } from './setup-run';

/** How long the end's toast stays (its words stay in the chip's details afterwards). */
export const TOAST_MS = 8_000;

export interface SetupChipProps extends Pick<SetupPanelProps, 'api' | 'loadPrivy' | 'appId' | 'target' | 'timing' | 'onManual' | 'manualHref' | 'onClose'> {
  /** With no run of this visit: the offer its details hold ("Finish setup" after a setup this device left midway). */
  readonly offer: 'finish' | null;
  /** "Not now", in the details of an offer: the chip put away for this visit. */
  readonly onNotNow: () => void;
}

/** The chip's few words for where the run stands (the details hold the rest). */
export function chipWords(setup: Pick<SetupState, 'phase'>): string {
  if (setup.phase === 'running') return SETUP_WORDS.chipRunning;
  if (setup.phase === 'stopped') return SETUP_WORDS.chipStopped;
  if (setup.phase === 'test') return SETUP_WORDS.chipTest;
  if (setup.phase === 'done') return SETUP_WORDS.chipDone;
  return SETUP_WORDS.finish;
}

/** The end's toast, numbers first: "You're set: 0.05 SepETH · 1 tETH" (the run's own read), or test mode's line. */
export function toastWords(setup: Pick<SetupState, 'phase' | 'figures'>): string | null {
  if (setup.phase === 'test') return SETUP_WORDS.testMode;
  if (setup.phase !== 'done') return null;
  if (setup.figures === null) return SETUP_WORDS.done;
  return `${SETUP_WORDS.chipDone}: ${pAmountV2(setup.figures.sepEth, 18)} ${SETUP_WORDS.sepEth} · ${pAmountV2(setup.figures.teth, 18)} ${SETUP_WORDS.teth}`;
}

export function SetupChip({ offer, onNotNow, onClose, ...panel }: SetupChipProps) {
  const setup = useSetupState();
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), ARM_MS);
    // The press that started the run took its button away (the welcome sheet's): the keyboard comes here.
    if (document.activeElement === null || document.activeElement === document.body) button.current?.focus({ preventScroll: true });
    return () => clearTimeout(timer);
  }, []);

  // Open details close on Escape (the focus back on the chip) and on a press anywhere else.
  useEffect(() => {
    if (!open) return undefined;
    const away = (event: PointerEvent) => {
      if (root.current && event.target instanceof Node && !root.current.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const marks = SETUP_STEPS.map((step) => markOf(step, setup));
  const words = setup.phase === 'idle' && offer === null ? null : chipWords(setup);
  if (words === null) return null;
  const done = setup.done.length;
  // A stop is said once as it happens (the end's toast says a done run, and test mode).
  const said = setup.phase === 'stopped' ? setup.line : null;
  return (
    <span ref={root} className="sh-setup-chip" data-phase={setup.phase}>
      <button ref={button} type="button" className="sh-setup-chip__button" aria-expanded={open} aria-controls={open ? panelId : undefined}
        aria-disabled={!armed || undefined} onClick={() => { if (armed) setOpen(!open); }}>
        <span className="sh-setup-chip__ticks" aria-hidden="true">
          {marks.map((mark, index) => <span key={SETUP_STEPS[index]} className="sh-setup-chip__tick" data-mark={mark} />)}
        </span>
        <span className="sh-setup-chip__text" aria-hidden="true">{words}</span>
        <span className="sh-visually-hidden">{`${SETUP_WORDS.chipName}: ${words}${setup.phase === 'idle' ? '' : `, ${done} ${SETUP_WORDS.ofFour}`}`}</span>
      </button>
      <span className="sh-visually-hidden" role="status">{said}</span>
      {open ? (
        <div id={panelId} className="sh-panel sh-setup-chip__panel" role="group" aria-label={SETUP_WORDS.title}>
          <SetupPanel {...panel} offer={offer ?? 'finish'} coinsLink onNotNow={setup.phase === 'idle' ? onNotNow : null}
            onClose={() => { setOpen(false); onClose(); }} />
        </div>
      ) : null}
    </span>
  );
}

/** The end, said once: a short line with a way to put it away; it goes by itself after `TOAST_MS`. */
export function SetupToast({ text, onDone }: { readonly text: string; readonly onDone: () => void }) {
  const done = useRef(onDone);
  useEffect(() => { done.current = onDone; });
  useEffect(() => {
    const timer = setTimeout(() => done.current(), TOAST_MS);
    return () => clearTimeout(timer);
  }, [text]);
  return (
    <div className="sh-panel sh-setup-toast">
      <p className="sh-setup-toast__text">{text}</p>
      <button type="button" className="sh-setup-toast__close" onClick={() => done.current()}>
        <span aria-hidden="true">×</span>
        <span className="sh-visually-hidden">{SETUP_WORDS.dismiss}</span>
      </button>
    </div>
  );
}
