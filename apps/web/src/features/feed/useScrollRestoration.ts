import { useEffect, useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigationType } from 'react-router';

/** Scroll position per history entry (react-router location key). In memory: it only serves Back/Forward. */
const positions = new Map<string, number>();
const MAX_ENTRIES = 200;

function remember(key: string, y: number): void {
  positions.delete(key);
  positions.set(key, y);
  if (positions.size > MAX_ENTRIES) {
    const oldest = positions.keys().next().value;
    if (oldest !== undefined) positions.delete(oldest);
  }
}

/** react-router keeps its entry key in `history.state`; the initial entry has none ("default"). */
function currentEntryKey(): string {
  const state: unknown = window.history.state;
  const entryKey = typeof state === 'object' && state !== null ? (state as { key?: unknown }).key : undefined;
  return typeof entryKey === 'string' ? entryKey : 'default';
}

/**
 * Back/Forward restores the feed's scroll position (03-FEED "Back/forward restores scroll and query").
 * BrowserRouter has no ScrollRestoration, and the browser's own restoration runs before the rows re-render, so it
 * is switched to manual while the feed is mounted and the saved position is applied once the results are ready.
 *
 * A position is recorded (1) on scroll while its entry is the browser's current one, (2) on a click or change that
 * may navigate, and (3) when the feed moves to another entry (layout cleanup, before the new entry is laid out).
 * Scroll events arrive a frame late, so (2) and (3) catch a scroll that has not been reported yet; a popstate
 * listener would not, because the router commits the new location inside its own popstate handler.
 */
export function useFeedScrollRestoration(ready: boolean): void {
  const { key } = useLocation();
  const navigationType = useNavigationType();
  const pendingRestore = useRef<string | null>(null);
  const unmounting = useRef(false);

  useEffect(() => {
    const history = window.history;
    const previous = history.scrollRestoration;
    history.scrollRestoration = 'manual';
    return () => {
      history.scrollRestoration = previous;
    };
  }, []);

  // Declared before the recording effect, so on unmount this cleanup runs first: leaving the feed for another page
  // must not record a position clamped by that page's height (the click that navigated already recorded it).
  useLayoutEffect(() => {
    unmounting.current = false;
    return () => {
      unmounting.current = true;
    };
  }, []);

  // A Back/Forward arrival waits for its rows before restoring; until then its saved position is protected.
  useLayoutEffect(() => {
    if (navigationType === 'POP' && positions.has(key)) pendingRestore.current = key;
  }, [key, navigationType]);

  useLayoutEffect(() => {
    if (!ready || pendingRestore.current !== key) return;
    const y = positions.get(key) ?? 0;
    window.scrollTo(0, y);
    // The layout can still settle before this frame is painted: the table/cards choice and the pin accent are
    // measured right after the first commit and may resize content above the saved position (scroll anchoring would
    // then shift it). Apply the position again against the final layout, just before paint.
    if (typeof window.requestAnimationFrame !== 'function') {
      pendingRestore.current = null;
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      if (pendingRestore.current === key) window.scrollTo(0, y);
      pendingRestore.current = null;
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (pendingRestore.current === key) pendingRestore.current = null;
    };
  }, [key, ready]);

  useLayoutEffect(() => {
    if (!positions.has(key)) remember(key, window.scrollY);
    const record = () => {
      if (pendingRestore.current !== key && currentEntryKey() === key) remember(key, window.scrollY);
    };
    window.addEventListener('scroll', record, { passive: true });
    document.addEventListener('click', record, { capture: true });
    document.addEventListener('change', record, { capture: true });
    return () => {
      window.removeEventListener('scroll', record);
      document.removeEventListener('click', record, { capture: true });
      document.removeEventListener('change', record, { capture: true });
      if (!unmounting.current && pendingRestore.current !== key) remember(key, window.scrollY);
    };
  }, [key]);
}
