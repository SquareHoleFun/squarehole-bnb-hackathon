/**
 * SH-BOX-PICTURE-FIT (founder 2026-11-02, the Rent Free box: "I can't ever read it in full anywhere"): which of a box's
 * two pictures a slot shows. A box has a square logo (BoxSpec field 23) and a box picture: its collection's own cover
 * (field 28, often wide, words and all) or else the logo again.
 *
 * - A square slot (the box page's header icon, a list row's thumbnail, the token's coin) shows the logo. Only when the
 *   box has no logo to show (none committed, or no source has its bytes) does it show the cover, contained in full.
 * - A card slot (the feed card, My Box's created tiles) shows the cover; without one, the logo.
 *
 * Every slot draws its picture whole (object-fit: contain, on a blurred copy of itself; BoxParts.tsx), so no slot crops
 * a cover's words away. A withheld picture (SH-WITHHELD-SITE) is never replaced by the other one: the slot shows the
 * neutral tile. A picture still loading keeps the slot waiting: the other picture never flashes in first.
 *
 * Fix round af1: both pictures are looked up at once (useSlotPicture), and only the choice waits for the first. The
 * first wins whenever it verifies. A first picture still loading after SLOT_WAIT_MS gives way to a second that has
 * verified (a stalled gateway never leaves the slot blank), and takes the slot back once it verifies itself; a first
 * picture that turns out withheld takes it back as the tile.
 *
 * SH-223 (founder 2026-11-15, the first box's page on the test site: "I see this preview image for the Misfits, is this
 * correct?"): the two square places where one picture stands for the whole box (the big picture of the v1 box header,
 * BoxHeader: 200 px, 96 px on a phone; a List row's thumbnail, BoxTable: 40 px) are square slots for every box but the
 * Genesis box. The Genesis box (the Misfits set-up) shows its box picture there, as its feed card does: its logo is
 * the token's plain coin, and both places had shown the collection's picture until the rule above replaced it with
 * the coin (`headerSlot`). The token's own coin (TokenMark) stays the logo for every box.
 */

import { NO_SOURCE, type PictureSlot, type SlotSource } from '@squarehole/artwork/picture-choice';
import type { BoxRecord } from './box-model';
export { chooseSlotPicture, fallsThrough, NO_SOURCE, SLOT_ORDER, SLOT_WAIT_MS, type PictureSlot, type PictureRole, type SlotSourceState, type SlotSource, type SlotChoice } from '@squarehole/artwork/picture-choice';


/**
 * The slot of the v1 box header's big picture and of a List row's thumbnail (SH-223): the Genesis box's is a card slot
 * (its box picture first, the logo only without one); every other box's stays a square slot (the logo first).
 */
export function headerSlot(record: Pick<BoxRecord, 'kind'>): PictureSlot {
  return record.kind === 'genesis' ? 'card' : 'square';
}

/**
 * One picture's source from what the page has: the hash the spec commits (null: none), its lookup's state (`reachable`
 * false: no gateway, no Arweave and not in the bundle, so it can never load here) and the creator's own data URL (a
 * box built on this page or its preview). A verified URL wins, then the local copy; a withheld picture is withheld
 * whatever copy the page holds.
 */
export function slotSource(
  hash: string | null,
  state: { readonly url: string | null; readonly missing: boolean; readonly withheld: boolean },
  reachable: boolean,
  localUrl: string | null,
): SlotSource {
  if (state.withheld) return { state: 'withheld', url: null };
  // Committed local bytes enter usePictureState's verification/decode path. Only draft previews bypass lookup.
  const url = state.url ?? (hash === null ? localUrl : null);
  if (url) return { state: 'shown', url };
  if (hash === null) return NO_SOURCE;
  if (!reachable || state.missing) return { state: 'missing', url: null };
  return { state: 'pending', url: null };
}

/**
 * A URL safe to name inside a CSS `url("…")` (the blurred ground behind a contained picture): a blob URL or a base64
 * data URL of a raster picture, with nothing that could close the string. Anything else gets no ground.
 */
export function groundUrl(url: string): string | null {
  if (!/^(?:blob:[A-Za-z0-9:/._%-]+|data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+)$/.test(url)) return null;
  return `url("${url}")`;
}
