/**
 * Box 0's actions as the page shows them (SH-BOX0-ACTIONS): which draw, open and claim buttons a holder sees, and the
 * one line beside each. Pure: chain reads in, rows out. The contract rules it mirrors (BoxTickets.sol, BoxItemStream.sol):
 *
 * - A draw is offered while the tickets are AwaitingWord or Drawing (graduated, not terminal), with the vault's quote.
 * - A settled draw is opened by the reveal service with its record; its drawer may open it without the record only from
 *   `revealFallbackAt` (settlement, rounded up to the hour, + 30 days).
 * - A numbered placeholder is opened by the service only with its owner's approval given after the numbers were fixed
 *   (era 3); its holder may open it without the record from `wordAcceptedAt + 30 days`.
 * - A claim pays the booked share plus the pending share of the items named, less 1 raw unit, up to what the stream holds.
 *
 * The ways out of a stopped draw (SH-BOX0-EXITS; BoxTickets.sol terminal mode):
 *
 * - A queue head without a usable word 7 days after its request (30 days after graduation when nobody requested the
 *   graduation word) is dead: anyone may `enterTerminal`. The page never offers that call and says nothing about a dead
 *   head, a deadline or a missing number before a stop (F142, desk R61-STOP "hide"): a requested draw and a placeholder
 *   keep their waiting lines. The page reads a dead head (`headDead`, a simulated call) only because it also refuses new
 *   draws (`QueueDead`, unless the draw would request the graduation word itself): the draw button stays off then.
 * - The exits below show only once box 0 is in terminal mode on chain (someone else called `enterTerminal`).
 * - In terminal mode a requested draw is cancelled for the release quote (`cancelDraw`, fee-free after graduation), and
 *   a placeholder handed back for it while no word is stored (`handBack`). Settled draws and numbered placeholders open
 *   as before.
 * - From 3 days after the stop, one hidden item is taken by its number (`takeByNumber`) for the draw's price.
 */
import type { Address } from '@squarehole/domain';
import { MAX_CLAIM_IDS } from '@squarehole/chain';

/** `TicketPhase` (packages/contracts/src/box/interfaces/BoxTypes.sol). */
export const PHASE = Object.freeze({ BeforeOpen: 0, Curve: 1, AwaitingWord: 2, Drawing: 3, Terminal: 4 } as const);
/** `DrawStatus`. */
export const DRAW = Object.freeze({ None: 0, Requested: 1, Settled: 2, Opened: 3, Cancelled: 4 } as const);
/** `BoxTickets.REVEAL_GRACE`: 30 days. */
export const REVEAL_GRACE = 2_592_000n;
/** `BoxTickets.TAKE_DELAY`: takes by number start 3 days after terminal mode began. */
export const TAKE_DELAY = 259_200n;
const DAY = 86_400n;
const OPEN_LABEL = 'Open without picture';

export type Box0Action =
  | { readonly kind: 'open-draw'; readonly ticket: bigint; readonly label: string }
  | { readonly kind: 'open'; readonly tokenId: bigint; readonly label: string }
  | { readonly kind: 'approve-service'; readonly tokenId: bigint; readonly label: string }
  /** Terminal mode: the requested draw's FIT back (`cancelDraw`); `amount` is the release quote now. */
  | { readonly kind: 'cancel-draw'; readonly ticket: bigint; readonly amount: bigint; readonly label: string }
  /** Terminal mode, no word stored: the placeholder handed back (`handBack`); `amount` is the release quote now. */
  | { readonly kind: 'hand-back'; readonly tokenId: bigint; readonly amount: bigint; readonly label: string };

const BACK_LABEL = 'Get back';

export interface Box0Row {
  readonly key: string;
  readonly text: string;
  readonly action: Box0Action | null;
}

export interface DrawRead {
  readonly id: bigint;
  readonly drawer: Address;
  readonly status: number;
  readonly itemId: bigint;
  readonly fallbackAt: bigint;
}

export interface PlaceholderRead {
  readonly id: bigint;
  /** `numberOf`: 0 until the graduation word is stored. */
  readonly number: bigint;
  /** `getApproved`: zero (null) when no approval counts now. */
  readonly approved: Address | null;
}

export interface TicketsNow {
  readonly phase: number;
  readonly wordAcceptedAt: bigint;
  /** The latest block's time. */
  readonly now: bigint;
  /** The reveal service's signer this build names, or null. */
  readonly service: Address | null;
  /** SH-BOX0-EXITS: what one ticket's release pays now (`quoteHandBack(1)`, net), read in terminal mode (absent: none). */
  readonly refund?: bigint | null;
}

/** The draw button: while drawing, with the chain's quote for one (principal + 1% draw fee); not while `blocked`. */
export function drawOffer(phase: number, quote: bigint | null, blocked = false): { readonly quote: bigint } | null {
  if (blocked || (phase !== PHASE.AwaitingWord && phase !== PHASE.Drawing)) return null;
  return quote !== null && quote > 0n ? { quote } : null;
}

const daysUntil = (at: bigint, now: bigint): bigint => (at - now + DAY - 1n) / DAY;

/**
 * A new draw would revert `QueueDead`: the head is dead and the draw would wait behind it. Not when the draw would
 * request the graduation word itself (placeholders, none requested): `draw` skips the head check then.
 */
export function queueBlocked(r: { readonly headDead: boolean; readonly slots: bigint; readonly wordRequestedAt: bigint }): boolean {
  return r.headDead && !(r.slots !== 0n && r.wordRequestedAt === 0n);
}

export type TakeOffer =
  | { readonly kind: 'take'; readonly quote: bigint; readonly itemId: bigint; readonly poolIndex: bigint }
  | { readonly kind: 'wait'; readonly days: bigint };

/** A take by number: in terminal mode from `terminalAt + TAKE_DELAY`, with the chain's quote and a hidden item found. */
export function takeOffer(r: { readonly phase: number; readonly terminalAt: bigint; readonly now: bigint; readonly quote: bigint | null; readonly take: { readonly itemId: bigint; readonly poolIndex: bigint } | null }): TakeOffer | null {
  if (r.phase !== PHASE.Terminal) return null;
  const from = r.terminalAt + TAKE_DELAY;
  if (r.now < from) return { kind: 'wait', days: daysUntil(from, r.now) };
  if (r.quote === null || r.quote <= 0n || r.take === null) return null;
  return { kind: 'take', quote: r.quote, itemId: r.take.itemId, poolIndex: r.take.poolIndex };
}

/**
 * One draw's line; null once it is opened or cancelled (it is then an item, or FIT back). In terminal mode a requested
 * draw never gets a number (`settle` reverts TerminalMode): its way out is `cancelDraw`, for the release quote. A settled
 * one still opens (`openDraw` has no terminal check). Before terminal mode a requested draw only waits (F142: no word
 * about a dead head). `refund` is the release quote, read in terminal mode.
 */
export function drawRow(d: DrawRead, now: bigint, noun = 'Item', terminal = false, refund: bigint | null = null): Box0Row | null {
  const key = `draw-${d.id}`;
  if (d.status === DRAW.Requested) {
    if (terminal) {
      const action = refund !== null && refund > 0n ? { kind: 'cancel-draw' as const, ticket: d.id, amount: refund, label: BACK_LABEL } : null;
      return { key, text: `Draw ${d.id} · draws stopped`, action };
    }
    return { key, text: `Draw ${d.id} · waiting for its number`, action: null };
  }
  if (d.status !== DRAW.Settled) return null;
  const named = `Draw ${d.id} · ${noun} ${d.itemId}`;
  if (now >= d.fallbackAt) return { key, text: named, action: { kind: 'open-draw', ticket: d.id, label: OPEN_LABEL } };
  return { key, text: `${named} · on its way`, action: null };
}

/**
 * One placeholder's line. Terminal mode stops only the placeholders still without a number: while no word is stored,
 * their way out is the number-less hand-back (`handBack`, for the release quote). A numbered one keeps its open, which
 * needs only the stored word (`open`).
 */
export function placeholderRow(p: PlaceholderRead, t: TicketsNow, noun = 'Item'): Box0Row {
  const key = `placeholder-${p.id}`;
  const unnumbered = t.wordAcceptedAt === 0n || p.number === 0n;
  if (unnumbered && t.phase === PHASE.Terminal) {
    const refund = t.refund ?? null;
    const action = t.wordAcceptedAt === 0n && refund !== null && refund > 0n ? { kind: 'hand-back' as const, tokenId: p.id, amount: refund, label: BACK_LABEL } : null;
    return { key, text: `Placeholder ${p.id} · draws stopped`, action };
  }
  if (unnumbered) return { key, text: `Placeholder ${p.id} · waiting for numbers`, action: null };
  const named = `Placeholder ${p.id} · ${noun} ${p.number}`;
  const fallbackAt = t.wordAcceptedAt + REVEAL_GRACE;
  if (t.now >= fallbackAt) return { key, text: named, action: { kind: 'open', tokenId: p.id, label: OPEN_LABEL } };
  const approved = t.service !== null && p.approved !== null && p.approved.toLowerCase() === t.service.toLowerCase();
  if (approved) return { key, text: `${named} · on its way`, action: null };
  if (t.service !== null) return { key, text: named, action: { kind: 'approve-service', tokenId: p.id, label: 'Let the service open it' } };
  return { key, text: `${named} · opens in ${daysUntil(fallbackAt, t.now)} d`, action: null };
}

/**
 * What one claim pays: `owedOf` plus each named item's `pendingOf`, less the 1 raw unit the stream keeps booked, up to
 * the T it holds; null below 2 raw. At most MAX_CLAIM_IDS items per claim (the rest in the next one).
 */
export function claimOffer(input: { readonly owed: bigint; readonly pending: readonly bigint[]; readonly held: bigint; readonly ids: readonly bigint[] }): { readonly amount: bigint; readonly ids: readonly bigint[] } | null {
  const ids = input.ids.slice(0, MAX_CLAIM_IDS);
  const total = input.pending.slice(0, MAX_CLAIM_IDS).reduce((sum, p) => sum + p, input.owed);
  if (total < 2n) return null;
  const amount = total - 1n < input.held ? total - 1n : input.held;
  return amount > 0n ? { amount, ids } : null;
}

/** A FIT charge rounded UP to two decimals (the page shows charges at two decimals and never understates them). */
export function roundUpFit(raw: bigint): bigint {
  const step = 10n ** 16n;
  return ((raw + step - 1n) / step) * step;
}

/** A FIT payout rounded DOWN to two decimals (the page never shows more than a payout pays). */
export function roundDownFit(raw: bigint): bigint {
  const step = 10n ** 16n;
  return (raw / step) * step;
}
