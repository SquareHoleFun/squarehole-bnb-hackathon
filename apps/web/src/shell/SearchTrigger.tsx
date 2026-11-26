import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { usePreferences } from '../features/settings';
import { SearchIcon } from './icons';
import { focusFeedSearch, requestSearchFocus } from './search-focus';

/** Pages whose own search field is on screen: the box feed (the pair feed at `/pairs` is off in every build, F134 R46B). */
const ON_FEED: ReadonlySet<string> = new Set(['/']);

const EDITABLE_INPUT_TYPES: ReadonlySet<string> = new Set([
  'text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'datetime-local', 'month', 'time', 'week',
]);

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && EDITABLE_INPUT_TYPES.has(target.type);
}

/**
 * Header entry point to the one discovery search (02-DESIGN, REFERENCE_OVERRIDES "Two independent search bars"): since
 * the launch set, the box feed's "Search boxes, tokens or a wallet". It holds no query of its own: on a page with its own
 * search field (the box feed) it focuses that field; elsewhere it opens the box feed and
 * focuses it there. The "/" key does the same unless the user is typing in a field, and only while the "/" shortcut is
 * on in Settings (WCAG 2.1.4: a single-character shortcut can be turned off).
 */
export function SearchTrigger() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { searchShortcut } = usePreferences();

  useEffect(() => {
    if (!searchShortcut) return undefined;
    function open() {
      if (focusFeedSearch()) return;
      requestSearchFocus();
      navigate('/');
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== '/' || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditable(event.target)) return;
      event.preventDefault();
      open();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [pathname, navigate, searchShortcut]);

  function onClick() {
    if (focusFeedSearch()) return;
    requestSearchFocus();
    navigate('/');
  }

  // A button, not a look-alike field (REFERENCE_OVERRIDES "Two independent search bars"). On the feed, where the field
  // itself is on screen, it shrinks to the icon and the "/" hint.
  return (
    <button
      type="button"
      className="sh-search-trigger"
      aria-label="Search boxes"
      aria-keyshortcuts={searchShortcut ? '/' : undefined}
      data-on-feed={ON_FEED.has(pathname) ? 'true' : undefined}
      onClick={onClick}
    >
      <SearchIcon />
      <span className="sh-search-trigger__text" aria-hidden="true">
        Search
      </span>
      {searchShortcut ? (
        <kbd className="sh-search-trigger__key" aria-hidden="true">
          /
        </kbd>
      ) : null}
    </button>
  );
}
