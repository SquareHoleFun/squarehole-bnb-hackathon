/**
 * SH-192 (BOXSPEC-AUTOSAVE): Create's own save of the box file (box-file-save.ts). The save window first (asked before
 * the parts are built, while the press still counts as a gesture), the file written part by part and closed; a closed
 * window saves nothing and says so; a refused window falls back to the download; without the window, the download.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoxFileError, FILE_FAILED, SAVE_CLOSED, saveBoxFile } from './box-file-save';

const NAME = 'rentfree-boxspec-v2.json';
const PARTS = ['{"format":', '"squarehole.boxspec/2"}\n'];

function pickerHost(options: { refuse?: DOMException; failWrite?: boolean } = {}) {
  const order: string[] = [];
  const written: BlobPart[] = [];
  const writable = {
    write: vi.fn(async (part: BlobPart) => { if (options.failWrite) throw new DOMException('Disk full', 'QuotaExceededError'); written.push(part); }),
    close: vi.fn(async () => { order.push('close'); }),
    abort: vi.fn(async () => { order.push('abort'); }),
  };
  const handle = { name: 'rent-free-boxspec.json', createWritable: vi.fn(async () => writable), remove: vi.fn(async () => { order.push('remove'); }) };
  const showSaveFilePicker = vi.fn(async (picked: { suggestedName: string }) => {
    order.push(`picker:${picked.suggestedName}`);
    if (options.refuse) throw options.refuse;
    return handle;
  });
  return { host: { showSaveFilePicker }, order, written, writable, handle, showSaveFilePicker };
}

let clicks: ReturnType<typeof vi.spyOn>;
const urls = { createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
beforeEach(() => {
  clicks = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:box'), revokeObjectURL: vi.fn() });
});
afterEach(() => { vi.restoreAllMocks(); Object.assign(URL, urls); });

describe('SH-192 saving the box file on Create', () => {
  it('the save window: asked before the parts are built, then each part written and the file closed, under the name kept', async () => {
    const t = pickerHost();
    const build = vi.fn(async () => { t.order.push('build'); return PARTS; });
    expect(await saveBoxFile(NAME, build, t.host)).toEqual({ name: 'rent-free-boxspec.json', via: 'picker' });
    expect(t.order).toEqual([`picker:${NAME}`, 'build', 'close']);
    expect(t.written).toEqual(PARTS);
    expect(clicks).not.toHaveBeenCalled();
  });

  it('a closed save window saves nothing: the line says so, the parts are never built, nothing downloads', async () => {
    const t = pickerHost({ refuse: new DOMException('The user aborted a request.', 'AbortError') });
    const build = vi.fn(async () => PARTS);
    await expect(saveBoxFile(NAME, build, t.host)).rejects.toEqual(new BoxFileError(SAVE_CLOSED));
    expect(build).not.toHaveBeenCalled();
    expect(clicks).not.toHaveBeenCalled();
  });

  it('a refused save window (no gesture left, a policy): the download instead', async () => {
    const t = pickerHost({ refuse: new DOMException('Must be handling a user gesture', 'SecurityError') });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await saveBoxFile(NAME, async () => PARTS, t.host)).toEqual({ name: NAME, via: 'download' });
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it('a failed build preserves the selected older backup without opening or removing it', async () => {
    const t = pickerHost();
    let contents = 'older backup with irreplaceable salts';
    t.handle.remove.mockImplementation(async () => { contents = ''; });
    await expect(saveBoxFile(NAME, async () => { throw new BoxFileError('Add the item pictures again'); }, t.host)).rejects.toThrow('Add the item pictures again');
    expect(t.order).toEqual([`picker:${NAME}`]);
    expect(t.handle.remove).not.toHaveBeenCalled();
    expect(t.handle.createWritable).not.toHaveBeenCalled();
    expect(contents).toBe('older backup with irreplaceable salts');
  });

  it('a write that fails: the file is aborted and the line says it could not be saved', async () => {
    const t = pickerHost({ failWrite: true });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(saveBoxFile(NAME, async () => PARTS, t.host)).rejects.toEqual(new BoxFileError(FILE_FAILED));
    expect(t.order).toEqual([`picker:${NAME}`, 'abort']);
  });

  it('a close that fails is not a saved file and aborts the writable stream', async () => {
    const t = pickerHost();
    t.writable.close.mockRejectedValue(new Error('disk full on close'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(saveBoxFile(NAME, async () => PARTS, t.host)).rejects.toEqual(new BoxFileError(FILE_FAILED));
    expect(t.writable.abort).toHaveBeenCalledTimes(1);
    expect(t.handle.remove).not.toHaveBeenCalled();
  });

  it('no save window in this browser: the download, as Download BoxSpec; a download the browser refuses is a failed save', async () => {
    expect(await saveBoxFile(NAME, async () => PARTS, {})).toEqual({ name: NAME, via: 'download' });
    expect(clicks).toHaveBeenCalledTimes(1);
    clicks.mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(saveBoxFile(NAME, async () => PARTS, {})).rejects.toEqual(new BoxFileError(FILE_FAILED));
  });
});
