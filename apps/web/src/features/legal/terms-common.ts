/**
 * What both texts of the Terms share (SH-V2-FE7): the routes, the deep freeze, the restricted-country list and the
 * sentences built from it, the shapes of the gate and the document, and the reading-order walk the tests audit.
 *
 * Two texts exist. The development build shows the counsel draft `terms.ts` describes (draft-5, with the Demo and the
 * test chains); the production build (`SH_BUILD=production`) shows `terms-production.ts`, a DRAFT FOR COUNSEL that
 * describes the product with no Demo. `terms.ts` picks one at build time, so a build ships only its own text. Nothing
 * here holds a sentence of either text except the restricted-country lines, which both use word for word.
 */

/** Where the full Terms live (readable without accepting them). */
export const TERMS_PATH = '/about/terms';
/** Where the privacy notice lives (readable without accepting the Terms). */
export const PRIVACY_PATH = '/about/privacy';
/** Routes the entry gate never covers: the full Terms, About & risks, and the privacy notice. */
export const GATE_FREE_PATHS: readonly string[] = [TERMS_PATH, '/about/risks', PRIVACY_PATH];

/** Freezes an object or array and everything inside it: the Terms are constants, and nothing may edit them. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

export interface RestrictedCountry {
  /** As used in the full Terms, e.g. "the United States". */
  readonly name: string;
  /** As used in the short gate copy, e.g. "the US". */
  readonly short: string;
}

/**
 * Restricted Users by country (§4.2(a) and gate bullet 3). The founder chose StonkFun's list (F19, F30 Q8: "restrictions
 * like StonkFun's, then operate globally"): the US, Canada and the UK, confirmed by self-declaration, with no IP
 * blocking (§4.4). Counsel still has to confirm it. Changing this list is the one-line change; both texts follow it.
 * Sanctioned places and persons (§4.2(b)–(c)) are always restricted and are not part of this list.
 */
export const RESTRICTED_COUNTRIES: readonly RestrictedCountry[] = deepFreeze([
  { name: 'the United States', short: 'the US' },
  { name: 'Canada', short: 'Canada' },
  { name: 'the United Kingdom', short: 'the UK' },
]);

/** "a", "a or b", "a, b or c". */
export function joinOr(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1] ?? ''}`;
}

/** Gate bullet 3 for a restricted-country list. */
export function eligibilityBullet(countries: readonly RestrictedCountry[] = RESTRICTED_COUNTRIES): string {
  const where = countries.length > 0 ? `, anyone in or from ${joinOr(countries.map((country) => country.short))},` : ',';
  return `Not for anyone under 18${where} or anyone sanctioned or in a sanctioned place.`;
}

/** §4.2(a) for a restricted-country list. */
export function restrictedCountryClause(countries: readonly RestrictedCountry[] = RESTRICTED_COUNTRIES): string {
  const decision = '[COUNSEL: confirm this list]';
  if (countries.length === 0) {
    return `(a) is a citizen or resident of, is located in, or uses the Services from, a country we list as restricted, or is organised or based there. No country is listed at present ${decision};`;
  }
  const names = joinOr(countries.map((country) => country.name));
  return `(a) is a citizen or resident of, is located in, or uses the Services from ${names}, or is organised or based there ${decision};`;
}

/** A lettered item of a clause, e.g. "(a) …", optionally with bullets. */
export interface TermsItem {
  readonly text: string;
  readonly bullets?: readonly string[];
}

/** A numbered clause ("5.9"), or an unnumbered paragraph when `n` is absent. */
export interface TermsClause {
  readonly n?: string;
  readonly text: string;
  readonly items?: readonly TermsItem[];
}

export interface TermsSection {
  /** Anchor on the Terms page, e.g. "terms-5". */
  readonly id: string;
  readonly n: string;
  readonly title: string;
  readonly clauses: readonly TermsClause[];
}

/** The entry gate's copy (short on purpose; the full Terms apply). */
export interface TermsGateCopy {
  readonly title: string;
  /** Shown under the title: the draft status in words, not only the "Draft" chip. */
  readonly status: string;
  readonly intro: string;
  readonly bullets: readonly string[];
  readonly fullTermsLink: string;
  /** The accessible name of the gate's summary region (default "Summary of the Terms of Use"). */
  readonly summaryLabel?: string;
  /** The self-declaration (F30 Q8: eligibility is declared by the visitor; there is no IP blocking). */
  readonly checkbox: string;
  readonly decline: string;
  readonly accept: string;
  readonly declined: string;
  readonly reviewAgain: string;
}

/** The full Terms: front matter, sections and the closing line (rendered on `/about/terms`). */
export interface TermsDocumentCopy {
  readonly title: string;
  readonly status: string;
  readonly versionLine: string;
  readonly disputeNotice: string;
  readonly readFirst: { readonly title: string; readonly bullets: readonly string[] };
  readonly sections: readonly TermsSection[];
  readonly closing: string;
}

/** Both texts' items are written as plain lettered strings. */
export const items = (...texts: string[]): TermsItem[] => texts.map((text) => ({ text }));

/** Every sentence-bearing string of a gate and its Terms, in reading order (for audits and tests). */
export function termsTextOf(gate: TermsGateCopy, document: TermsDocumentCopy): string[] {
  const clauseText = (clause: TermsClause): string[] => [
    clause.text,
    ...(clause.items ?? []).flatMap((item) => [item.text, ...(item.bullets ?? [])]),
  ];
  return [
    gate.title,
    gate.status,
    gate.intro,
    ...gate.bullets,
    gate.checkbox,
    gate.declined,
    document.status,
    document.disputeNotice,
    ...document.readFirst.bullets,
    ...document.sections.flatMap((section) => [section.title, ...section.clauses.flatMap(clauseText)]),
    document.closing,
  ];
}

/**
 * A placeholder for a fact the text does not have yet: `[COUNSEL: …]`, `[FOUNDER: …]`, `[ENGINEERING: …]`, or a joint
 * one such as `[FOUNDER + COUNSEL: …]`. The pages mark them; the production check fails while one ships.
 */
/**
 * The one launch fact the production texts do not have yet (F131 R45A: mainnet only; the addresses come with box 0).
 * The production Terms say it in three places, and About & risks stands it in for box 0's address in its list of
 * Square Hole's own boxes (F133) until box 0 is deployed.
 */
export const BOX_0_ADDRESSES = '[FOUNDER: box 0’s mainnet addresses once deployed (counsel pack, Question 1).]';

export const PLACEHOLDER = /\[(?:COUNSEL|FOUNDER|ENGINEERING)\b[^\]]*\]/;

/** A fresh global copy of PLACEHOLDER (a shared `/g` pattern would carry `lastIndex` from one call to the next). */
export const placeholders = (): RegExp => new RegExp(PLACEHOLDER.source, 'g');

/** Every placeholder in some texts, in reading order (duplicates kept: each is a line to fill). */
export const placeholdersIn = (texts: readonly string[]): string[] => texts.flatMap((text) => text.match(placeholders()) ?? []);
