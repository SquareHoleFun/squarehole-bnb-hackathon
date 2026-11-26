/**
 * SH-ARWEAVE-PICTURES-WEB (founder 2026-10-24: "free and shrunk by default"): Create's side of the free tier, where the
 * source keeps a v2 box's logo and cover on Arweave.
 * - `readFit`: the check the logo and cover are shrunk to as they are read (use-create-flow.ts `useArtReading`), with
 *   Turbo's free size from its `/info` (asked when a picture is read, never on navigation).
 * - `refused`: the draft holds a logo or cover that does not fit (one from an earlier draft or a loaded setup); Create
 *   is then refused with one short line, before anything is signed.
 * - `beforeCreate`: Create's press asks Turbo's free size again and starts only when both pictures fit it.
 * - `ArweaveLines`: the line before Create ("public and permanent") and the refusal.
 * Which pictures: the ones the press commits (`spec`): the draft's on a press that prepares it, a saved run's own on a
 * press that resumes it before its createBox was sent (fix round 1, F4), none (null) once it was.
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { fitsFree, freeFit, knownFreeLimit, type FreeFit } from '../../pictures/arweave-publish';
import { TOO_DETAILED } from '../../pictures/shrink';
import { freePicturesRefused, type PictureDraft } from './pictures';
import type { BoxSpecV2 } from './spec-types';

/** The one line before Create where the logo and cover go on Arweave (wording for the founder and counsel: nobody can delete them). */
export const ARWEAVE_NOTE = 'Logo and cover go on Arweave: public and permanent.';

export interface FreePicturesInput {
  /** The source keeps v2 pictures on Arweave. */
  readonly on: boolean;
  readonly chainId: number | null;
  /** The pictures Create's press commits (see above); null: none left to check. */
  readonly spec: Pick<BoxSpecV2, 'coverSha256' | 'collectionCoverSha256'> | null;
  readonly draft: Pick<PictureDraft, 'cover' | 'collectionCover'>;
  /** Test seam: the fit with Turbo's free size now (default: `freeFit`, which asks `/info` once per page load). */
  readonly fitNow?: (chainId: number) => Promise<FreeFit>;
}

export function useFreePictures({ on, chainId, spec, draft, fitNow = freeFit }: FreePicturesInput) {
  const active = on && chainId !== null;
  const readFit = useMemo(() => (active && chainId !== null ? () => fitNow(chainId) : null), [active, chainId, fitNow]);
  const key = spec === null ? null : `${spec.coverSha256}:${spec.collectionCoverSha256}`.toLowerCase();
  const lifetime = useRef({ cancelled: false });
  useLayoutEffect(() => {
    const current = { cancelled: false };
    lifetime.current = current;
    return () => { current.cancelled = true; };
  }, [key, chainId, active]);
  // A press that found the pictures too big for Turbo's free size as it stood then, for these pictures.
  const [refusedAt, setRefusedAt] = useState<string | null>(null);
  const refused = active && spec !== null && (refusedAt === key || freePicturesRefused(spec, draft, fitsFree(chainId, knownFreeLimit())));
  /** Runs `start` once the pictures fit Turbo's free size as `/info` states it now; otherwise shows the refusal. */
  const beforeCreate = (start: () => void) => {
    const current = lifetime.current;
    if (current.cancelled) return;
    if (!active || chainId === null || spec === null) { start(); return; }
    void fitNow(chainId).then((fits) => {
      if (current.cancelled) return;
      const tooBig = freePicturesRefused(spec, draft, fits);
      setRefusedAt(tooBig ? key : null);
      if (!tooBig) start();
    });
  };
  return { on: active, readFit, refused, beforeCreate };
}

/** The line before Create, and the refusal while a picture does not fit. */
export function ArweaveLines({ on, refused }: { on: boolean; refused: boolean }) {
  if (!on) return null;
  return (
    <>
      <p className="sh-newbox-note" data-arweave-note="">{ARWEAVE_NOTE}</p>
      {refused ? <p className="sh-newbox-error" role="alert" data-pictures-refused=""><span aria-hidden="true">!</span> {TOO_DETAILED}</p> : null}
    </>
  );
}
