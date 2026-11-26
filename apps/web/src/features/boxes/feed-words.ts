/**
 * SH-246 (finding 11.4): the words when a part of the source (box 0's feed, the v2 feed, the add-on's) could not be
 * read at all. Before, the front page's list just got shorter, or said "No boxes yet." while a feed had failed, and My
 * Box's Claims said "Claims are not built yet." Proposals for the founder (docs/evidence/SH-246.md).
 */
export const FEED_WORDS = Object.freeze({
  /** The front page lists boxes, and a part could not be read: the list may lack that part's boxes. */
  partial: 'Some boxes may be missing from this list.',
  /** The front page has nothing to list, and a part could not be read. */
  none: 'The boxes did not load.',
  /** My Box's Claims tab: the v2 boxes, where claims live, could not be read. */
  claims: 'Claims did not load.',
  /** /misfits: box 0's feed could not be read (review C2; before, the raw reason). */
  box: 'This box did not load.',
  /** Reads again the parts that could not be read (the box page's word). */
  retry: 'Retry',
});
