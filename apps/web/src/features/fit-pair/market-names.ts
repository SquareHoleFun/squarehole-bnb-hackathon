/**
 * The names the pair page uses for a market's token, collection, items and placeholders (v2 T19; F30 Q2).
 *
 * A record without `names` is the launch itself: FIT, The Misfits, a Misfit. A record WITH `names` is a rehearsal
 * deployed with a neutral set (the full v2 system on Sepolia: "Rehearsal Token 2" / RHT2, "Rehearsal Collection" /
 * RHC, "Rehearsal placeholder" / RHC-P, docs/v2/sepolia-full.md): the page then shows exactly the names the contracts
 * carry, so what a wallet or an explorer shows for the copied address is what the page says. Its items are "items".
 *
 * Neutral names must stay neutral: like the contracts' own check (test/v2/names/PublicNames.t.sol), a neutral name or
 * symbol that hints at the launch (fit, misfit, square, hole, stonk, sorter) is refused, and so is anything that could
 * carry markup or control characters. Identity never comes from names: the page keys everything on addresses.
 */
export interface FitMarketNames {
  readonly kind: 'launch' | 'neutral';
  /** The token's `name()`: "FIT", "Rehearsal Token 2". */
  readonly tokenName: string;
  /** Its `symbol()`, the unit of every amount on the page: "FIT", "RHT2". */
  readonly tokenSymbol: string;
  /** The collection in headings: "The Misfits", "Rehearsal Collection". */
  readonly collectionName: string;
  readonly collectionSymbol: string;
  readonly placeholderName: string;
  readonly placeholderSymbol: string;
  /** One piece of the collection in running text: "Misfit" / "item". */
  readonly item: string;
  readonly items: string;
}

// SH-258 round 3: a BNB build has no box 0 market; the launch's names fold away there (empty, never shown).
export const LAUNCH_NAMES: FitMarketNames = import.meta.env?.SH_BNB === true
  ? Object.freeze({ kind: 'launch', tokenName: '', tokenSymbol: '', collectionName: '', collectionSymbol: '', placeholderName: '', placeholderSymbol: '', item: '', items: '' })
  : Object.freeze({
  kind: 'launch',
  tokenName: 'FIT',
  tokenSymbol: 'FIT',
  collectionName: 'The Misfits',
  collectionSymbol: 'MISFITS',
  placeholderName: 'Misfit placeholder',
  placeholderSymbol: 'MISFIT-P',
  item: 'Misfit',
  items: 'Misfits',
});

/** Words a neutral name must not contain (the contracts' PublicNames check uses the same list). */
// "fit" already matches every word with "misfit" in it (SH-258 round 3: the same test, one word fewer).
export const LAUNCH_HINTS = /fit|square|hole|stonk|sorter/i;
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f<>‎‏‪-‮⁦-⁩]/u;

function plain(value: unknown, max: number, what: string, fail: (message: string) => Error): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > max || UNSAFE.test(value)) {
    throw fail(`${what} must be plain text of 1 to ${max} characters`);
  }
  if (LAUNCH_HINTS.test(value)) throw fail(`${what} must stay neutral (no launch name in a rehearsal's names)`);
  return value;
}

function pair(value: unknown, what: string, fail: (message: string) => Error): { readonly name: string; readonly symbol: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw fail(`${what} must be an object with name and symbol`);
  const entry = value as Record<string, unknown>;
  return { name: plain(entry.name, 48, `${what}.name`, fail), symbol: plain(entry.symbol, 12, `${what}.symbol`, fail) };
}

/** `names` of a record: absent → the launch's names; present → a neutral set, checked. Throws through `fail`. */
export function parseMarketNames(value: unknown, fail: (message: string) => Error): FitMarketNames {
  if (value === undefined || value === null) return LAUNCH_NAMES;
  if (typeof value !== 'object' || Array.isArray(value)) throw fail('names must be an object');
  const names = value as Record<string, unknown>;
  const token = pair(names.token, 'names.token', fail);
  const collection = pair(names.collection, 'names.collection', fail);
  const placeholder = pair(names.placeholder, 'names.placeholder', fail);
  return Object.freeze({
    kind: 'neutral',
    tokenName: token.name,
    tokenSymbol: token.symbol,
    collectionName: collection.name,
    collectionSymbol: collection.symbol,
    placeholderName: placeholder.name,
    placeholderSymbol: placeholder.symbol,
    item: 'item',
    items: 'items',
  });
}

/** "Misfits" → "Misfits", "items" → "Items". */
export function capitalized(word: string): string {
  return word.length === 0 ? word : `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`;
}

/** "a Misfit", "an item". */
export function withArticle(word: string): string {
  return `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`;
}
