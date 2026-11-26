/**
 * SH-ARWEAVE-PICTURES-WEB (founder 2026-10-24; from the SH-ARWEAVE-PICTURES-SPIKE prototype): Create publishes the
 * box's logo and cover to Arweave through Turbo's free tier with a throwaway key (pictures/arweave-publish.ts): no
 * wallet prompt, no account, no cost, and the key is never saved or shown.
 *
 * Fix round 1 (integrator decision, F1): the pictures go BEFORE the createBox transaction makes their hashes public.
 * Create's press runs its checks and prepares the plan; then, before the wallet is asked for anything while the box is
 * not created (useCreateSend `beforeWallet`), both pictures are published and the press waits for Turbo's answer and
 * each id. So the real copy is the oldest Arweave holds, ahead of any decoy made from the chain (the reader and the
 * indexer read candidates oldest first). A creator who stops there leaves the pictures on Arweave: public and
 * permanent, as the line before Create says.
 *
 * One short status line. A failed publish stops that press before the wallet, with Retry where it can help; the next
 * press goes on without it (Create is never held for good: the box page's Add picture is the fallback). A picture is
 * not sent again when this tab already published it (remembered by hash for the tab, sessionStorage, best effort) or
 * when Arweave already has a copy whose bytes match (found by its fingerprint, pictures/arweave-read.ts: anyone's copy
 * is the same picture), so a reload, a Continue or a second box with the same logo sends nothing twice. A picture
 * published here shows at once on this tab's box page and feed.
 *
 * SH-WITHHELD-SITE fix round af2 (founder decision R77-TAKEDOWN-CREATE, "refuse"): Create never uploads a picture on our
 * withheld list. Every press checks the pictures the spec commits by their own ids (`ipfs:` + the raw CID of each
 * committed hash: exactly its bytes) through the site's one reader (pictures/withheld.ts `refusedPicture`), before
 * anything is searched or sent; one listed, and the press stops before the wallet with one line, REFUSED_PICTURE_TEXT,
 * and no Retry. Nothing reaches Arweave, every press with that picture stops the same way, and the rest of Create stays
 * as it was: another picture goes on. Fix round af3: every picture the spec commits counts, the page's banner and
 * teasers and a new collection's items too (pictures.ts `committedPictureHashes`), on every path: the first press,
 * Retry, and a press after a failed one; and the list as it is then is asked again at each later step of a publish
 * (once the pictures are read, right before the upload, and before the wallet may open), so a list read during the
 * fingerprint search or the upload stops the press there. Fix round af4: the publisher asks the same guard right before
 * each picture's upload request, so a picture still unsent when the list names one of them is never sent; the list is
 * asked once the upload settles, whatever its outcome; the hidden placeholder picture counts; and a new collection is
 * checked only with the art its spec commits (a resumed run keeps its own spec): other art in the draft, or none, and the
 * press stops with ORIGINAL_ART_TEXT, on every path.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { showPublishedPicture } from '../../boxes/box-pictures';
import { publishToArweave, type PictureToPublish, type PublishFailure, type PublishOptions, type PublishResult } from '../../pictures/arweave-publish';
import { arweavePicture } from '../../pictures/arweave-read';
import { REFUSED_PICTURE_TEXT, isWithheldResult, refusedPicture } from '../../pictures/withheld';
import type { Hex } from '../create-model';
import { committedPictureHashes, logoAndCover, type PictureDraft } from './pictures';
import type { BoxSpecV2 } from './spec-types';

export type PicturesView =
  | { readonly phase: 'off' }
  | { readonly phase: 'publishing'; readonly done: number; readonly total: number }
  | { readonly phase: 'published'; readonly total: number }
  | { readonly phase: 'failed'; readonly done: number; readonly total: number; readonly reason: PublishFailure | 'missing' }
  /** A picture the spec commits is on our withheld list (fix round af2): nothing is sent. */
  | { readonly phase: 'withheld' }
  /** A new collection's draft holds other art than its spec commits, or none (fix round af4): nothing is sent. */
  | { readonly phase: 'art' };

/** Fix round af4: the line when the draft's art is not the art the box's spec commits (wording for the founder). */
export const ORIGINAL_ART_TEXT = 'Add this box’s own item pictures again to go on.';

/** Session key: the pictures this tab published, sha256 → Arweave id (privacy.ts lists it). */
export const PUBLISHED_KEY = 'sh.create.v2.arweave';
function published(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(PUBLISHED_KEY) ?? '{}');
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, string>) : {};
  } catch {
    return {};
  }
}
function remember(sha256: string, id: string): void {
  try { window.sessionStorage.setItem(PUBLISHED_KEY, JSON.stringify({ ...published(), [sha256.toLowerCase()]: id })); } catch { /* best effort */ }
}

/** The status line (wording for the founder): numbers first, a few words. */
export function picturesText(view: PicturesView): string | null {
  if (view.phase === 'off') return null;
  if (view.phase === 'publishing') return `Publishing pictures · ${view.done}/${view.total}`;
  if (view.phase === 'published') return `Pictures published · ${view.total}/${view.total}`;
  if (view.phase === 'withheld') return REFUSED_PICTURE_TEXT;
  if (view.phase === 'art') return ORIGINAL_ART_TEXT;
  if (view.reason === 'too-large') return `Too large to store for free · ${view.done}/${view.total}`;
  if (view.reason === 'missing' || view.reason === 'mismatch' || view.reason === 'type') return `Pictures missing · ${view.done}/${view.total}. Add them on the box page.`;
  return `Pictures not published · ${view.done}/${view.total}`;
}
const retries = (view: PicturesView) => view.phase === 'failed' && (view.reason === 'network' || view.reason === 'refused');

/**
 * How a press's publish ended: nothing left to send, a failure (the next press goes on), or refused (every press
 * stops): a listed picture, or (af4) art that is not the spec's.
 */
type Outcome = 'published' | 'failed' | 'withheld' | 'art';

export interface PicturePublishInput {
  /** The source keeps v2 pictures on Arweave (deployments-plugin.ts `arweavePictures`); false: off. */
  readonly on: boolean;
  readonly draft: PictureDraft;
  readonly chainId: number | null;
  readonly digest: (bytes: Uint8Array) => Promise<Hex>;
  /** Test seam (default: Turbo). */
  readonly publish?: (pictures: readonly PictureToPublish[], options: PublishOptions) => Promise<readonly PublishResult[]>;
  /** Test seam: whether Arweave already has a copy with these bytes (default: the reader's search). */
  readonly onArweave?: (sha256: Hex) => Promise<boolean>;
}
/**
 * How long Create's press waits for the fingerprint check (whether Arweave already has these bytes) before it publishes
 * anyway: it now runs before the wallet, and a search that finds nothing waits for the slowest gateway (goldsky took
 * 0.8 to 12.7 s, mostly over 7 s, or answered HTTP 570, in this round's read-only checks). A check cut short costs at
 * most one more free upload of the same bytes, never a wrong picture.
 */
export const FOUND_CHECK_MS = 5_000;
/**
 * Whether Arweave already has a copy of these exact bytes (the reader's search, its bytes checked), within FOUND_CHECK_MS.
 * A picture our withheld list names is not looked for (SH-WITHHELD-SITE), so it is not known to be there: false.
 */
export const alreadyOnArweave = async (sha256: Hex) => {
  const found = await arweavePicture(sha256, { search: true, budgetMs: FOUND_CHECK_MS });
  return found !== null && !isWithheldResult(found);
};

export function usePicturePublish({ on, draft, chainId, digest, publish = publishToArweave, onArweave = alreadyOnArweave }: PicturePublishInput) {
  const [view, setView] = useState<PicturesView>({ phase: 'off' });
  const latest = useRef({ on, draft, chainId, digest, publish, onArweave });
  useEffect(() => { latest.current = { on, draft, chainId, digest, publish, onArweave }; });
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  // The pictures the last press asked for (Retry publishes them again), the publishes in turn (one at a time), and the
  // pictures whose publish already failed a press (the next press goes on).
  const asked = useRef<BoxSpecV2 | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const passed = useRef(new Set<string>());

  /** Publishes what is still unpublished of `spec`'s logo and cover; 'published' when nothing is left to publish. */
  const publishNow = useCallback((spec: BoxSpecV2): Promise<Outcome> => {
    const go = async (): Promise<Outcome> => {
      const { draft: pictures, chainId: chain, digest: hash, publish: send, onArweave: found } = latest.current;
      if (chain === null) return 'published';
      const show = (next: PicturesView) => { if (live.current) setView(next); };
      try {
        // Fix round af2: a picture our withheld list names is never sent, nor searched for; nothing else is either.
        // Fix round af3: any picture the spec commits (banner, teasers and items included), by the list as it is at
        // each step below; listed at any of them, the press stops there with the line, and nothing more is sent.
        const committed = committedPictureHashes(spec, pictures.art);
        // Fix round af4: other art than the spec commits, or none: its item pictures cannot be checked; nothing goes.
        if (committed === null) { show({ phase: 'art' }); return 'art'; }
        const refused = async (): Promise<boolean> => {
          if (!(await refusedPicture(committed))) return false;
          show({ phase: 'withheld' });
          return true;
        };
        if (await refused()) return 'withheld';
        const { pictures: ready, missing } = await logoAndCover(spec, pictures, hash);
        // Once the pictures are read (each hashed), before the fingerprint searches.
        if (await refused()) return 'withheld';
        const total = ready.length + missing.length;
        if (total === 0) { show({ phase: 'off' }); return 'published'; }
        const known = published();
        const fresh = ready.filter((picture) => !known[picture.sha256.toLowerCase()]);
        show({ phase: 'publishing', done: ready.length - fresh.length, total });
        const there = await Promise.all(fresh.map((picture) => found(picture.sha256).catch(() => false)));
        const todo = fresh.filter((_, i) => !there[i]);
        let done = ready.length - todo.length;
        // Right before the upload: a list read during the searches can name one of the pictures by now.
        if (await refused()) return 'withheld';
        show({ phase: 'publishing', done, total });
        const results = todo.length === 0 ? [] : await send(todo.map(({ sha256, bytes }) => ({ sha256, bytes })), {
          chainId: chain,
          // Fix round af4: right before each upload request, every picture the spec commits, by the list as it is then.
          refuse: () => refusedPicture(committed),
          onResult: (result) => {
            if (!result.ok) return;
            remember(result.sha256, result.id);
            const bytes = todo.find((picture) => picture.sha256.toLowerCase() === result.sha256)?.bytes;
            if (bytes) void showPublishedPicture(result.sha256, bytes, result.id);
            done += 1;
            show({ phase: 'publishing', done, total });
          },
        });
        // Once the upload has settled, whatever its outcome (fix round af4): the guard stopped the batch (what was not
        // sent stays unsent), or the list names a picture by now; either way the press stops with the line, before the
        // wallet. Withheld wins over a failed upload or a missing picture.
        const stopped = results.some((result) => !result.ok && result.reason === 'withheld');
        if (stopped || (await refused())) { show({ phase: 'withheld' }); return 'withheld'; }
        const failures = results.flatMap((result) => (result.ok ? [] : [result.reason]));
        const reason = failures.find((entry) => entry === 'network' || entry === 'refused') ?? failures[0] ?? (missing.length > 0 ? 'missing' : null);
        show(reason === null ? { phase: 'published', total } : { phase: 'failed', done, total, reason });
        return reason === null ? 'published' : 'failed';
      } catch (error) {
        console.error('Create v2: the pictures were not published', error);
        show({ phase: 'failed', done: 0, total: 1, reason: 'network' });
        return 'failed';
      }
    };
    // One publish at a time (a Retry and a press never send the same picture twice at once).
    const next = queue.current.then(go, go);
    queue.current = next;
    return next;
  }, []);

  /**
   * useCreateSend's `beforeWallet` for Create's press (after its checks, before the wallet, while the box is not
   * created): true once both pictures are on Arweave (published here with Turbo's ids, or found there), so the wallet
   * may open; false when they are not, which stops this press before the wallet. A press for pictures that already
   * failed one goes on (true) without publishing again: Retry, or the box page's Add picture, is the way then. Fix round
   * af2: a press whose pictures our withheld list names stops (false) every time, one that failed before included.
   */
  const beforeWallet = useCallback(async (spec: BoxSpecV2): Promise<boolean> => {
    const { on: active, chainId: chain } = latest.current;
    if (!active || chain === null) return true;
    const key = `${chain}:${spec.coverSha256}:${spec.collectionCoverSha256}`.toLowerCase();
    if (passed.current.has(key)) {
      const committed = committedPictureHashes(spec, latest.current.draft.art);
      if (committed === null) { if (live.current) setView({ phase: 'art' }); return false; }
      if (!(await refusedPicture(committed))) return true;
      if (live.current) setView({ phase: 'withheld' });
      return false;
    }
    asked.current = spec;
    const outcome = await publishNow(spec);
    if (outcome === 'failed') passed.current.add(key);
    return outcome === 'published';
  }, [publishNow]);
  const retryNow = useCallback(() => { const spec = asked.current; if (spec !== null) void publishNow(spec); }, [publishNow]);

  return { view, beforeWallet, retry: retries(view) ? retryNow : null };
}

/** The line under the plan, and Retry when an upload failed. */
export function PicturesStatus({ view, onRetry }: { view: PicturesView; onRetry: (() => void) | null }) {
  const text = picturesText(view);
  if (text === null) return null;
  return (
    <div className="sh-v2-pictures" data-pictures-phase={view.phase}>
      <p className="sh-newbox-status" role="status" data-pictures-status="">{text}</p>
      {onRetry ? <button type="button" className="sh-button" onClick={onRetry}>Retry</button> : null}
    </div>
  );
}
