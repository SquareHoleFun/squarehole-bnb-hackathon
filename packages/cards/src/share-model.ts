/**
 * What a shared box link says about the box (the link preview's card and its Open Graph / Twitter tags): its name and
 * ticker, its chain and address, and its state in one short line. Pure: no fetch, no clock (the caller passes "now").
 *
 * Wording rules (founder, 2026-10-04): neutral words only (no "buy", "price", "moon"), no ranking and no verified names,
 * no claims about FIT or the Misfits; the chain and the address for every box; Demo boxes say "Demo". An upcoming box
 * names an absolute time in UTC, never a countdown, so a card a chat app keeps for days stays true. The address is
 * always the full one: with no verified names it is the only thing that tells two boxes of one name apart, and a short
 * form (4 + 4 hex digits) is cheap to match with a made-up address.
 */

/** Where a box is in its life, as a card says it (the five chain phases fold into four lines). */
export type ShareState =
  /** Before the open. `opensAt` in Unix seconds, `approx` when it is estimated from blocks; null when not known. */
  | { readonly kind: 'upcoming'; readonly opensAt: number | null; readonly approx: boolean }
  /** The launch window and the curve: "Open now". */
  | { readonly kind: 'open' }
  /** The curve has closed and the pool is being set up (the contract's Closed). */
  | { readonly kind: 'graduating' }
  | { readonly kind: 'graduated' }
  /** Demo only (a Demo box that did not graduate); no core v1 box has this state. */
  | { readonly kind: 'failed' };

export interface ShareBox {
  readonly chainId: number;
  /** The token address, lowercase (the box's id with the chain). */
  readonly token: `0x${string}`;
  /** "Sepolia", "Demo chain", "Local chain". */
  readonly chainLabel: string;
  readonly name: string;
  readonly ticker: string;
  readonly demo: boolean;
  readonly state: ShareState;
  /** The spec's logo (field 23, `coverSha256`), preferred in the card's square slot. */
  readonly logoSha256: `0x${string}` | null;
  /** The collection cover (field 28), used when the logo cannot be shown. Absent on older callers and Demo boxes. */
  readonly collectionCoverSha256?: `0x${string}` | null;
}

/** Seconds a card stays cached: a few minutes while the box can change state, long once it has graduated. */
export const LIVE_CACHE_SECONDS = 300;
export const GRADUATED_CACHE_SECONDS = 7 * 24 * 60 * 60;
/** Bumped when the card's design changes, so caches keyed on the image URL fetch the new one. */
export const CARD_DESIGN = '2';
/** The card's size: the large-image preview of Open Graph and X. */
export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const two = (n: number): string => String(n).padStart(2, '0');

/** "12 Oct 2026, 18:00 UTC": fixed words and the 24-hour clock, the same in every locale. */
export function formatUtc(seconds: number): string {
  const d = new Date(seconds * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
}

/** An estimated time, rounded to the nearest five minutes (a block estimate is not exact to the minute). */
export function roundToFiveMinutes(seconds: number): number {
  return Math.round(seconds / 300) * 300;
}

/** The state in two parts for the card: a small lead ("Opens", "Opens about") over the main words, or the words alone. */
export function stateParts(state: ShareState): { readonly lead: string | null; readonly main: string } {
  switch (state.kind) {
    case 'upcoming':
      if (state.opensAt === null) return { lead: null, main: 'Upcoming' };
      return state.approx ? { lead: 'Opens about', main: formatUtc(roundToFiveMinutes(state.opensAt)) } : { lead: 'Opens', main: formatUtc(state.opensAt) };
    case 'open':
      return { lead: null, main: 'Open now' };
    case 'graduating':
      return { lead: null, main: 'Graduating' };
    case 'graduated':
      return { lead: null, main: 'Graduated' };
    case 'failed':
      return { lead: null, main: 'Did not graduate' };
  }
}

/** The card's state line: "Opens 12 Oct 2026, 18:00 UTC", "Open now", "Graduated". */
export function stateLine(state: ShareState): string {
  const { lead, main } = stateParts(state);
  return lead === null ? main : `${lead} ${main}`;
}

/** A key for the state, in the card's URL: when the state changes, the URL changes, and link previews fetch it again. */
export function stateKey(state: ShareState): string {
  return state.kind === 'upcoming' && state.opensAt !== null ? `upcoming-${state.opensAt}` : state.kind;
}

/**
 * The card's version, the `v` of its URL: the design and the state. The spec's commitments are fixed at creation.
 * A finished card can be cached for long; a fallback awaiting unavailable bytes has a shorter retry lifetime.
 */
export function cardVersion(state: ShareState): string {
  return `${CARD_DESIGN}-${stateKey(state)}`;
}

export function cacheSeconds(state: ShareState): number {
  return state.kind === 'graduated' || state.kind === 'failed' ? GRADUATED_CACHE_SECONDS : LIVE_CACHE_SECONDS;
}

/**
 * Untrusted text from a spec (the chain's bytes) for a card and a meta tag: control characters and the bidirectional
 * overrides that could reorder what a reader sees are removed, runs of spaces become one, and the text is cut to `max`
 * characters with an ellipsis.
 */
export function cleanText(raw: string, max: number): string {
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  const plain = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(plain);
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : plain;
}

/** Longest name and ticker a card shows (the spec allows 32 and 11 bytes). */
export const NAME_MAX = 40;
export const TICKER_MAX = 12;

export interface CardText {
  readonly name: string;
  readonly ticker: string;
  readonly state: string;
  readonly stateLead: string | null;
  readonly stateMain: string;
  /** "Sepolia". */
  readonly chain: string;
  /** The token's full address, lowercase (42 characters). */
  readonly address: string;
  readonly demo: boolean;
}

/** Every word the card shows for a box. */
export function cardText(box: ShareBox): CardText {
  const parts = stateParts(box.state);
  return {
    name: cleanText(box.name, NAME_MAX) || cleanText(box.ticker, TICKER_MAX) || 'A box',
    ticker: cleanText(box.ticker, TICKER_MAX),
    state: stateLine(box.state),
    stateLead: parts.lead,
    stateMain: parts.main,
    chain: box.chainLabel,
    address: box.token.toLowerCase(),
    demo: box.demo,
  };
}
