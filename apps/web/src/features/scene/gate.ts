/**
 * Decides whether the decorative WebGL scene may load. Pure checks plus a context probe that runs
 * before any three.js download, so blocked devices never fetch the lazy chunk (UI-07).
 */

export type SceneFallbackReason =
  | 'reduced-motion'
  | 'save-data'
  | 'no-webgl'
  | 'context-failed'
  | 'software-renderer'
  | 'load-failed'
  | 'scene-failed'
  | 'context-lost';

export interface SceneEnvironment {
  readonly reducedMotion: boolean;
  /** Data saver on, or a 2G-class connection. */
  readonly saveData: boolean;
  readonly hidden: boolean;
  readonly webgl2: boolean;
}

export const MAX_PIXEL_RATIO = 1.5;

/**
 * Attributes for the single context the scene will use. `failIfMajorPerformanceCaveat` lets the browser
 * refuse blocklisted/software paths; `low-power` asks dual-GPU laptops for the integrated GPU.
 */
export const CONTEXT_ATTRIBUTES: WebGLContextAttributes = Object.freeze({
  alpha: true,
  antialias: true,
  depth: true,
  stencil: false,
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
  powerPreference: 'low-power',
  failIfMajorPerformanceCaveat: true,
});

const SLOW_CONNECTIONS: ReadonlySet<string> = new Set(['slow-2g', '2g']);
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render driver/i;
const MASKED_RENDERER = /^webkit webgl$/i;
const UNMASKED_RENDERER_WEBGL = 0x9246;

interface NetworkInformationLike {
  readonly saveData?: boolean;
  readonly effectiveType?: string;
}

/** Permanent (per mount) reasons to keep the poster. A hidden tab only defers loading. */
export function staticBlockReason(env: SceneEnvironment): SceneFallbackReason | null {
  if (env.reducedMotion) return 'reduced-motion';
  if (env.saveData) return 'save-data';
  if (!env.webgl2) return 'no-webgl';
  return null;
}

export function readSceneEnvironment(win: Window): SceneEnvironment {
  const media = typeof win.matchMedia === 'function' ? win.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const connection = (win.navigator as Navigator & { readonly connection?: NetworkInformationLike }).connection;
  const effectiveType = typeof connection?.effectiveType === 'string' ? connection.effectiveType : '';
  return {
    reducedMotion: media?.matches === true,
    saveData: connection?.saveData === true || SLOW_CONNECTIONS.has(effectiveType),
    hidden: win.document.visibilityState === 'hidden',
    webgl2: typeof (win as Window & { WebGL2RenderingContext?: unknown }).WebGL2RenderingContext === 'function',
  };
}

export function capPixelRatio(ratio: number, max: number = MAX_PIXEL_RATIO): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  return Math.min(ratio, max);
}

export function isSoftwareRenderer(rendererName: string | null): boolean {
  return rendererName !== null && SOFTWARE_RENDERER.test(rendererName);
}

export type ContextProbe =
  | { readonly ok: true; readonly context: WebGL2RenderingContext }
  | { readonly ok: false; readonly reason: 'context-failed' | 'software-renderer' };

function rendererName(gl: WebGL2RenderingContext): string | null {
  const plain = gl.getParameter(gl.RENDERER);
  if (typeof plain === 'string' && !MASKED_RENDERER.test(plain)) return plain;
  // Chromium/WebKit mask RENDERER; only then ask for the (still shipped) debug extension.
  const debug = gl.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_RENDERER_WEBGL: number } | null;
  const unmasked = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL || UNMASKED_RENDERER_WEBGL) : null;
  return typeof unmasked === 'string' ? unmasked : typeof plain === 'string' ? plain : null;
}

/** Release a context immediately instead of waiting for garbage collection. */
export function loseContext(gl: WebGL2RenderingContext | null): void {
  try {
    const ext = gl?.getExtension('WEBGL_lose_context') as { loseContext(): void } | null | undefined;
    ext?.loseContext();
  } catch {
    // Already lost or extension unavailable: nothing to free.
  }
}

/**
 * Creates the one WebGL2 context the scene will reuse. GPU-free (software) rasterisers are rejected
 * by default: the scene is decoration and must not burn CPU on low-power devices.
 */
function createContext(canvas: HTMLCanvasElement): WebGL2RenderingContext | null {
  try {
    return canvas.getContext('webgl2', CONTEXT_ATTRIBUTES) as WebGL2RenderingContext | null;
  } catch {
    return null;
  }
}

function safeRendererName(gl: WebGL2RenderingContext): string | null {
  try {
    return rendererName(gl);
  } catch {
    return null;
  }
}

export function probeWebGLContext(canvas: HTMLCanvasElement, options: { readonly allowSoftware?: boolean } = {}): ContextProbe {
  const gl = createContext(canvas);
  if (!gl) return { ok: false, reason: 'context-failed' };
  if (!options.allowSoftware && isSoftwareRenderer(safeRendererName(gl))) {
    loseContext(gl);
    return { ok: false, reason: 'software-renderer' };
  }
  return { ok: true, context: gl };
}
