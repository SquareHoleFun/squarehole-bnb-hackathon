/**
 * SH-SITE-FIXES-10: a link to a page's section (`/about/terms#terms-6`) lands on that section. The browser scrolls to a
 * fragment only while the document parses, before this app has rendered the section, and the Shell's page change
 * scrolled to the top; so the Shell brings the section into view itself once the page has rendered: on arrival by a
 * link, on a direct load or reload, and on a link to another section of the same page. Back and Forward keep the
 * browser's own scroll restoration. Its heading takes focus, as a new page's heading does (heading-focus.ts).
 */

/** The element a location's hash names (`#terms-6`) on the page now, or null. */
export function hashTarget(hash: string): HTMLElement | null {
  if (hash.length < 2 || !hash.startsWith('#')) return null;
  let id: string;
  try {
    id = decodeURIComponent(hash.slice(1));
  } catch {
    return null;
  }
  return document.getElementById(id);
}

/**
 * Scrolls `target` to the top of the view (its own `scroll-margin-top` keeps it below the sticky top bar) and moves
 * focus to its heading, or to itself, without scrolling again.
 */
export function goToSection(target: HTMLElement): void {
  target.scrollIntoView({ block: 'start' });
  const focusable = target.matches('h1, h2, h3, h4') ? target : (target.querySelector<HTMLElement>('h1, h2, h3, h4') ?? target);
  if (!focusable.hasAttribute('tabindex')) focusable.setAttribute('tabindex', '-1');
  focusable.focus({ preventScroll: true });
}
