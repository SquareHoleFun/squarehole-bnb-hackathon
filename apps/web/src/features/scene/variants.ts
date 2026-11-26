import type { SceneVariant } from './sceneTypes';

export interface VariantSpec {
  /** CSS aspect-ratio of the accent box: the poster and the canvas share it, so swapping never shifts layout. */
  readonly aspectRatio: string;
  /** Poster bitmap size in device pixels (rendered at POSTER_PIXEL_RATIO). */
  readonly poster: { readonly width: number; readonly height: number };
}

/** Pin: compact feed card (~360×170 CSS px). Wizard: creation preview panel (~320×240 CSS px). */
export const VARIANTS: Readonly<Record<SceneVariant, VariantSpec>> = Object.freeze({
  pin: Object.freeze({ aspectRatio: '36 / 17', poster: Object.freeze({ width: 720, height: 340 }) }),
  wizard: Object.freeze({ aspectRatio: '4 / 3', poster: Object.freeze({ width: 640, height: 480 }) }),
});

export const POSTER_PIXEL_RATIO = 2;
