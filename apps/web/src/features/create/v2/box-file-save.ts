/**
 * SH-192 (BOXSPEC-AUTOSAVE): Create saves the box file itself, on its press, before anything is sent. Where the browser
 * offers the File System Access API (`showSaveFilePicker`), the creator picks where it goes and the page writes it there
 * and knows the write finished; elsewhere (or where the picker is refused) it requests a download, which is not
 * proof of a saved file. The picker is asked first, while the press still counts as the creator's gesture, and the file's
 * parts are built after: a large collection's pictures can take longer than the gesture lasts.
 */

/** The file could not be built or saved (the browser refused it, ran out of room, or a picture is missing). */
export const FILE_FAILED = 'The BoxSpec file could not be saved. Try again.';
/** The creator closed the save window: nothing was written, and nothing is sent. */
export const SAVE_CLOSED = 'Not saved: the save window was closed. Nothing was sent.';

/** Why a save failed, in the page's words (`message`). */
export class BoxFileError extends Error {
  override readonly name = 'BoxFileError';
}

export interface SavedBoxFile {
  /** The name the file was saved under (the picker's, which the creator may change). */
  readonly name: string;
  /** Only picker means a completed write and close. Download is an unconfirmed request. */
  readonly via: 'picker' | 'download';
}

interface WritableLike {
  write(data: BlobPart): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}
interface HandleLike {
  readonly name?: string;
  createWritable(): Promise<WritableLike>;
}
type SavePicker = (options: { suggestedName: string; types: readonly { description: string; accept: Record<string, readonly string[]> }[] }) => Promise<HandleLike>;

/** Requests a download; true only means the click did not throw, never proof that a file was saved. */
export function download(name: string, parts: readonly BlobPart[]): boolean {
  try {
    const url = URL.createObjectURL(new Blob([...parts], { type: 'application/json' }));
    const link = Object.assign(document.createElement('a'), { href: url, download: name, rel: 'noopener' });
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    return true;
  } catch (error) {
    console.error('Create v2: the file could not be saved', error);
    return false;
  }
}

const aborted = (error: unknown): boolean => error instanceof DOMException && error.name === 'AbortError';

/**
 * Saves the box file: through the save window where there is one, else as a download. `build` gives the parts (it may
 * throw a BoxFileError with its own line, such as a picture to add again). Only `via: picker` proves a saved file.
 */
export async function saveBoxFile(name: string, build: () => Promise<readonly BlobPart[]>, host: object = window): Promise<SavedBoxFile> {
  const picker = (host as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (typeof picker === 'function') {
    let handle: HandleLike | null = null;
    try {
      handle = await picker.call(host, { suggestedName: name, types: [{ description: 'BoxSpec file', accept: { 'application/json': ['.json'] } }] });
    } catch (error) {
      if (aborted(error)) throw new BoxFileError(SAVE_CLOSED);
      // Refused (the gesture expired, a policy): the download below, as before.
      console.warn('Create v2: the save window was refused; downloading instead', error);
    }
    if (handle) return { name: await writeTo(handle, build, name), via: 'picker' };
  }
  const parts = await build();
  if (!download(name, parts)) throw new BoxFileError(FILE_FAILED);
  return { name, via: 'download' };
}

async function writeTo(handle: HandleLike, build: () => Promise<readonly BlobPart[]>, name: string): Promise<string> {
  // A picker may return an older backup. We cannot know who created it: never remove it.
  const parts = await build();
  let writable: WritableLike | null = null;
  try {
    writable = await handle.createWritable();
    for (const part of parts) await writable.write(part);
    await writable.close();
  } catch (error) {
    console.error('Create v2: the file could not be written', error);
    await writable?.abort?.().catch(() => undefined);
    throw new BoxFileError(FILE_FAILED);
  }
  return handle.name || name;
}
