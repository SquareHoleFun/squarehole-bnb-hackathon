/**
 * SH-255: the top of a v2 box's page is a lazy chunk (picture/BoxPagePicture.tsx); a page test waits for it once
 * before reading the head, the picture, the figures or the sheets.
 */
import { waitFor } from '@testing-library/react';

export async function pictureLoaded(): Promise<HTMLElement> {
  let found: HTMLElement | null = null;
  await waitFor(() => {
    found = document.querySelector<HTMLElement>('.sh-bpic');
    if (!found) throw new Error('The box page’s picture has not loaded');
  }, { timeout: 15_000 });
  return found as unknown as HTMLElement;
}

/** Opens a part's sheet on the picture (a click, as a reader taps it) and returns the sheet. */
export async function openPart(part: string): Promise<HTMLElement> {
  const { fireEvent, screen } = await import('@testing-library/react');
  const picture = await pictureLoaded();
  const control = picture.querySelector(`[data-part="${part}"]`);
  if (!control) throw new Error(`No part ${part} on the picture`);
  fireEvent.click(control);
  return screen.findByRole('dialog');
}

/** What a side's fees go to, as Where the fees go names it (a line of its own, or one line for both sides). */
export async function feePlace(side: 'buyers' | 'sellers'): Promise<string | null> {
  const picture = await pictureLoaded();
  const line = picture.querySelector(`li[data-side="${side}"] .sh-bpic-ledger-place`) ?? picture.querySelector('li[data-side="both"] .sh-bpic-ledger-place');
  return line?.textContent ?? null;
}

/**
 * SH-255 (review R-16): the page's second-level headings in order up to and including `last`, as [inside the picture,
 * text]. A test compares the whole list, so no other heading can come first unnoticed: the picture's own cards ("What
 * you can do here" where it offers something, then "Where the fees go"), then the page's first card.
 */
export function headingsUpTo(last: string): readonly (readonly [boolean, string])[] {
  const all = [...document.querySelectorAll('h2, [role="heading"][aria-level="2"]')];
  const end = all.findIndex((h) => h.textContent === last);
  return all.slice(0, end + 1).map((h) => [h.closest('.sh-bpic') !== null, h.textContent ?? ''] as const);
}
/**
 * The exact order on a closed box's settled page (SH-255 round 3, D13): every closed box has claims, so the picture's
 * "What you can do here" comes first, then "Where the fees go", then the page's closing price.
 */
export const CLOSED_BOX_HEADINGS: readonly (readonly [boolean, string])[] = [[true, 'What you can do here'], [true, 'Where the fees go'], [false, 'Closing price']];
