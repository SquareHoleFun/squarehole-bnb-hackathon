/**
 * What a sighted reader sees at first load, read from jsdom (which lays nothing out): the text of `root` without
 * closed info panels (`[hidden]`), the body of a closed `<details>` (its summary stays) and visually hidden
 * screen-reader text. Text nodes are joined with spaces so words never run together across elements. The browser
 * suite measures the real thing (e2e/fit-pair.spec.ts); this keeps the unit tests honest about the text diet.
 */
export function visibleText(root: Element): string {
  return textWithout(root, '[hidden], .sh-visually-hidden, details:not([open]) > :not(summary)');
}

/**
 * The text a word budget counts: `visibleText` without honesty text (`[data-disclosure]`: Demo badges, the reason a
 * state is not live, a replaced block, the F40 L3 notice, a failed vault read). A budget must never push those out,
 * so they are checked on their own instead.
 */
export function budgetText(root: Element): string {
  return textWithout(root, '[hidden], .sh-visually-hidden, details:not([open]) > :not(summary), [data-disclosure]');
}

function textWithout(root: Element, selector: string): string {
  const clone = root.cloneNode(true) as Element;
  for (const node of clone.querySelectorAll(selector)) node.remove();
  const parts: string[] = [];
  const walker = clone.ownerDocument.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) parts.push(text.textContent ?? '');
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** Tokens with a letter in them (numbers alone do not count as reading). */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter((token) => /[A-Za-z]/.test(token)).length;
}

/** Sentences, counted by their full stops (a decimal point between digits is not one). */
export function sentenceCount(text: string): number {
  return (text.match(/[A-Za-z)][.!?](?=\s|$)/g) ?? []).length;
}
