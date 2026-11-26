/**
 * The copy wording rule (F19; F23 "use safe wording everywhere"; core v2 C21; SEC Division of Corporation Finance staff
 * FAQ, 25 Sept 2026, Q2.5): burns, buybacks and fee shares are described as mechanics, never as yield, return, price
 * increases or value for holders. Holding is never framed as earning.
 *
 * The check works per clause: text between `.`, `!`, `?`, `:` or `;`, and a new clause after "but". A clause that names
 * a return-like outcome passes only when a negation comes before that word in the same clause ("They are not interest,
 * a dividend or a return"). A negation elsewhere does not count ("No fees: burns grow your yield" fails). Plain loss
 * statements ("can lose all of its value") are allowed. It is a tripwire for wording, not a legal review.
 */

/** Every return-like word, including the benefit words "earn" and "rewards" (the Terms and About & risks use neither). */
export const RETURN_FRAMING =
  /\b(yield\w*|profit\w*|income|dividends?|interest|returns?|price (?:rise|support|floor)|flywheel|grow\w*|gains?|apprec\w*|increase\w*|rise[sn]?|accru\w*|backed|backing|earn\w*|rewards?|value|upside|APY|APR)\b/i;

/**
 * One pattern, no `i` flag: the words match in any letter case, the acronyms only in capitals ("Apr" is a month in a
 * rendered date, "APR" a rate). A letter after a backslash (`\w`, `\b`) is left alone.
 */
export function framingPattern(words: readonly string[], acronyms: readonly string[]): RegExp {
  const anyCase = (source: string) => source.replace(/(?<!\\)[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`);
  return new RegExp(`\\b(${[...words.map(anyCase), ...acronyms].join('|')})\\b`);
}

/**
 * The check for all app copy (F23): every page, label, button, status text and accessible name, and the package copy
 * the app shows (claim and launch messages, demo fixture descriptions). Say "FIT holders", "fee share credited to
 * holders", "claimable", "Misfit owners outside the vault"; the page for claims is called Claims.
 *
 * It is RETURN_FRAMING with two plain uses left out: "value" as a valuation ("Demo value", "No USD value"), and
 * "return" as a verb or a vault action ("what the provider returns", a return quote). "Return on", "holder returns"
 * and ROI still count, and so do the slogans "to the moon" and "number go up".
 */
export const APP_COPY_FRAMING = framingPattern(
  [
    'yield\\w*',
    'profit\\w*',
    'income',
    'dividends?',
    'interest',
    'returns? on',
    '(?:investment|financial|holder|passive) returns?',
    'price (?:rise|support|floor)',
    'flywheel',
    'grow\\w*',
    'gains?',
    'apprec\\w*',
    'increase\\w*',
    'rise(?:s|n)?',
    'accru\\w*',
    'backed',
    'backing',
    'earn\\w*',
    'rewards?',
    'upside',
    'to the moon',
    'number go up',
  ],
  ['APY', 'APR', 'ROI'],
);

const NEGATION = /\b(not|no|nothing|never|none|nobody|neither|nor|cannot)\b|n[’']t\b/i;
const LOSS_STATEMENT = /\blose all of (?:its|their|your) value\b/gi;
const CLAUSE_BREAK = /(?<=[.!?:;])\s+|,?\s+\bbut\b\s+/;

/** Clauses that name a return-like outcome without a negation before it (empty when the copy follows the rule). */
export function unnegatedReturnFraming(texts: readonly string[], pattern: RegExp = RETURN_FRAMING): string[] {
  const found: string[] = [];
  for (const text of texts) {
    for (const clause of text.split(CLAUSE_BREAK)) {
      const checked = clause.replace(LOSS_STATEMENT, '');
      const match = pattern.exec(checked);
      if (match && !NEGATION.test(checked.slice(0, match.index))) found.push(clause.trim());
    }
  }
  return found;
}

/**
 * Words app copy never uses, not even after a negation (the rule e2e/wording-audit.spec.ts restates): holding is never
 * framed as earning, rewards or accrual, and no rate acronym appears. Without this, any negation earlier in the same
 * clause would excuse them ("No lock-up, holders earn 12% APY" names "No" before "earn"). The other words of
 * APP_COPY_FRAMING keep the negation rule, which the legal disclaimers need ("No yield, price floor or growth is …").
 */
export const APP_COPY_NEVER = framingPattern(['earn\\w*', 'rewards?', 'accru\\w*', 'passive income', 'to the moon', 'number go up'], ['APY', 'APR', 'ROI']);

/** The app copy check (F23): clauses with a never-used word, or with other return framing and no negation before it. */
export function appCopyFraming(texts: readonly string[]): string[] {
  return texts.flatMap((text) =>
    text
      .split(CLAUSE_BREAK)
      .filter((clause) => APP_COPY_NEVER.test(clause) || unnegatedReturnFraming([clause], APP_COPY_FRAMING).length > 0)
      .map((clause) => clause.trim()),
  );
}

/** Elements whose text is read as one block of copy (a heading, a paragraph, a list item, a control, a cell…). */
const COPY_BLOCKS = 'h1, h2, h3, h4, h5, h6, p, li, dt, dd, th, td, caption, legend, label, summary, button, a, option, figcaption';
/** Attributes whose value is copy: accessible names and descriptions, tooltips, placeholders, alt text. */
const COPY_ATTRIBUTES = ['aria-label', 'aria-description', 'aria-roledescription', 'aria-valuetext', 'title', 'placeholder', 'alt'] as const;

const tidy = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * The text of each block of rendered copy (headings, paragraphs, list items, terms, cells, controls and links), then the
 * copy held in attributes (accessible names, titles, placeholders, alt text), for the check above.
 */
export function renderedCopy(root: ParentNode): string[] {
  const blocks = Array.from(root.querySelectorAll(COPY_BLOCKS), (element) => tidy(element.textContent ?? ''));
  const attributes = Array.from(root.querySelectorAll(COPY_ATTRIBUTES.map((name) => `[${name}]`).join(', ')), (element) =>
    COPY_ATTRIBUTES.map((name) => tidy(element.getAttribute(name) ?? '')),
  ).flat();
  return [...blocks, ...attributes].filter((text) => text.length > 0);
}
