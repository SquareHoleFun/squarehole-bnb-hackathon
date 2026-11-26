import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { sha256Hex } from '@squarehole/artwork';
import { browserDecodes, DECODE_TIMEOUT_MS, resetPicturesForTests, usePictureState } from './box-pictures';
import { pictureFixture } from '../../../../../packages/artwork/src/picture-fixtures';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); resetPicturesForTests(); });
it('a timed-out decode detaches src, revokes the blob, and cannot publish a late success', async () => {
  vi.useFakeTimers();
  const bytes = pictureFixture('ordinary.png'), hash = sha256Hex(bytes);
  let finish: () => void = () => undefined;
  const img = { decoding: '', src: '', naturalWidth: 3, naturalHeight: 2, onload: null, onerror: null,
    decode: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })), removeAttribute: vi.fn() };
  vi.stubGlobal('Image', function () { return img; });
  const create = vi.fn(() => 'blob:timeout'), revoke = vi.fn();
  const original = globalThis.URL;
  class TestURL extends original { static override createObjectURL = create; static override revokeObjectURL = revoke; }
  vi.stubGlobal('URL', TestURL);
  resetPicturesForTests(async () => new Response(bytes.slice()), browserDecodes);
  function Probe() { const s = usePictureState(hash, ['https://fixture.invalid']); return <output>{s.url ?? (s.missing ? 'missing' : 'pending')}</output>; }
  const view = render(<Probe />);
  await act(async () => { await vi.waitFor(() => expect(img.decode).toHaveBeenCalledOnce()); });
  expect(img.decode).toHaveBeenCalledOnce();
  await act(async () => { await vi.advanceTimersByTimeAsync(DECODE_TIMEOUT_MS); });
  expect(view.container.textContent).toBe('missing');
  expect(img.removeAttribute).toHaveBeenCalledWith('src');
  expect(img.onload).toBeNull(); expect(img.onerror).toBeNull();
  expect(revoke).toHaveBeenCalledWith('blob:timeout');
  await act(async () => { finish(); });
  expect(view.container.textContent).toBe('missing');
});

it('the production decoder refuses huge dimensions without constructing an Image', async () => {
  const image = vi.fn(); vi.stubGlobal('Image', image);
  expect(await browserDecodes('blob:huge', { bytes: pictureFixture('huge.png'), type: 'image/png' })).toBe(false);
  expect(image).not.toHaveBeenCalled();
});
