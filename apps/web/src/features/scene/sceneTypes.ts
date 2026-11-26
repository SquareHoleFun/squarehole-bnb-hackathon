/**
 * Contract between the always-loaded accent (poster + gating) and the lazily imported three.js scene.
 * Type-only: importing this file never pulls three.js into the eager bundle.
 */
export type SceneVariant = 'pin' | 'wizard';

export interface SceneStats {
  /** Every WebGL frame rendered since creation (includes on-demand stills). */
  readonly frames: number;
  /** Frames rendered by the most recent sequence run. */
  readonly sequenceFrames: number;
}

export interface ShapeSorterScene {
  /** (Re)start the short sequence from the rest pose. Renders only while the sequence runs. */
  play(): void;
  /** Pause (offscreen / hidden tab) or resume the running sequence. Idle scenes ignore this. */
  setActive(active: boolean): void;
  /** Resize the drawing buffer (CSS px) and render a single on-demand frame if idle. */
  resize(width: number, height: number): void;
  /** Render the current pose once, synchronously. */
  renderStill(): void;
  stats(): SceneStats;
  /** Free geometries, materials, textures, the renderer and its GL context; cancel frames. */
  dispose(): void;
}

export interface CreateSceneOptions {
  readonly canvas: HTMLCanvasElement;
  /** Context created (and vetted) by the eager gate; the scene reuses it instead of creating another. */
  readonly context: WebGL2RenderingContext;
  readonly variant: SceneVariant;
  /** CSS pixels. */
  readonly width: number;
  readonly height: number;
  /** Already capped by the caller. */
  readonly pixelRatio: number;
  readonly requestFrame?: (callback: FrameRequestCallback) => number;
  readonly cancelFrame?: (handle: number) => void;
  readonly onSettled?: (stats: SceneStats) => void;
}

export interface SceneModule {
  createShapeSorterScene(options: CreateSceneOptions): Promise<ShapeSorterScene>;
}
