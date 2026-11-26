/**
 * SH-ARWEAVE-PICTURES-WEB: under a v2 box's neutral placeholder, "Add picture" where its committed logo or cover is on
 * no gateway once the lookup has ended (pictures/add-picture.ts says which files count). The page checks the file
 * against the box's commitment and publishes it to Arweave through Turbo's free tier with a throwaway key: no wallet,
 * no account. It shows only where the source keeps pictures on Arweave, and never for box 0 (its bundled pictures).
 * SH-WITHHELD-SITE fix round af3 (founder decision R77-TAKEDOWN-CREATE, "refuse"): a picture our withheld list names is
 * never offered here (its state is withheld, not missing), and the file a creator picked is checked against the list
 * as it is right before its upload: listed by then, nothing is sent, and the line says REFUSED_PICTURE_TEXT. Fix round
 * af4: the publisher asks the same check again right before its upload request.
 */
import { useState, type ChangeEvent } from 'react';
import { lookupOf, showPublishedPicture, usePictureState } from '../../boxes/box-pictures';
import type { BoxRecord } from '../../boxes/box-model';
import { mayBeBundled } from '../../boxes/bundled-pictures';
import { BROWSER_ART, fromBase64, readPicture } from '../../create/art-files';
import { NOT_THIS_PICTURE, matchPicture } from '../../pictures/add-picture';
import { freeFit, publishToArweave, type PublishResult } from '../../pictures/arweave-publish';
import { REFUSED_PICTURE_TEXT, refusedPicture } from '../../pictures/withheld';

type Phase = 'idle' | 'checking' | 'publishing' | 'refused' | 'withheld' | 'too-large' | 'failed';
/** The status line under the button (wording for the founder). */
export const ADD_PICTURE_LINES: Readonly<Record<Exclude<Phase, 'idle'>, string>> = {
  checking: 'Checking…',
  publishing: 'Publishing…',
  refused: NOT_THIS_PICTURE,
  withheld: REFUSED_PICTURE_TEXT,
  'too-large': 'Too large to store for free.',
  failed: 'Not published. Try again.',
};

export interface AddPictureSeams {
  /** The upload (default: Turbo). */
  readonly publish?: typeof publishToArweave;
  /** Create's own shrinking of an original picture (default: the browser's free ladder; null: none). */
  readonly reshrink?: ((file: Blob) => Promise<Uint8Array | null>) | null;
}

/** Create's shrinking for this chain, with Turbo's free size as it stands now: the same bytes Create committed. */
const createShrink = (chainId: number) => async (file: Blob): Promise<Uint8Array | null> => {
  const read = await readPicture(file as File, BROWSER_ART, 'logo', await freeFit(chainId));
  return 'error' in read ? null : fromBase64(read.picture.data);
};

export function AddPictureV2({ record, seams = {} }: { record: BoxRecord; seams?: AddPictureSeams }) {
  const logo = lookupOf(record.pictures, 'logo');
  const cover = lookupOf(record.pictures, 'cover');
  const logoState = usePictureState(logo.sha256, logo.gateways, logo.arweave);
  const coverState = usePictureState(cover.sha256, cover.gateways, cover.arweave);
  const [phase, setPhase] = useState<Phase>('idle');
  const chainId = record.v2Chain?.source?.manifest.chainId ?? null;
  const missing = [...new Set([logoState.missing ? logo.sha256 : null, coverState.missing ? cover.sha256 : null]
    .filter((hash): hash is `0x${string}` => hash !== null && !mayBeBundled(hash)))];
  if (!record.pictures?.arweave || chainId === null || missing.length === 0) return null;

  const busy = phase === 'checking' || phase === 'publishing';
  const add = async (file: File) => {
    setPhase('checking');
    const reshrink = seams.reshrink === undefined ? createShrink(chainId) : seams.reshrink;
    const match = await matchPicture(file, missing, reshrink).catch(() => null);
    if (match === null) { setPhase('refused'); return; }
    // Right before the upload, by the list as it is now (a refresh while the file was checked can name it).
    if (await refusedPicture([match.sha256])) { setPhase('withheld'); return; }
    setPhase('publishing');
    const [result]: readonly (PublishResult | undefined)[] = await (seams.publish ?? publishToArweave)([{ sha256: match.sha256, bytes: match.bytes }], {
      chainId, refuse: () => refusedPicture([match.sha256]),
    });
    if (result?.ok) {
      await showPublishedPicture(match.sha256, match.bytes, result.id);
      setPhase('idle');
    } else setPhase(result && !result.ok && result.reason === 'withheld' ? 'withheld' : result && !result.ok && result.reason === 'too-large' ? 'too-large' : 'failed');
  };
  const pick = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (file) void add(file);
  };
  const line = phase === 'idle' ? null : ADD_PICTURE_LINES[phase];
  return (
    <div className="sh-v2-add-picture" data-add-picture={phase}>
      <label className="sh-button sh-v2-add-picture__button" data-busy={busy || undefined}>
        <input type="file" accept="image/png,image/jpeg,image/webp,.json,application/json" disabled={busy} aria-describedby={line ? 'sh-v2-add-picture-line' : undefined} onChange={pick} />
        <span>Add picture</span>
      </label>
      {line ? <p id="sh-v2-add-picture-line" role="status" data-add-picture-status="">{line}</p> : null}
    </div>
  );
}
