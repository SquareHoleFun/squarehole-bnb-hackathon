/** The page and link card use this same picture priority and withholding rule. */
export type PictureSlot = 'square' | 'card';
export type PictureRole = 'logo' | 'cover';

/**
 * One picture as the page knows it now: `none` (nothing committed and no local copy), `pending` (being looked up),
 * `shown` (a verified URL, or the creator's own data URL), `missing` (the lookup ended without bytes, or no source can
 * be asked) or `withheld` (our withheld list names it).
 */
export type SlotSourceState = 'none' | 'pending' | 'shown' | 'missing' | 'withheld';
export interface SlotSource {
  readonly state: SlotSourceState;
  readonly url: string | null;
}

export type SlotChoice =
  | { readonly kind: 'picture'; readonly which: PictureRole; readonly url: string }
  | { readonly kind: 'withheld'; readonly which: PictureRole }
  | { readonly kind: 'pending'; readonly which: PictureRole }
  | { readonly kind: 'none' };

/** The order a slot asks for its pictures in: the first it can show wins. */
export const SLOT_ORDER: Readonly<Record<PictureSlot, readonly [PictureRole, PictureRole]>> = Object.freeze({
  square: Object.freeze(['logo', 'cover'] as const),
  card: Object.freeze(['cover', 'logo'] as const),
});

export const NO_SOURCE: SlotSource = Object.freeze({ state: 'none', url: null });

/**
 * How long a slot waits for its own picture before a verified other picture may show (fix round af1): the per-copy time
 * the Arweave read gives one gateway (COPY_TIMEOUT_MS), so a reachable gateway's answer normally lands first.
 */
export const SLOT_WAIT_MS = 3_000;

/** Whether a slot goes on to its second picture: only when the first is not there at all (never while it loads). */
export const fallsThrough = (source: SlotSource): boolean => source.state === 'none' || source.state === 'missing';

/**
 * The slot's choice from its two pictures, in the slot's order: `first` whenever it is withheld or shown, `second` when
 * the first is absent. `firstLate` (the slot has waited SLOT_WAIT_MS for a first picture still loading): a shown second
 * shows meanwhile; otherwise the slot keeps waiting for the first.
 */
export function chooseSlotPicture(slot: PictureSlot, first: SlotSource, second: SlotSource, firstLate = false): SlotChoice {
  const [one, two] = SLOT_ORDER[slot];
  const pick = (which: PictureRole, source: SlotSource): SlotChoice | null => {
    if (source.state === 'withheld') return { kind: 'withheld', which };
    if (source.state === 'shown' && source.url) return { kind: 'picture', which, url: source.url };
    if (source.state === 'pending') return { kind: 'pending', which };
    return null;
  };
  const own = pick(one, first);
  if (own?.kind === 'pending' && firstLate && second.state === 'shown') return pick(two, second) ?? own;
  return own ?? (fallsThrough(first) ? pick(two, second) : null) ?? { kind: 'none' };
}

