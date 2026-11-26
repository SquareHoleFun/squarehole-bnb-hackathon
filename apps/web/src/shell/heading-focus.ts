/**
 * Focus after a client-side page change (WCAG 2.4.3): the Shell moves focus to the new page's heading so it is
 * announced. A lazy page (the box pages, the FIT pair page) is not there yet when the Shell's route-change effect runs
 * (its Suspense fallback is on screen), so the Shell leaves a one-shot request that the page's boundary consumes once
 * the page has rendered (`lazyRoute`). A pending search-focus request (the header's "Search boxes") wins over it.
 */
import { PAGE_TITLE_ID } from '../pages/page-parts';
import { FEED_SEARCH_ID, searchFocusPending } from './search-focus';

let pending = false;

/** The heading was not on the page yet: focus it once it is. */
export function requestHeadingFocus(): void {
  pending = true;
}

/** A new navigation starts over: an older request never moves focus on a later page. */
export function cancelHeadingFocus(): void {
  pending = false;
}

/**
 * Honours a pending request: focuses the page heading when it is there, without scrolling, unless the search field has
 * (or is about to get) focus. True when the request was consumed.
 */
export function focusHeadingIfRequested(): boolean {
  if (!pending) return false;
  if (searchFocusPending() || document.activeElement?.id === FEED_SEARCH_ID) {
    pending = false;
    return false;
  }
  const heading = document.getElementById(PAGE_TITLE_ID);
  if (!heading) return false;
  pending = false;
  heading.focus({ preventScroll: true });
  return true;
}
