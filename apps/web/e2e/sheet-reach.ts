import type { Locator, Page } from '@playwright/test';

// SH-255: the reach check SH-254's sheet spec makes on Launch (create-visual-sheet-scroll.spec.ts, its `tallest`,
// `shownInSheet`, `markLowest` and `reach`, copied word for word so the box page's sheets meet the same check; the
// Launch spec keeps its own copy). Each sheet in its tallest state: inside the window, moved by the wheel (and a touch
// drag on a phone), its lowest control and its end reached, Close in view, its lowest control shown when focused.
const CONTROLS = 'button, summary, input, select, textarea, a[href]';

/** The sheet's tallest state: the choice that adds the most rows, three more collections in a shop, every Details and (?) open. */
export async function tallest(page: Page, sheet: Locator) {
  for (const choice of ['items', 'holders']) {
    const buttons = sheet.locator(`[data-fee-choice="${choice}"]:not([data-create-off]):not([disabled])`);
    if (await buttons.count() > 0) {
      for (let i = 0; i < await buttons.count(); i += 1) await buttons.nth(i).click();
      break;
    }
  }
  const add = sheet.getByRole('button', { name: 'Add collection' });
  if (await add.count() > 0) for (let i = 0; i < 3; i += 1) await add.click();
  for (let round = 0; round < 4; round += 1) {
    const opened = await sheet.evaluate((el) => {
      const closed = Array.from(el.querySelectorAll('details:not([open])'));
      for (const details of closed) (details as HTMLDetailsElement).open = true;
      return closed.length;
    });
    if (opened === 0) break;
    await page.waitForTimeout(150);
  }
  // Every (?) of the sheet, opened by a real press.
  const infos = sheet.locator('button[aria-controls][aria-expanded="false"]');
  for (let i = 0; i < 20 && await infos.count() > 0; i += 1) await infos.first().click();
  await page.waitForTimeout(250);
}

/** The target lies inside the sheet's visible box (the sheet within the window) and a point test at its centre hits it. */
const shownInSheet = async (sheet: Locator, target: Locator): Promise<boolean> => target.evaluate((el, sheetEl) => {
  const r = el.getBoundingClientRect();
  const s = (sheetEl as Element).getBoundingClientRect();
  const top = Math.max(s.top, 0);
  const bottom = Math.min(s.bottom, window.innerHeight);
  if (r.top < top - 1 || r.bottom > bottom + 1 || r.left < s.left - 1 || r.right > s.right + 1) return false;
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (hit === null) return false;
  const label = hit.closest('label');
  return hit === el || el.contains(hit) || (label !== null && (label.control === el || label.contains(el)));
}, await sheet.elementHandle());

/** Marks the sheet's lowest control of real size (Fee details and the like hold long text below their own control). */
async function markLowest(sheet: Locator) {
  await sheet.evaluate((el, selector) => {
    el.querySelector('[data-lowest]')?.removeAttribute('data-lowest');
    const controls = Array.from(el.querySelectorAll<HTMLElement>(selector)).filter((c) => {
      const r = c.getBoundingClientRect();
      return r.width > 4 && r.height > 4 && getComputedStyle(c).visibility !== 'hidden';
    });
    const lowest = controls.reduce<HTMLElement | null>((low, c) => (low === null || c.getBoundingClientRect().bottom >= low.getBoundingClientRect().bottom ? c : low), null);
    lowest?.setAttribute('data-lowest', '');
  }, CONTROLS);
}

export async function reach(page: Page, sheet: Locator, phone: boolean) {
  const height = page.viewportSize()?.height ?? 0;
  const box = await sheet.boundingBox();
  const sheetInWindow = box !== null && box.y >= -1 && box.y + box.height <= height + 1;
  // Measured from the top: a sheet still scrolled (by the (?) just opened) would make its sticky Close look lowest.
  await sheet.evaluate((el) => { el.scrollTop = 0; });
  await markLowest(sheet);
  const last = sheet.locator('[data-lowest]');
  const overflows = await sheet.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
  // The wheel, over the sheet's own head (never over a list inside it that scrolls on its own), a turn at a time.
  await sheet.evaluate((el) => { el.scrollTop = 0; });
  const head = await sheet.locator('.sh-pic-sheet__head').boundingBox();
  if (head === null) throw new Error('the sheet has no head');
  await page.mouse.move(head.x + head.width / 3, Math.max(4, Math.min(head.y + head.height / 2, height - 4)));
  // Turns smaller than the band between the sticky head and the sheet's foot (about 110 px at 320x256), so the wheel
  // never jumps over the control it looks for.
  for (let i = 0; i < 240 && !(await shownInSheet(sheet, last)); i += 1) {
    const before = await sheet.evaluate((el) => el.scrollTop);
    await page.mouse.wheel(0, 60);
    await page.waitForTimeout(60);
    if (await sheet.evaluate((el) => el.scrollTop) === before) break;
  }
  const lastByWheel = await shownInSheet(sheet, last);
  // The END of the content (review round 2): the wheel on until the sheet moves no further, then the sheet is scrolled
  // to its very end, still inside the window, and its last body element (never Close, never a (?) of the head) lies
  // inside the visible box where a point test at its centre hits it; a native input of 1 px counts through its label.
  for (let i = 0; i < 400; i += 1) {
    const before = await sheet.evaluate((el) => el.scrollTop);
    await page.mouse.wheel(0, 60);
    await page.waitForTimeout(40);
    if (await sheet.evaluate((el) => el.scrollTop) === before) break;
  }
  const atEnd = await sheet.evaluate((el) => Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight - 1);
  const endBox = await sheet.boundingBox();
  const endInWindow = endBox !== null && endBox.y >= -1 && endBox.y + endBox.height <= height + 1;
  const endLeaf = await sheet.evaluate((el) => {
    const body = el.querySelector('.sh-pic-sheet__body');
    if (!body) return { shown: false, what: 'no body' };
    const leaves = Array.from(body.querySelectorAll<HTMLElement>('*')).filter((c) => c.children.length === 0 && getComputedStyle(c).visibility !== 'hidden')
      .map((c) => {
        const r = c.getBoundingClientRect();
        const label = c instanceof HTMLInputElement && (r.width <= 4 || r.height <= 4) ? c.labels?.[0] ?? null : null;
        return label ?? c;
      })
      .filter((c) => { const r = c.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    const lastLeaf = leaves.reduce<HTMLElement | null>((low, c) => (low === null || c.getBoundingClientRect().bottom >= low.getBoundingClientRect().bottom ? c : low), null);
    // A sheet with no body target fails (round 2b).
    if (lastLeaf === null) return { shown: false, what: 'no body target' };
    const r = lastLeaf.getBoundingClientRect();
    const s = el.getBoundingClientRect();
    // The visible box starts below the sticky head (round 2b), ends at the sheet's foot or the window's, and spans the
    // sheet's width. An element taller than that box (a (?) paragraph on a low window) is checked by its bottom edge:
    // its bottom in view and hit just above it; anything else lies whole inside the box and is hit at its centre.
    const head = el.querySelector('.sh-pic-sheet__head')?.getBoundingClientRect();
    const top = Math.max(s.top, head?.bottom ?? s.top, 0);
    const bottom = Math.min(s.bottom, window.innerHeight);
    const tall = r.height > bottom - top;
    const y = tall ? r.bottom - 8 : r.top + r.height / 2;
    const hit = document.elementFromPoint(r.left + r.width / 2, y);
    const what = `${lastLeaf.outerHTML.slice(0, 80)} at ${Math.round(r.top)}..${Math.round(r.bottom)} in ${Math.round(s.top)}..${Math.round(s.bottom)}, hit ${hit?.outerHTML.slice(0, 60) ?? 'none'}`;
    if ((!tall && r.top < top - 1) || r.bottom > bottom + 1 || r.left < s.left - 1 || r.right > s.right + 1) return { shown: false, what };
    return { shown: hit !== null && (hit === lastLeaf || lastLeaf.contains(hit)), what };
  });
  const reachedEnd = atEnd && endInWindow && endLeaf.shown;
  // The wheel really moves the sheet when its content is taller: one turn from the top, over its head.
  await sheet.evaluate((el) => { el.scrollTop = 0; });
  await page.mouse.wheel(0, 160);
  await page.waitForTimeout(150);
  const movedByWheel = !overflows || await sheet.evaluate((el) => el.scrollTop > 0);
  const closeShown = await shownInSheet(sheet, sheet.getByRole('button', { name: 'Close' }));
  // A touch drag on a phone size: up across the sheet's visible middle.
  let movedByTouch = true;
  if (phone && overflows) {
    await sheet.evaluate((el) => { el.scrollTop = 0; });
    const now = await sheet.boundingBox();
    if (now === null) throw new Error('the sheet has no box');
    const x = now.x + now.width / 2;
    const y = Math.min(now.y + now.height, height) - 30;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= 6; i += 1) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - i * 15 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(300);
    movedByTouch = await sheet.evaluate((el) => el.scrollTop > 0);
    await cdp.detach();
  }
  // The keyboard: focus on the title (the last (?) pressed may hold it), back to the top, focus on the lowest control,
  // and it shows.
  await sheet.locator('.sh-pic-sheet__title').focus();
  await sheet.evaluate((el) => { el.scrollTop = 0; });
  await last.focus();
  const lastFocused = await last.evaluate((el) => document.activeElement === el);
  await page.waitForTimeout(100);
  const lastByFocus = lastFocused && await shownInSheet(sheet, last);
  // What the lowest control is and where it sat, for the message when a check fails.
  const why = await last.evaluate((el, sheetEl) => {
    const r = el.getBoundingClientRect();
    const s = (sheetEl as Element).getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return `${el.outerHTML.slice(0, 90)} at ${Math.round(r.top)}..${Math.round(r.bottom)} in ${Math.round(s.top)}..${Math.round(s.bottom)}, hit ${hit?.outerHTML.slice(0, 70) ?? 'none'}`;
  }, await sheet.elementHandle());
  return { checks: { sheetInWindow, movedByWheel, lastByWheel, reachedEnd, closeShown, movedByTouch, lastByFocus }, why: `${why}; end: atEnd ${atEnd}, in window ${endInWindow}, last ${endLeaf.what}` };
}

