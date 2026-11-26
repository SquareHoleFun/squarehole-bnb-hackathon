/**
 * SH-ALCHEMIST-LESS-TEXT: the words a reader sees in `root` while no panel is open, as far as a unit test can tell without
 * a layout: each element's own text (its direct text nodes, joined), in document order. It leaves out everything inside
 * a `hidden` element (a closed Details panel), inside a closed `<details>` other than its summary, and in a visually
 * hidden label. The browser specs measure the rendered page (e2e/alchemist-site.ts `readingLoad`).
 */
export function shownText(root: Element): string[] {
  const out: string[] = [];
  for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
    if (element.closest('[hidden], .sh-visually-hidden')) continue;
    const details = element.closest('details');
    if (details && !details.open && !element.closest('summary')) continue;
    const own = Array.from(element.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent ?? '').join('').replace(/\s+/g, ' ').trim();
    if (own) out.push(own);
  }
  return out;
}

/** Whether `element` is out of sight while its panels are closed: inside a `hidden` element or a closed `<details>`. */
export function tucked(element: Element): boolean {
  const details = element.closest('details');
  return element.closest('[hidden]') !== null || (details !== null && !details.open && element.closest('summary') === null);
}
