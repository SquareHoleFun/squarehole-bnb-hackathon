/**
 * The header "Search boxes" trigger and the box feed's one search field (02-DESIGN "exactly one primary discovery
 * search"). The trigger never holds a query: it focuses the feed field, navigating to the feed first when needed.
 * A navigation-triggered focus request is a one-shot flag consumed by the Shell's route-change focus handling,
 * so it never lingers in history state.
 */
export const FEED_SEARCH_ID = 'feed-search';

let pending = false;

export function requestSearchFocus(): void {
  pending = true;
}

/** Whether the header's "Search boxes" asked for the field and it has not been focused yet. */
export function searchFocusPending(): boolean {
  return pending;
}

/** True once per request. */
export function consumeSearchFocusRequest(): boolean {
  const requested = pending;
  pending = false;
  return requested;
}

/**
 * Focuses the search field for a pending request, consuming the request only when the field was there. The box feed
 * is a lazy page: when the Shell's route-change handling runs before the page has loaded, the page itself honours the
 * request once it mounts.
 */
export function focusSearchIfRequested(): boolean {
  if (!pending || !focusFeedSearch()) return false;
  pending = false;
  return true;
}

/** Focuses (and selects) the feed search field if it is on the page. */
export function focusFeedSearch(): boolean {
  const input = document.getElementById(FEED_SEARCH_ID);
  if (!(input instanceof HTMLInputElement)) return false;
  input.focus();
  input.select();
  return true;
}
