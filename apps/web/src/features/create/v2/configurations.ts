/**
 * A named box configuration: a name, a ticker, a price coin by symbol and both sides' fee choice, as the page's draft
 * fields and v2 choices (`applyConfiguration`). The creation flow's templates no longer use them (they are generic
 * recipes, templates.ts, founder 2026-10-11); the named example boxes (Link Marines, Gold Rush, …) are test data in
 * test-support/example-configurations.ts, for the tests and evidence that build whole boxes from them.
 */
import type { CreateForm } from '../create-model';
import { DEMO_LISTINGS, NATIVE_TOKEN, offeredListings, type SiteListing } from './listings';
import { DEFAULT_V2, type V2Choices } from './model';
import type { SidePick } from './recipes';
import type { ShopChoice } from './shop';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

export interface Configuration {
  readonly id: string;
  readonly name: string;
  readonly ticker: string;
  /** The pricing token's symbol in the listings. */
  readonly pricing: string;
  readonly buyers: SidePick;
  readonly sellers: SidePick;
  readonly tokenOnly?: boolean;
  readonly hidden?: boolean;
  readonly royaltyBps?: number;
  readonly deadlineDays?: number;
  /** A token-only box's coin pile (M3): the seed coin's symbol and the seed as typed. */
  readonly pile?: { readonly coin: string; readonly seed: string };
  /** A shop (M2, SH-V21-FE13): its settings as typed; the box is token-like. */
  readonly shop?: ShopChoice;
  /** The creator's first buy as typed (a shop's seed comes from it); none by default. */
  readonly firstIn?: string;
}

/**
 * The listing book a configuration's coins are found in: the one given (the page's live listings on the production
 * site), else the Demo's. The Demo's book lists every symbol a configuration names.
 */
const bookOf = (listings: readonly SiteListing[] | undefined): readonly SiteListing[] => listings ?? (DEMO_BUILD ? DEMO_LISTINGS : []);

/**
 * A coin of the book by its symbol. A symbol the book does not list (a Demo coin on a chain: the Demo's box tokens, a
 * coin not listed there yet) gives way to ETH, else the book's first coin: a template stays a starting point and never
 * carries a Demo address. Null only for an empty book.
 */
export function coinOf(symbol: string, listings: readonly SiteListing[]): SiteListing | null {
  const offered = offeredListings(listings);
  return offered.find((entry) => entry.symbol === symbol) ?? offered.find((entry) => entry.token.toLowerCase() === NATIVE_TOKEN) ?? offered[0] ?? null;
}
const tokenOf = (symbol: string, book: readonly SiteListing[]): string => coinOf(symbol, book)?.token ?? NATIVE_TOKEN;
/** A pile's seed coin only when the book lists it (a seed in another coin would not be the template's). */
const pileCoinOf = (symbol: string, book: readonly SiteListing[]): string | null => offeredListings(book).find((entry) => entry.symbol === symbol)?.token ?? null;
/** A configuration as the page's draft fields and v2 choices, its coins from `listings` (else the Demo's book). */
export function applyConfiguration(config: Configuration, listings?: readonly SiteListing[]): { readonly form: Partial<CreateForm>; readonly v2: V2Choices } {
  const book = bookOf(listings);
  const pileAsset = config.pile ? pileCoinOf(config.pile.coin, book) : null;
  return {
    form: {
      name: config.name,
      ticker: config.ticker,
      contents: config.tokenOnly ? 'token' : 'collection',
      artMode: config.hidden ? 'hidden' : 'open',
      royaltyBps: config.royaltyBps ?? 0,
      royaltyTo: 'fees',
      firstIn: config.firstIn ?? '',
    },
    v2: { ...DEFAULT_V2, pricing: tokenOf(config.pricing, book), buyers: config.buyers, sellers: config.sellers, deadlineDays: config.deadlineDays ?? DEFAULT_V2.deadlineDays,
      pile: config.pile && pileAsset !== null ? { asset: pileAsset, seed: config.pile.seed } : null, shop: config.shop ?? null },
  };
}
