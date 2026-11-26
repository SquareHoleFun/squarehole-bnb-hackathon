/**
 * Dev-only poster renderer: poster.html?variant=pin|wizard renders the settled (rest) frame of the real
 * scene at 2x on a transparent background and exposes it as a WebP data URL for tools/render-posters.ts.
 */
import { probeWebGLContext } from './gate';
import type { SceneVariant } from './sceneTypes';
import { createShapeSorterScene } from './sorterScene';
import { POSTER_PIXEL_RATIO, VARIANTS } from './variants';

export type PosterResult =
  | { readonly dataUrl: string; readonly width: number; readonly height: number; readonly renderer: string }
  | { readonly error: string };

const WEBP_QUALITY = 0.9;

async function renderPoster(variant: SceneVariant): Promise<PosterResult> {
  const { width, height } = VARIANTS[variant].poster;
  const cssWidth = width / POSTER_PIXEL_RATIO;
  const cssHeight = height / POSTER_PIXEL_RATIO;
  const canvas = document.createElement('canvas');
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  document.body.appendChild(canvas);
  // Offline asset generation: a software rasteriser produces the same pixels, just slower.
  const probe = probeWebGLContext(canvas, { allowSoftware: true });
  if (!probe.ok) return { error: probe.reason };
  const scene = await createShapeSorterScene({
    canvas,
    context: probe.context,
    variant,
    width: cssWidth,
    height: cssHeight,
    pixelRatio: POSTER_PIXEL_RATIO,
  });
  scene.renderStill();
  // Same task as the render: the drawing buffer is still intact without preserveDrawingBuffer.
  const dataUrl = canvas.toDataURL('image/webp', WEBP_QUALITY);
  const renderer = String(probe.context.getParameter(probe.context.RENDERER));
  return { dataUrl, width: canvas.width, height: canvas.height, renderer };
}

const variant = new URLSearchParams(window.location.search).get('variant');
const target = window as Window & { __poster?: PosterResult };
if (variant === 'pin' || variant === 'wizard') {
  renderPoster(variant).then(
    (result) => {
      target.__poster = result;
    },
    (error: unknown) => {
      target.__poster = { error: error instanceof Error ? error.message : String(error) };
    },
  );
} else {
  target.__poster = { error: 'Pass ?variant=pin or ?variant=wizard' };
}
