/**
 * Real browser implementations of SceneDeps. Every API is feature-detected so older browsers
 * (and jsdom) keep the poster instead of throwing.
 */
import { readPreferences, subscribePreferences } from '../settings';
import type { ElementSize, SceneDeps } from './controller';
import { probeWebGLContext, readSceneEnvironment, type SceneEnvironment } from './gate';

/** Upper bound for requestIdleCallback on busy pages. */
const IDLE_TIMEOUT_MS = 2000;
/** Browsers without requestIdleCallback (Safari): wait a beat after load. */
const IDLE_FALLBACK_MS = 600;
/** Pages that never paint content (poster failed, hidden at load) still proceed after this long. */
const PAINT_WAIT_CAP_MS = 1500;
const FIRST_CONTENTFUL_PAINT = 'first-contentful-paint';
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

const noop = (): void => undefined;

/** Observers are globals in lib.dom but may be missing at runtime (old browsers, jsdom). */
type ObserverWindow = Window & {
  readonly IntersectionObserver?: typeof IntersectionObserver;
  readonly ResizeObserver?: typeof ResizeObserver;
  readonly PerformanceObserver?: typeof PerformanceObserver;
};

type Cancel = () => void;
/** One wait in the whenIdle chain: calls `next` once when done, returns a cancel for the pending wait. */
type Stage = (win: ObserverWindow, next: () => void) => Cancel;

/** The load event: the page's own resources, poster included. */
const afterLoad: Stage = (win, next) => {
  if (win.document.readyState === 'complete') {
    next();
    return noop;
  }
  win.addEventListener('load', next, { once: true });
  return () => win.removeEventListener('load', next);
};

/** Without paint timing: two animation frames, so the first frame has at least been produced. */
const afterTwoFrames: Stage = (win, next) => {
  let frame = win.requestAnimationFrame(() => {
    frame = win.requestAnimationFrame(() => next());
  });
  return () => win.cancelAnimationFrame(frame);
};

function supportsPaintTiming(Observer: typeof PerformanceObserver | undefined): Observer is typeof PerformanceObserver {
  if (typeof Observer !== 'function') return false;
  const types: unknown = Observer.supportedEntryTypes;
  return Array.isArray(types) && types.includes('paint');
}

/**
 * Waits for the first-contentful-paint entry. Paint entries are delivered only after the frame was presented,
 * so anything started afterwards follows first paint (rAF callbacks run before presentation and cannot promise
 * that). Falls back to two frames without paint timing; gives up waiting after PAINT_WAIT_CAP_MS.
 */
const afterFirstPaint: Stage = (win, next) => {
  const Observer = win.PerformanceObserver;
  if (!supportsPaintTiming(Observer)) return afterTwoFrames(win, next);
  let waiting = true;
  let timer: number | null = null;
  let observer: PerformanceObserver | null = null;
  const stop = (): void => {
    waiting = false;
    observer?.disconnect();
    observer = null;
    if (timer !== null) win.clearTimeout(timer);
    timer = null;
  };
  const done = (): void => {
    if (!waiting) return;
    stop();
    next();
  };
  try {
    observer = new Observer((list) => {
      if (list.getEntries().some((entry) => entry.name === FIRST_CONTENTFUL_PAINT)) done();
    });
    observer.observe({ type: 'paint', buffered: true });
  } catch {
    stop();
    return afterTwoFrames(win, next);
  }
  if (waiting) timer = win.setTimeout(done, PAINT_WAIT_CAP_MS);
  return stop;
};

/** An idle period (requestIdleCallback with a timeout), or a short timer where it is missing. */
const afterIdle: Stage = (win, next) => {
  if (typeof win.requestIdleCallback === 'function') {
    const handle = win.requestIdleCallback(() => next(), { timeout: IDLE_TIMEOUT_MS });
    return () => {
      if (typeof win.cancelIdleCallback === 'function') win.cancelIdleCallback(handle);
    };
  }
  const timer = win.setTimeout(next, IDLE_FALLBACK_MS);
  return () => win.clearTimeout(timer);
};

const IDLE_STAGES: readonly Stage[] = [afterLoad, afterFirstPaint, afterIdle];

/**
 * Calls back once: after the load event, after the first contentful paint has been presented (on fast pages
 * `load` and idle can both precede it), and then in an idle period. Returns a cancel function that stops
 * whichever stage is pending.
 */
export function whenIdle(win: Window, callback: () => void): () => void {
  let cancelled = false;
  let cancelPending: Cancel = noop;
  const runStage = (index: number): void => {
    if (cancelled) return;
    const stage = IDLE_STAGES[index];
    if (!stage) {
      cancelPending = noop;
      callback();
      return;
    }
    let advanced = false;
    const cancel = stage(win, () => {
      if (advanced) return;
      advanced = true;
      runStage(index + 1);
    });
    // A stage that finished synchronously already installed the next stage's cancel.
    if (!advanced) cancelPending = cancel;
  };
  runStage(0);
  return () => {
    cancelled = true;
    cancelPending();
    cancelPending = noop;
  };
}

function observeInView(win: ObserverWindow, element: Element, callback: (inView: boolean) => void): () => void {
  const Observer = win.IntersectionObserver;
  if (typeof Observer !== 'function') {
    callback(true);
    return noop;
  }
  const observer = new Observer((entries) => {
    const entry = entries[entries.length - 1];
    if (entry) callback(entry.isIntersecting);
  });
  observer.observe(element);
  return () => observer.disconnect();
}

function observeSize(win: ObserverWindow, element: Element, callback: (size: ElementSize) => void): () => void {
  const report = (): void => {
    const rect = element.getBoundingClientRect();
    callback({ width: rect.width, height: rect.height });
  };
  report();
  const Observer = win.ResizeObserver;
  if (typeof Observer !== 'function') {
    win.addEventListener('resize', report);
    return () => win.removeEventListener('resize', report);
  }
  const observer = new Observer((entries) => {
    const entry = entries[entries.length - 1];
    if (entry) callback({ width: entry.contentRect.width, height: entry.contentRect.height });
  });
  observer.observe(element);
  return () => observer.disconnect();
}

function onVisibilityChange(win: Window, callback: (hidden: boolean) => void): () => void {
  const doc = win.document;
  const listener = (): void => callback(doc.visibilityState === 'hidden');
  doc.addEventListener('visibilitychange', listener);
  return () => doc.removeEventListener('visibilitychange', listener);
}

function onReducedMotionChange(win: Window, callback: (reduced: boolean) => void): () => void {
  if (typeof win.matchMedia !== 'function') return noop;
  const query = win.matchMedia(REDUCED_MOTION);
  if (typeof query.addEventListener !== 'function') return noop;
  const listener = (event: MediaQueryListEvent): void => callback(event.matches);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}

/** The environment with the Settings motion choice applied: "Reduce motion" counts as reduced motion. */
export function sceneEnvironmentWithPreferences(win: Window): SceneEnvironment {
  const env = readSceneEnvironment(win);
  return readPreferences().motion === 'reduce' ? { ...env, reducedMotion: true } : env;
}

/** Reduced motion from the system setting or from Settings ("Reduce motion"), whichever turns on first. */
function onAnyReducedMotion(win: Window, callback: (reduced: boolean) => void): () => void {
  const offSystem = onReducedMotionChange(win, callback);
  const offPreference = subscribePreferences(() => {
    if (readPreferences().motion === 'reduce') callback(true);
  });
  return () => {
    offSystem();
    offPreference();
  };
}

export interface DefaultDepsOptions {
  /** Dev lab / CI only: accept software rasterisers so the pipeline can be exercised without a GPU. */
  readonly allowSoftware?: boolean;
}

export function defaultSceneDeps(win: Window, options: DefaultDepsOptions = {}): SceneDeps {
  return {
    // The only reference to the three.js module: Vite emits it as a separate chunk.
    loadScene: () => import('./sorterScene'),
    readEnvironment: () => sceneEnvironmentWithPreferences(win),
    probeContext: (canvas) => probeWebGLContext(canvas, { allowSoftware: options.allowSoftware === true }),
    whenIdle: (callback) => whenIdle(win, callback),
    observeInView: (element, callback) => observeInView(win, element, callback),
    observeSize: (element, callback) => observeSize(win, element, callback),
    onVisibilityChange: (callback) => onVisibilityChange(win, callback),
    onReducedMotionChange: (callback) => onAnyReducedMotion(win, callback),
    devicePixelRatio: () => win.devicePixelRatio,
    createCanvas: () => win.document.createElement('canvas'),
  };
}


/** One arrow-key turn of a model view (T06): 15 degrees. */
const KEY_TURN = Math.PI / 12;
/** How far a view may tilt towards straight above or below (radians from each pole). */
const POLE_MARGIN = 0.15;

export interface MountItemModelOptions {
  /**
   * T06: the arrow keys turn the model around its centre while the host has focus (left and right around, up and down
   * over it, a step each press), as a drag does; OrbitControls' own keys pan, which this view does not allow.
   */
  readonly keyboard?: boolean;
}

/** Still rendering on interaction only: no animation loop, with explicit resource disposal on close. */
export async function mountItemModel(host: HTMLElement, bytes: Uint8Array, options: MountItemModelOptions = {}): Promise<() => void> {
  const [THREE, { GLTFLoader }, { OrbitControls }] = await Promise.all([
    import('three'), import('three/addons/loaders/GLTFLoader.js'), import('three/addons/controls/OrbitControls.js'),
  ]);
  const model = await new GLTFLoader().parseAsync(new Uint8Array(bytes).buffer, '');
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf1eee7);
  scene.add(model.scene, new THREE.HemisphereLight(0xffffff, 0x777777, 2.5));
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(3, 4, 5); scene.add(light);
  const bounds = new THREE.Box3().setFromObject(model.scene);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z, 0.1);
  model.scene.position.sub(center);
  const camera = new THREE.PerspectiveCamera(35, 1, radius / 100, radius * 100);
  camera.position.set(radius * 1.5, radius, radius * 2.5);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const canvas = renderer.domElement;
  canvas.setAttribute('aria-hidden', 'true');
  host.appendChild(canvas);
  const controls = new OrbitControls(camera, canvas);
  controls.enablePan = false;
  controls.minDistance = radius * 0.7;
  controls.maxDistance = radius * 6;
  controls.update();
  const render = () => renderer.render(scene, camera);
  const resize = () => {
    const width = Math.max(host.clientWidth, 1);
    const height = Math.max(host.clientHeight, 1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix(); render();
  };
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  observer?.observe(host);
  controls.addEventListener('change', render);
  const turns: Readonly<Record<string, readonly [number, number]>> = { ArrowLeft: [-KEY_TURN, 0], ArrowRight: [KEY_TURN, 0], ArrowUp: [0, -KEY_TURN], ArrowDown: [0, KEY_TURN] };
  const onKey = (event: KeyboardEvent) => {
    const turn = turns[event.key];
    if (!turn || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    const at = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
    at.theta += turn[0];
    at.phi = Math.min(Math.max(at.phi + turn[1], POLE_MARGIN), Math.PI - POLE_MARGIN);
    camera.position.setFromSpherical(at).add(controls.target);
    camera.lookAt(controls.target);
    controls.update();
    render();
  };
  if (options.keyboard) host.addEventListener('keydown', onKey);
  resize();
  return () => {
    host.removeEventListener('keydown', onKey);
    observer?.disconnect(); controls.dispose();
    model.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) value.dispose();
        material.dispose();
      }
    });
    renderer.dispose(); renderer.forceContextLoss(); canvas.remove();
  };
}
