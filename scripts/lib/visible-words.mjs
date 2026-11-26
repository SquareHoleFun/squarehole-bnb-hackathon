// Shared by scripts/measure-visible-words.mjs and the browser suites (apps/web/e2e/box-create.spec.ts): the words a
// reader sees, counted the same way everywhere (text-diet evidence; box creation flow acceptance 3).
// `collectWords` runs IN THE PAGE (pass it to page.evaluate); `summarise` runs in Node.

/** Runs in the page: every rendered word, with whether it intersects the first viewport and whether it is in <main>. */
export function collectWords() {
  const hiddenBySrOnly = (element) => {
    for (let node = element; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      if (rect.width <= 1 && rect.height <= 1 && (style.overflow === 'hidden' || style.clipPath !== 'none' || style.clip !== 'auto')) return true;
    }
    return false;
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const words = [];
  const lines = [];
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const parent = text.parentElement;
    if (!parent || !text.data.trim()) continue;
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(parent.tagName)) continue;
    if (!parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) continue;
    if (hiddenBySrOnly(parent)) continue;
    const inMain = Boolean(parent.closest('main'));
    let seen = false;
    for (const match of text.data.matchAll(/\S+/g)) {
      const range = document.createRange();
      range.setStart(text, match.index);
      range.setEnd(text, match.index + match[0].length);
      const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
      if (rects.length === 0) continue;
      const top = Math.min(...rects.map((rect) => rect.top)) + window.scrollY;
      const bottom = Math.max(...rects.map((rect) => rect.bottom)) + window.scrollY;
      const left = Math.min(...rects.map((rect) => rect.left));
      const right = Math.max(...rects.map((rect) => rect.right));
      // Off-canvas text (a skip link parked above the page) is not seen.
      if (bottom <= 0 || right <= 0) continue;
      const inViewport = top < window.innerHeight && bottom > 0 && left < window.innerWidth;
      words.push({ token: match[0], inViewport, inMain });
      seen = true;
    }
    if (seen) lines.push(text.data.trim().replace(/\s+/g, ' '));
  }
  return { words, lines };
}

export const isWord = (token) => /[A-Za-z]/.test(token);
export const isNumber = (token) => !isWord(token) && /\d/.test(token);

export function summarise(words) {
  const count = (filter) => {
    const list = words.filter(filter);
    return { words: list.filter((w) => isWord(w.token)).length, numbers: list.filter((w) => isNumber(w.token)).length };
  };
  return {
    viewport: count((w) => w.inViewport),
    viewportMain: count((w) => w.inViewport && w.inMain),
    page: count(() => true),
    pageMain: count((w) => w.inMain),
  };
}
