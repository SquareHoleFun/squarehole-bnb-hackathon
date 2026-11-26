// SH-294: a copy of apps/web/src/features/pictures/shrink.ts (the platform's own; the launch stage builds only bounties/,
// test/stage-imports.test.ts), unchanged. Change it there first, then here.
/**
 * SH-ARWEAVE-PICTURES-WEB (founder 2026-10-24: "free and shrunk by default"): Create shrinks a box's logo and cover
 * until they fit Turbo's free tier, before anything is signed. The ladders are the AI-size test's recommended setting
 * (14 real GPT Image pictures; worst SSIM at 640 px 0.929 with WebP, 0.888 with JPEG); the first step that fits wins.
 *
 * - A browser that writes WebP (Chrome, Edge, Firefox, Android): 1200 px max edge, PNG if at most 100 KiB, else WebP
 *   0.8, 0.7, 0.6; then 1024 px WebP 0.6; then 768 px WebP 0.8, 0.7, 0.6; then 512 px WebP 0.8.
 * - A browser without a WebP encoder (Safari, every iPhone browser): the picture is first painted onto the site's
 *   ground (#1b2638), so transparency does not turn black in JPEG; then JPEG 768 px 0.9, 0.8, 0.7, 0.6; then 512 px
 *   0.8, 0.6.
 * - Otherwise the picture is refused with one short line (TOO_DETAILED), before the box is created: there is no paid
 *   upload and no larger fallback while Arweave is on.
 * "Fits" is the caller's check (arweave-publish.ts `fitsFree`): Turbo's free size from its `/info`, less the signed
 * item's header and tags. The encoder is detected at run time (`webp()`), never guessed from the browser's name.
 */

export type PictureMime = 'image/png' | 'image/webp' | 'image/jpeg';
export interface ShrinkStep {
  /** The longest side, in px (a smaller picture is never enlarged). */
  readonly edge: number;
  readonly type: PictureMime;
  readonly quality?: number;
  /** A tighter byte cap than the free fit, for this step only (the PNG step's 100 KiB). */
  readonly maxBytes?: number;
}

export const WEBP_LADDER: readonly ShrinkStep[] = Object.freeze([
  { edge: 1200, type: 'image/png', maxBytes: 100 * 1024 },
  { edge: 1200, type: 'image/webp', quality: 0.8 },
  { edge: 1200, type: 'image/webp', quality: 0.7 },
  { edge: 1200, type: 'image/webp', quality: 0.6 },
  { edge: 1024, type: 'image/webp', quality: 0.6 },
  { edge: 768, type: 'image/webp', quality: 0.8 },
  { edge: 768, type: 'image/webp', quality: 0.7 },
  { edge: 768, type: 'image/webp', quality: 0.6 },
  { edge: 512, type: 'image/webp', quality: 0.8 },
]);
export const JPEG_LADDER: readonly ShrinkStep[] = Object.freeze([
  { edge: 768, type: 'image/jpeg', quality: 0.9 },
  { edge: 768, type: 'image/jpeg', quality: 0.8 },
  { edge: 768, type: 'image/jpeg', quality: 0.7 },
  { edge: 768, type: 'image/jpeg', quality: 0.6 },
  { edge: 512, type: 'image/jpeg', quality: 0.8 },
  { edge: 512, type: 'image/jpeg', quality: 0.6 },
]);
/** The ground under a transparent picture on the JPEG path: the AI-size test's site ground, close to the box tiles' colour. */
export const SITE_GROUND = '#1b2638';

/** The one line a picture gets when no step fits (wording for the founder). */
export const TOO_DETAILED = 'Too detailed to store for free. Try a simpler picture.';
/**
 * A picture this browser cannot draw: not a new line (fix round 1, F3). It is the one the logo and cover have shown
 * for the same failure since 2026-10-03 (create/art-files.ts `encodeCover`, which now uses this constant), so both
 * paths say the same thing.
 */
export const UNREADABLE = 'This browser could not read the picture.';

/** What shrinking needs from the browser; the tests pass their own. */
export interface PictureEncoder<Canvas> {
  /** Whether this browser writes WebP (asked once per page load by the browser encoder). */
  webp(): Promise<boolean>;
  /** The picture drawn within `edge` px on a fresh canvas (pixels only), on `ground` when given; null when unreadable. */
  draw(file: Blob, edge: number, ground: string | null): Promise<Canvas | null>;
  /** The canvas encoded as `type` at `quality`; a browser that cannot write `type` answers another type (skipped). */
  encode(canvas: Canvas, type: PictureMime, quality: number | undefined): Promise<Blob | null>;
}

export type Shrunk =
  | { readonly bytes: Uint8Array; readonly type: PictureMime; readonly step: ShrinkStep }
  | { readonly error: string };

/** The first ladder step whose result fits (`fits(bytes, type)`), or the refusal. */
export async function shrinkPicture<Canvas>(file: Blob, fits: (bytes: number, type: string) => boolean, encoder: PictureEncoder<Canvas>): Promise<Shrunk> {
  const webp = await encoder.webp().catch(() => false);
  const ladder = webp ? WEBP_LADDER : JPEG_LADDER;
  const ground = webp ? null : SITE_GROUND;
  // One drawing per edge: every step at that edge encodes the same canvas.
  const drawn = new Map<number, { readonly canvas: Canvas }>();
  for (const step of ladder) {
    let entry = drawn.get(step.edge);
    if (entry === undefined) {
      const canvas = await encoder.draw(file, step.edge, ground);
      if (canvas === null) return { error: UNREADABLE };
      entry = { canvas };
      drawn.set(step.edge, entry);
    }
    const blob = await encoder.encode(entry.canvas, step.type, step.quality);
    if (blob === null || blob.type !== step.type || blob.size > (step.maxBytes ?? Number.POSITIVE_INFINITY) || !fits(blob.size, step.type)) continue;
    return { bytes: new Uint8Array(await blob.arrayBuffer()), type: step.type, step };
  }
  return { error: TOO_DETAILED };
}
