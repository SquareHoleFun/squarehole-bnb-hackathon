/**
 * SH-246 (finding 11.3): a part of a page that loads on its own (the Sepolia alpha's trade slot on a v2 box page, its
 * setup step above every page) and fails, to load or later while it draws, says so in one line with Reload, instead of
 * leaving an empty space. The words hold for both ("hit a problem", as the route level's "This page hit a problem").
 *
 * Reload is a full page load on purpose. React.lazy keeps a part whose script failed failed for the life of the page
 * (it caches the rejected import), and after a site update the old script's name no longer exists on the server, so
 * asking for the same file again cannot help; a new page load asks for the current files. The route-level loader says
 * the same for a whole page (route-error.tsx: "Reload"). While a part still loads normally nothing changes: its Suspense
 * shows nothing, as before. The words are neutral on purpose (no trade word): this module ships in every build.
 */
import { Component, useEffect, useRef, type ReactNode } from 'react';

/** The words, one place (SH-246 proposals for the founder; docs/evidence/SH-246.md). */
export const PART_WORDS = Object.freeze({
  /** A part of the page (the trade slot) failed to load or to draw. */
  part: 'This part of the page hit a problem.',
  /** The button: a full page load. */
  reload: 'Reload',
});

export interface PartFailedProps {
  /** The one line: what hit a problem. */
  readonly line: string;
  /** Test seam: what Reload does (a full page load otherwise). */
  readonly onReload?: () => void;
}

const reloadPage = () => window.location.reload();

/**
 * SH-246 (review L2): a polite live line that is on the page before its words. A status region inserted already filled
 * is skipped by several screen readers; this one mounts empty and takes its text right after (an effect), so the text
 * arrives as a change in a region that exists. Controls stay outside it, so a button's name is not read as the news.
 */
export function LiveLine({ text, className }: { readonly text: string; readonly className?: string }) {
  const region = useRef<HTMLParagraphElement>(null);
  // The words go into the region after it is on the page (React renders it empty and leaves its text to this effect).
  useEffect(() => {
    // Only a change: a second run of the effect (React's development double run) announces nothing twice.
    if (region.current && region.current.textContent !== text) region.current.textContent = text;
  }, [text]);
  return <p ref={region} role="status" className={className} />;
}

/** The line and Reload, in a panel where the part would have been. */
export function PartFailed({ line, onReload = reloadPage }: PartFailedProps) {
  return (
    <div className="sh-panel sh-part-failed" data-part="failed">
      <LiveLine text={line} />
      <button type="button" className="sh-button" onClick={onReload}>
        {PART_WORDS.reload}
      </button>
    </div>
  );
}

interface BoundaryProps {
  /** What shows once the part failed to load (or to render). */
  readonly fallback: ReactNode;
  readonly children: ReactNode;
}

/**
 * Catches a part that failed: its script did not load (a lazy import that rejected) or it threw while rendering. The
 * page around it stays. React reports the error to the console itself.
 */
export class PartBoundary extends Component<BoundaryProps, { readonly failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
