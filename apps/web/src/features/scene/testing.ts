/**
 * Test doubles for the scene lifecycle. Imported by unit tests only; never by the component.
 */
import { vi } from 'vitest';
import type { SceneDeps } from './controller';
import type { SceneEnvironment } from './gate';
import type { CreateSceneOptions, SceneModule, SceneStats, ShapeSorterScene } from './sceneTypes';

export const VISIBLE_ENV: SceneEnvironment = { reducedMotion: false, saveData: false, hidden: false, webgl2: true };

export interface FakeScene extends ShapeSorterScene {
  readonly play: ReturnType<typeof vi.fn<() => void>>;
  readonly setActive: ReturnType<typeof vi.fn<(active: boolean) => void>>;
  readonly resize: ReturnType<typeof vi.fn<(w: number, h: number) => void>>;
  readonly dispose: ReturnType<typeof vi.fn<() => void>>;
  readonly options: CreateSceneOptions;
  settle(stats?: SceneStats): void;
}

export interface Harness {
  readonly deps: SceneDeps;
  readonly loadScene: ReturnType<typeof vi.fn<() => Promise<SceneModule>>>;
  readonly probeContext: ReturnType<typeof vi.fn<SceneDeps['probeContext']>>;
  readonly scenes: FakeScene[];
  /** The n-th scene created; throws if the controller never created it. */
  scene(index?: number): FakeScene;
  readonly lostContexts: number;
  env: SceneEnvironment;
  runIdle(): void;
  setInView(inView: boolean): void;
  setHidden(hidden: boolean): void;
  setReducedMotion(reduced: boolean): void;
  resizeTo(width: number, height: number): void;
  listenerCount(): number;
}

export function createFakeScene(options: CreateSceneOptions): FakeScene {
  return {
    options,
    play: vi.fn<() => void>(),
    setActive: vi.fn<(active: boolean) => void>(),
    resize: vi.fn<(w: number, h: number) => void>(),
    renderStill: vi.fn<() => void>(),
    stats: () => ({ frames: 1, sequenceFrames: 0 }),
    dispose: vi.fn<() => void>(),
    settle(stats = { frames: 150, sequenceFrames: 149 }) {
      options.onSettled?.(stats);
    },
  };
}

/** Deterministic dependencies: idle, visibility, intersection and size are driven by the test. */
export function createHarness(initialEnv: SceneEnvironment = VISIBLE_ENV): Harness {
  const idle = new Set<() => void>();
  const inView = new Set<(v: boolean) => void>();
  const hidden = new Set<(h: boolean) => void>();
  const reduced = new Set<(r: boolean) => void>();
  const sizes = new Set<(s: { width: number; height: number }) => void>();
  const scenes: FakeScene[] = [];
  let lost = 0;

  const fakeContext = {
    getExtension: (name: string) => (name === 'WEBGL_lose_context' ? { loseContext: () => (lost += 1) } : null),
  } as unknown as WebGL2RenderingContext;

  const module: SceneModule = {
    createShapeSorterScene: async (options) => {
      const scene = createFakeScene(options);
      scenes.push(scene);
      return scene;
    },
  };

  const subscribe =
    <T>(set: Set<T>) =>
    (cb: T): (() => void) => {
      set.add(cb);
      return () => set.delete(cb);
    };

  const harness: Omit<Harness, 'deps'> = {
    env: initialEnv,
    scenes,
    scene: (index = 0) => {
      const found = scenes[index];
      if (!found) throw new Error(`No scene #${index} was created`);
      return found;
    },
    get lostContexts() {
      return lost;
    },
    loadScene: vi.fn<() => Promise<SceneModule>>(async () => module),
    probeContext: vi.fn<SceneDeps['probeContext']>(() => ({ ok: true, context: fakeContext })),
    runIdle: () => [...idle].forEach((cb) => cb()),
    setInView: (v) => [...inView].forEach((cb) => cb(v)),
    setHidden: (h) => {
      harness.env = { ...harness.env, hidden: h };
      [...hidden].forEach((cb) => cb(h));
    },
    setReducedMotion: (r) => {
      harness.env = { ...harness.env, reducedMotion: r };
      [...reduced].forEach((cb) => cb(r));
    },
    resizeTo: (width, height) => [...sizes].forEach((cb) => cb({ width, height })),
    listenerCount: () => idle.size + inView.size + hidden.size + reduced.size + sizes.size,
  };

  const deps: SceneDeps = {
    loadScene: harness.loadScene,
    readEnvironment: () => harness.env,
    probeContext: harness.probeContext,
    whenIdle: subscribe(idle),
    observeInView: (_el, cb) => subscribe(inView)(cb),
    observeSize: (_el, cb) => {
      const off = subscribe(sizes)(cb);
      cb({ width: 360, height: 170 });
      return off;
    },
    onVisibilityChange: subscribe(hidden),
    onReducedMotionChange: subscribe(reduced),
    devicePixelRatio: () => 3,
    createCanvas: () => document.createElement('canvas'),
  };
  return Object.assign(harness, { deps });
}

/** Let pending promise continuations (dynamic import, async scene creation) run. */
export async function flushAsync(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}
