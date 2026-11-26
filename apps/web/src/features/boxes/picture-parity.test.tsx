import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { sha256Hex } from '@squarehole/artwork';
import { fetchVerifiedPicture, resetPicturesForTests, usePictureState } from './box-pictures';
import { chooseSlotPicture, type SlotSource } from './picture-slot';
import { loadLogo } from '../../../../../packages/cards/src/share-art';
import { chooseCardPicture } from '../../../../../packages/cards/src/picture-choice';
import { PICTURE_CASES, pictureFixture } from '../../../../../packages/artwork/src/picture-fixtures';

afterEach(() => { cleanup(); resetPicturesForTests(); });
describe('page and card consume the same fixture table', () => {
  it.each(['ordinary.png', 'huge.png', 'false-tail.png', 'ordinary.webp'])('local committed %s follows the admission and decode path too', async (name) => {
    const bytes = pictureFixture(name), hash = sha256Hex(bytes);
    const decode = vi.fn(async () => false), get = vi.fn(async () => new Response(null, { status: 404 }));
    resetPicturesForTests(get, decode);
    function Probe() {
      const s = usePictureState(hash, [], null, `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`);
      return <output>{s.url ?? (s.missing ? 'missing' : 'pending')}</output>;
    }
    const view = render(<Probe />);
    await waitFor(() => expect(view.container.textContent).toBe('missing'));
    expect(decode).toHaveBeenCalledTimes(['ordinary.png', 'ordinary.webp'].includes(name) ? 1 : 0);
    expect(get).not.toHaveBeenCalled();
  });
  // card-pictures.test.ts runs every same-table choice through the real card service and renderer.
  it.each(PICTURE_CASES)('$name: page and card select the same role before rendering', async ({ bytes, accepted }) => {
    const hash = sha256Hex(bytes);
    const get = vi.fn(async () => new Response(bytes.slice()));
    const page = await fetchVerifiedPicture(hash, ['https://fixture.invalid'], get);
    const card = await loadLogo(hash, ['https://fixture.invalid'], get, 1000);
    expect(page !== null).toBe(accepted);
    expect(card).toEqual(page);
    const source = { state: accepted ? 'shown' as const : 'missing' as const, url: accepted ? hash : null, ...(card ? { type: card.type } : {}) };
    const other = { state: 'shown' as const, url: 'different-cover', type: 'image/png' as const };
    const pageChoice = chooseSlotPicture('square', source, other);
    const cardChoice = chooseCardPicture(source, other);
    expect(pageChoice).toMatchObject({ kind: 'picture', which: accepted ? 'logo' : 'cover' });
    expect(cardChoice).toEqual(pageChoice);
    const decode = vi.fn(async () => true);
    resetPicturesForTests(get, decode);
    function Probe() {
      const state = usePictureState(hash, ['https://fixture.invalid']);
      const choice = chooseSlotPicture('square', { state: state.url ? 'shown' : state.missing ? 'missing' : 'pending', url: state.url }, other);
      return <output>{choice.kind === 'picture' ? choice.which : choice.kind}</output>;
    }
    const view = render(<Probe />);
    await waitFor(() => expect(view.container.textContent).toBe(accepted ? 'logo' : 'cover'));
    expect(decode).toHaveBeenCalledTimes(accepted ? 1 : 0);
    await act(async () => { cleanup(); });
  });
});

const states = ['none', 'missing', 'shown', 'withheld'] as const;
const choices = states.flatMap((logo) => states.map((cover) => ({ logo, cover,
  expected: logo === 'shown' ? 'logo' : logo === 'withheld' ? 'neutral' : cover === 'shown' ? 'cover' : 'neutral' })));
describe('page header and card select the same settled picture', () => {
  it.each(choices)('$logo / $cover → $expected', ({ logo, cover, expected }) => {
    const source = (state: SlotSource['state'], url: string): SlotSource => ({ state, url: state === 'shown' ? url : null });
    const a = source(logo, 'logo'), b = source(cover, 'cover');
    const page = chooseSlotPicture('square', a, b, true), card = chooseCardPicture(a, b);
    expect(card).toEqual(page);
    expect(card.kind === 'picture' ? card.url : 'neutral').toBe(expected);
  });
});

it('every usable fixture keeps the page-selected role before rendering, in either role', () => {
  for (const fixture of PICTURE_CASES.filter((f) => f.accepted)) {
    const picture = { state: 'shown' as const, url: fixture.name };
    const absent = { state: 'none' as const, url: null };
    for (const [a, b] of [[picture, absent], [absent, picture]] as const) {
      const page = chooseSlotPicture('square', a, b), card = chooseCardPicture(a, b);
      expect(card, fixture.name).toEqual(page);
    }
  }
});
