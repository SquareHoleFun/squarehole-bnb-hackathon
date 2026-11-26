import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronRightIcon, InfoIcon } from '../pair/pair-icons';

/**
 * An info button and the panel it opens (a "toggletip"): the page's explanations live here so a first look reads only
 * numbers, labels and states (founder, 2026-10-01: "minimal amount of reading required"). The panel is inline, right
 * after the card head, so it never covers anything, never scrolls sideways on a phone and needs no positioning.
 *
 * Keyboard and touch: a native button (Enter, Space, tap) with `aria-expanded` and `aria-controls`; Escape on the
 * button or inside the panel closes it and returns focus to the button. The closed panel is `hidden`, so it is not
 * read, not focusable and not counted as visible text; its words stay in the DOM for find-in-page and tests. Nothing
 * essential lives only here: every state (phase, freshness, closed, unverified, stale) is also on the card itself.
 */
export interface InfoTipState {
  readonly open: boolean;
  readonly buttonId: string;
  readonly panelId: string;
  readonly setOpen: (open: boolean) => void;
}

export function useInfoTip(): InfoTipState {
  const base = useId();
  const [open, setOpen] = useState(false);
  return { open, buttonId: `${base}-info`, panelId: `${base}-panel`, setOpen };
}

/** Escape closes the panel and puts focus back on its button (the event runs after render, so the lookup is safe). */
function closeOnEscape(open: boolean, setOpen: (open: boolean) => void, buttonId: string) {
  return (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || !open) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    document.getElementById(buttonId)?.focus();
  };
}

/** The (i) button. `label` names what it explains ("About the bonding curve"); it never names a trade action. */
export function InfoButton({ tip, label }: { tip: InfoTipState; label: string }) {
  const { open, setOpen, buttonId, panelId } = tip;
  return (
    <button
      type="button"
      id={buttonId}
      className="sh-info-button"
      aria-label={label}
      aria-expanded={open}
      aria-controls={panelId}
      onClick={() => setOpen(!open)}
      onKeyDown={closeOnEscape(open, setOpen, buttonId)}
    >
      <InfoIcon />
    </button>
  );
}

/** The explanation the button opens. Placed right after the element that holds the button, in reading order. */
export function InfoPanel({ tip, children }: { tip: InfoTipState; children: ReactNode }) {
  const { open, setOpen, buttonId, panelId } = tip;
  return (
    <div id={panelId} className="sh-info-panel" hidden={!open} onKeyDown={closeOnEscape(open, setOpen, buttonId)}>
      {children}
    </div>
  );
}

/**
 * "Details" (SH-ALCHEMIST-LESS-TEXT; founder, 2026-10-27: "We can make buttons for people that want to see the details,
 * but that should never be the default."): a text button with a chevron, and right after it the panel it opens, for
 * the rules, routes, limits and risk lines a normal user does not need to act. The (i) button's state, ids and Escape
 * rule (`useInfoTip`): a native button (Enter, Space, tap) with `aria-expanded` and `aria-controls`; Escape on it or in
 * the panel closes the panel and puts focus back on it; the closed panel is `hidden`. It starts closed on every mount
 * and nothing stores it, so every page load shows the short view. `label` is the visible name ("Details", or a panel's
 * own, "Pile details"); `name` says what it opens: the accessible name is then "<label>: <name>" ("Details: Alchemist,
 * buyers’ fees"), starting with the visible label, and it never repeats a nearby control's name ("The Alchemist" is its
 * chip's), so each control keeps one clear name. The button keeps its place and size when it opens: only the panel adds
 * height, below it. Never put an action button in the panel.
 */
export function Details({ label = 'Details', name, children }: { label?: string; name?: string; children: ReactNode }) {
  const { open, setOpen, buttonId, panelId } = useInfoTip();
  return (
    <div className="sh-details">
      <button type="button" id={buttonId} className="sh-details__button" aria-label={name ? `${label}: ${name}` : undefined} aria-expanded={open} aria-controls={panelId}
        onClick={() => setOpen(!open)} onKeyDown={closeOnEscape(open, setOpen, buttonId)}>
        <span className="sh-details__chevron" aria-hidden="true"><ChevronRightIcon /></span>
        {label}
      </button>
      <div id={panelId} className="sh-details__panel" hidden={!open} onKeyDown={closeOnEscape(open, setOpen, buttonId)}>
        {children}
      </div>
    </div>
  );
}
