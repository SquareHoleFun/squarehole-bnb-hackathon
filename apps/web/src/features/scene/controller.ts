/**
 * Framework-free lifecycle for the decorative shape-sorter accent:
 * poster first → (page load + idle + in view + visible) → gate → probe context → dynamic import → play once → stop.
 * Every dependency on the browser is injectable so the gating can be unit-tested without WebGL.
 */
import {
  capPixelRatio,
  loseContext,
  staticBlockReason,
  type ContextProbe,
  type SceneEnvironment,
  type SceneFallbackReason,
} from './gate';
import type { SceneModule, SceneStats, SceneVariant, ShapeSorterScene } from './sceneTypes';

export type AccentPhase = 'poster' | 'loading' | 'live' | 'fallback';

export interface AccentStatus {
  readonly phase: AccentPhase;
  readonly reason: SceneFallbackReason | null;
  /** True once the sequence finished and rendering stopped. */
  readonly settled: boolean;
  /** Frames rendered by the last completed sequence. */
  readonly frames: number | null;
}

export interface ElementSize {
  readonly width: number;
  readonly height: number;
}

type Unsubscribe = () => void;

export interface SceneDeps {
  readonly loadScene: () => Promise<SceneModule>;
  readonly readEnvironment: () => SceneEnvironment;
  readonly probeContext: (canvas: HTMLCanvasElement) => ContextProbe;
  /** Calls back once, after page load and an idle period. Returns a cancel function. */
  readonly whenIdle: (callback: () => void) => Unsubscribe;
  readonly observeInView: (element: Element, callback: (inView: boolean) => void) => Unsubscribe;
  readonly observeSize: (element: Element, callback: (size: ElementSize) => void) => Unsubscribe;
  readonly onVisibilityChange: (callback: (hidden: boolean) => void) => Unsubscribe;
  readonly onReducedMotionChange: (callback: (reduced: boolean) => void) => Unsubscribe;
  readonly devicePixelRatio: () => number;
  readonly createCanvas: () => HTMLCanvasElement;
}

export interface AccentControllerOptions {
  /** Empty element owned by the controller; the canvas is appended here. */
  readonly host: HTMLElement;
  readonly variant: SceneVariant;
  readonly deps: SceneDeps;
  readonly canvasClassName?: string;
  readonly onStatus: (status: AccentStatus) => void;
}

export interface AccentController {
  replay(): void;
  dispose(): void;
}

export const POSTER_STATUS: AccentStatus = Object.freeze({ phase: 'poster', reason: null, settled: false, frames: null });

export function createAccentController(options: AccentControllerOptions): AccentController {
  const { host, variant, deps, onStatus } = options;
  const subscriptions: Unsubscribe[] = [];
  let status: AccentStatus = POSTER_STATUS;
  let finished = false; // disposed or fallen back: nothing may emit or start afterwards
  let started = false;
  let idleReached = false;
  let inView = false;
  let hidden = false;
  let size: ElementSize = { width: 0, height: 0 };
  let canvas: HTMLCanvasElement | null = null;
  let context: WebGL2RenderingContext | null = null;
  let scene: ShapeSorterScene | null = null;
  let playPending = false;

  const emit = (next: AccentStatus): void => {
    if (finished && next.phase !== 'fallback') return;
    status = next;
    onStatus(next);
  };

  const onContextLost = (): void => fallback('context-lost');

  function teardown(): void {
    subscriptions.splice(0).forEach((off) => off());
    if (canvas) {
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.remove();
    }
    if (scene) {
      scene.dispose();
    } else {
      loseContext(context);
    }
    scene = null;
    context = null;
    canvas = null;
  }

  function fallback(reason: SceneFallbackReason): void {
    if (finished) return;
    teardown();
    emit({ phase: 'fallback', reason, settled: false, frames: null });
    finished = true;
  }

  const active = (): boolean => inView && !hidden;

  function update(): void {
    if (finished) return;
    if (!started) {
      if (idleReached && active()) void begin();
      return;
    }
    if (!scene) return;
    scene.setActive(active());
    if (playPending && active()) {
      playPending = false;
      scene.play();
    }
  }

  function onSettled(stats: SceneStats): void {
    emit({ phase: 'live', reason: null, settled: true, frames: stats.sequenceFrames });
  }

  async function begin(): Promise<void> {
    started = true;
    // Settings can change between mount and idle; re-check before touching the GPU.
    const reason = staticBlockReason(deps.readEnvironment());
    if (reason) return fallback(reason);

    const target = deps.createCanvas();
    const probe = deps.probeContext(target);
    if (!probe.ok) return fallback(probe.reason);
    canvas = target;
    context = probe.context;
    target.setAttribute('aria-hidden', 'true');
    target.setAttribute('tabindex', '-1');
    if (options.canvasClassName) target.className = options.canvasClassName;
    target.addEventListener('webglcontextlost', onContextLost);
    emit({ phase: 'loading', reason: null, settled: false, frames: null });

    let module: SceneModule;
    try {
      module = await deps.loadScene();
    } catch (error) {
      console.warn('Shape-sorter scene failed to load; keeping the poster.', error);
      return fallback('load-failed');
    }
    if (finished || !context) return;

    let created: ShapeSorterScene;
    try {
      created = await module.createShapeSorterScene({
        canvas: target,
        context,
        variant,
        width: size.width || host.clientWidth,
        height: size.height || host.clientHeight,
        pixelRatio: capPixelRatio(deps.devicePixelRatio()),
        onSettled,
      });
    } catch (error) {
      console.warn('Shape-sorter scene failed to start; keeping the poster.', error);
      return fallback('scene-failed');
    }
    if (finished) {
      created.dispose();
      return;
    }
    scene = created;
    // A host resize during the async compile only updated `size`; apply it now (a same-size call is a no-op).
    if (size.width > 0 && size.height > 0) created.resize(size.width, size.height);
    host.appendChild(target);
    created.renderStill(); // rest pose (identical to the poster) before the crossfade starts
    emit({ phase: 'live', reason: null, settled: false, frames: null });
    playPending = true;
    update();
  }

  const initial = staticBlockReason(deps.readEnvironment());
  if (initial) {
    fallback(initial);
  } else {
    hidden = deps.readEnvironment().hidden;
    emit(POSTER_STATUS);
    subscriptions.push(
      deps.onReducedMotionChange((reduced) => {
        if (reduced) fallback('reduced-motion');
      }),
      deps.onVisibilityChange((isHidden) => {
        hidden = isHidden;
        update();
      }),
      deps.observeInView(host, (visible) => {
        inView = visible;
        update();
      }),
      deps.observeSize(host, (next) => {
        size = next;
        scene?.resize(next.width, next.height);
      }),
      deps.whenIdle(() => {
        idleReached = true;
        update();
      }),
    );
  }

  return {
    replay() {
      if (finished || !scene) return;
      emit({ ...status, settled: false, frames: null });
      playPending = true;
      update();
    },
    dispose() {
      if (finished) return;
      finished = true;
      teardown();
    },
  };
}


/** A revealed model is self-contained, hash-checked, bounded, and loaded only on an explicit user action. */
export async function loadItemModel(
  host: HTMLElement, url: string, sha256: `0x${string}`, signal: AbortSignal,
  fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch,
  mount: (host: HTMLElement, bytes: Uint8Array) => Promise<() => void> = async (element, bytes) => (await import('./deps')).mountItemModel(element, bytes),
): Promise<() => void> {
  signal.throwIfAborted();
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  const response = await fetcher(url, { signal: deadline, cache: 'no-store', redirect: 'error' });
  if (!response.ok || Number(response.headers.get('content-length') ?? '0') > 1_048_576 || !response.body) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error('model unavailable');
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  deadline.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      deadline.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1_048_576) throw new Error('model exceeds one raw block');
      chunks.push(value);
    }
    deadline.throwIfAborted();
  } catch (error) {
    cancel();
    throw error;
  } finally {
    deadline.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  signal.throwIfAborted();
  const { glbSha256 } = await import('@squarehole/artwork');
  if (glbSha256(bytes) !== sha256.toLowerCase()) throw new Error('model hash mismatch');
  signal.throwIfAborted();
  const dispose = await mount(host, bytes);
  if (signal.aborted) { dispose(); signal.throwIfAborted(); }
  return dispose;
}
