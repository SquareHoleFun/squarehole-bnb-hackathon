/**
 * Lazy chunk: the only module that imports three.js. Renders on demand
 * (https://threejs.org/manual/#en/rendering-on-demand): frames are requested only while the short
 * sequence runs or once after a resize; when the sequence settles no animation frame is scheduled.
 */
import { NeutralToneMapping, PerspectiveCamera, Vector3, WebGLRenderer } from 'three';
import { buildShapeSorter, type ShapeSorterGraph } from './sceneBuild';
import { BOX, LANDING, SEQUENCE_MS, SPHERE_RADIUS, poseAt, type Pose } from './sequence';
import type { CreateSceneOptions, SceneStats, SceneVariant, ShapeSorterScene } from './sceneTypes';

/** Longest frame step fed to the timeline; a stalled tab resumes where it paused instead of skipping. */
const MAX_STEP_MS = 50;
const VIEW_DIRECTION = new Vector3(0.2, 0.62, 1).normalize();
const FRAMING: Readonly<Record<SceneVariant, { readonly marginX: number; readonly marginY: number }>> = {
  pin: { marginX: 0.05, marginY: 0.08 },
  wizard: { marginX: 0.08, marginY: 0.12 },
};

/** The 8 corners of an axis-aligned box. */
function corners(min: Vector3, max: Vector3): Vector3[] {
  return [0, 1, 2, 3, 4, 5, 6, 7].map(
    (i) => new Vector3(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z),
  );
}

/** Points that must stay in frame at rest: box, resting shapes, the sphere's landing spot. */
function stagePoints(graph: ShapeSorterGraph): readonly Vector3[] {
  const top = BOX.height + 2 * BOX.bevel;
  const w = BOX.width / 2;
  const box = corners(new Vector3(-w, 0, -w), new Vector3(w, top, w));
  // Headroom above the resting sphere so the drop reads before it disappears into the hole.
  const headroom = new Vector3(0, top + SPHERE_RADIUS * 1.5, 0);
  const shapes = graph.resting.flatMap(({ mesh }) => {
    mesh.geometry.computeBoundingBox();
    const b = mesh.geometry.boundingBox;
    return b ? corners(b.min, b.max).map((p) => p.applyEuler(mesh.rotation).add(mesh.position)) : [];
  });
  const r = SPHERE_RADIUS;
  const landing = corners(
    new Vector3(LANDING.x - r, 0, LANDING.z - r),
    new Vector3(LANDING.x + r, 2 * r, LANDING.z + r),
  );
  return [...box, headroom, ...shapes, ...landing];
}

/** Moves the camera along a fixed view direction until every stage point fits, then centres the framing. */
function fitCamera(camera: PerspectiveCamera, points: readonly Vector3[], variant: SceneVariant): void {
  const { marginX, marginY } = FRAMING[variant];
  const target = new Vector3(0, 0.7, 0);
  const projected = new Vector3();
  const bounds = (distance: number) => {
    camera.position.copy(target).addScaledVector(VIEW_DIRECTION, distance);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      projected.copy(p).project(camera);
      minX = Math.min(minX, projected.x);
      maxX = Math.max(maxX, projected.x);
      minY = Math.min(minY, projected.y);
      maxY = Math.max(maxY, projected.y);
    }
    return { minX, maxX, minY, maxY };
  };
  const fits = (b: ReturnType<typeof bounds>) =>
    b.maxX - b.minX <= 2 * (1 - marginX) && b.maxY - b.minY <= 2 * (1 - marginY);
  camera.updateProjectionMatrix();
  for (let pass = 0; pass < 3; pass += 1) {
    let near = 2;
    let far = 60;
    for (let i = 0; i < 24; i += 1) {
      const mid = (near + far) / 2;
      if (fits(bounds(mid))) far = mid;
      else near = mid;
    }
    const b = bounds(far);
    // Re-centre: shift the target by the NDC offset of the stage centre, scaled to world units.
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    const halfHeight = Math.tan((camera.fov * Math.PI) / 360) * far;
    const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    target.addScaledVector(right, cx * halfHeight * camera.aspect).addScaledVector(up, cy * halfHeight);
    bounds(far);
  }
}

function applyPose(graph: ShapeSorterGraph, pose: Pose): void {
  const { sphere, box, resting, sphereShadow } = graph;
  const s = pose.sphere;
  const sideways = 1 / Math.sqrt(s.squash);
  sphere.position.set(s.x, s.y, s.z);
  sphere.scale.set(sideways, s.squash, sideways);
  const bulge = 1 + (1 - pose.box) * 0.6;
  box.scale.set(bulge, pose.box, bulge);
  for (const shape of resting) {
    shape.mesh.rotation.z = shape.baseTilt + pose.wobble * shape.wobbleSign;
  }
  const height = Math.max(0, s.y - SPHERE_RADIUS * s.squash);
  const overBox = Math.abs(s.x) < BOX.width / 2 + 0.05 && Math.abs(s.z) < BOX.width / 2 + 0.05;
  sphereShadow.position.set(s.x, 0.002, s.z);
  sphereShadow.scale.setScalar(SPHERE_RADIUS * 2.6 * (1 + height * 0.35));
  sphereShadow.material.opacity = overBox ? 0 : 0.5 / (1 + height * 1.2);
}

function disposeGraph(graph: ShapeSorterGraph): void {
  graph.resources.forEach((r) => r.dispose());
  graph.scene.clear();
}

export async function createShapeSorterScene(options: CreateSceneOptions): Promise<ShapeSorterScene> {
  const { canvas, context, variant } = options;
  const requestFrame = options.requestFrame ?? ((cb: FrameRequestCallback) => window.requestAnimationFrame(cb));
  const cancelFrame = options.cancelFrame ?? ((id: number) => window.cancelAnimationFrame(id));

  const renderer = new WebGLRenderer({
    canvas,
    context,
    alpha: true,
    antialias: true,
    premultipliedAlpha: true,
    powerPreference: 'low-power',
  });
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = NeutralToneMapping;
  renderer.setPixelRatio(options.pixelRatio);

  const graph = buildShapeSorter();
  const camera = new PerspectiveCamera(26, 1, 0.1, 80);
  const points = stagePoints(graph);

  let width = 0;
  let height = 0;
  let frames = 0;
  let sequenceFrames = 0;
  let frameHandle = 0;
  let playing = false;
  let active = true;
  let disposed = false;
  let elapsed = 0;
  let lastTimestamp: number | null = null;

  const draw = (): void => {
    if (disposed || width === 0 || height === 0) return;
    renderer.render(graph.scene, camera);
    frames += 1;
  };

  /** Returns true when the drawing buffer changed (and was therefore cleared). */
  const setSize = (w: number, h: number): boolean => {
    const nextWidth = Math.max(0, Math.round(w));
    const nextHeight = Math.max(0, Math.round(h));
    if (nextWidth === width && nextHeight === height) return false;
    width = nextWidth;
    height = nextHeight;
    if (width === 0 || height === 0) return false;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    fitCamera(camera, points, variant);
    camera.updateProjectionMatrix();
    return true;
  };

  const stats = (): SceneStats => ({ frames, sequenceFrames });

  const schedule = (): void => {
    if (frameHandle === 0 && !disposed) frameHandle = requestFrame(tick);
  };

  function tick(timestamp: number): void {
    frameHandle = 0;
    if (disposed || !playing) return;
    if (lastTimestamp !== null) elapsed += Math.min(Math.max(0, timestamp - lastTimestamp), MAX_STEP_MS);
    lastTimestamp = timestamp;
    const done = elapsed >= SEQUENCE_MS;
    applyPose(graph, poseAt(done ? SEQUENCE_MS : elapsed));
    draw();
    sequenceFrames += 1;
    if (done) {
      playing = false;
      lastTimestamp = null;
      options.onSettled?.(stats());
      return; // no further frames: the scene is idle until replay or resize
    }
    if (active) schedule();
  }

  const release = (): void => {
    disposeGraph(graph);
    renderer.dispose();
    // Free the GPU context now rather than at garbage collection (skip if the browser already lost it).
    if (!context.isContextLost()) {
      try {
        renderer.forceContextLoss();
      } catch {
        // Extension unavailable: the context is freed with the canvas instead.
      }
    }
  };

  setSize(options.width, options.height);
  applyPose(graph, poseAt(0));
  try {
    // Parallel shader compile (KHR_parallel_shader_compile) keeps the first frame off the main thread.
    await renderer.compileAsync(graph.scene, camera);
  } catch (error) {
    release();
    throw error;
  }
  draw();

  return {
    play() {
      if (disposed) return;
      playing = true;
      elapsed = 0;
      sequenceFrames = 0;
      lastTimestamp = null;
      if (active) schedule();
    },
    setActive(next) {
      if (next === active) return;
      active = next;
      if (!next) {
        if (frameHandle !== 0) cancelFrame(frameHandle);
        frameHandle = 0;
        lastTimestamp = null; // resume from the paused time, not the wall clock
      } else if (playing) {
        schedule();
      }
    },
    resize(w, h) {
      // Resizing clears the drawing buffer, so redraw in the same frame instead of scheduling one.
      if (setSize(w, h)) draw();
    },
    renderStill() {
      draw();
    },
    stats,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frameHandle !== 0) cancelFrame(frameHandle);
      frameHandle = 0;
      release();
    },
  };
}
