/**
 * Deterministic timeline for the shape-sorter joke, in scene units (1 unit ≈ box width / 2.2).
 * The red sphere sits in the square hole, hops out, lands, winds up and confidently drops back in:
 * "That's right. The square hole." Starts and ends on REST_POSE so poster, first and last frames match.
 * Pure math: no three.js, no clocks. Callers pass elapsed milliseconds.
 */

export const BOX = Object.freeze({ width: 2.2, height: 1.2, bevel: 0.07, holeSide: 1.0 });
export const SPHERE_RADIUS = 0.47;

const TOP = BOX.height + 2 * BOX.bevel;
/** Half of the narrowest (bevelled) opening; the sphere rests on the chamfer. */
const OPENING_HALF = BOX.holeSide / 2 - BOX.bevel;
const REST_Y = TOP - Math.sqrt(SPHERE_RADIUS ** 2 - OPENING_HALF ** 2);
const ABOVE_HOLE_Y = TOP + SPHERE_RADIUS + 0.3;
/** Where the sphere lands beside the box between its two hops (ground contact point). */
export const LANDING = Object.freeze({ x: -1.95, z: 1.2 });
const GROUND = LANDING;

export interface SpherePose {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Vertical scale; horizontal axes get 1/sqrt(squash) to keep volume. */
  readonly squash: number;
}

export interface Pose {
  readonly sphere: SpherePose;
  /** Vertical scale of the box, anchored at the ground. */
  readonly box: number;
  /** Tilt (radians) applied to the shapes resting around the box. */
  readonly wobble: number;
}

export const REST_POSE: Pose = Object.freeze({
  sphere: Object.freeze({ x: 0, y: REST_Y, z: 0, squash: 1 }),
  box: 1,
  wobble: 0,
});

type Segment = { readonly end: number; readonly pose: (p: number) => Pose };

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;
const easeOutQuad = (t: number): number => 1 - (1 - t) ** 2;
const easeInQuad = (t: number): number => t * t;
const easeInOutQuad = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const easeInOutSine = (t: number): number => -(Math.cos(Math.PI * t) - 1) / 2;
/** Two-phase blend: a→b over [0, split], then b→c over [split, 1]. */
const via = (a: number, b: number, c: number, split: number, t: number): number =>
  t < split ? lerp(a, b, easeOutQuad(t / split)) : lerp(b, c, easeInOutSine((t - split) / (1 - split)));

/** Ballistic hop: horizontal progress eased, vertical parabola with extra height `lift`. */
function arc(
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
  lift: number,
  horizontal: (t: number) => number,
  p: number,
): { x: number; y: number; z: number } {
  const q = horizontal(p);
  return {
    x: lerp(from.x, to.x, q),
    z: lerp(from.z, to.z, q),
    y: lerp(from.y, to.y, p) + 4 * lift * p * (1 - p),
  };
}

const ANTICIPATE_BOX = 0.985;
const ANTICIPATE_SQUASH = 0.86;
const CROUCH_SQUASH = 0.84;
const DROP_OVERSHOOT = 0.07;

const rest = (sphere: SpherePose, box = 1, wobble = 0): Pose => ({ sphere, box, wobble });
const onGround = (squash: number): SpherePose => ({ x: GROUND.x, y: SPHERE_RADIUS * squash, z: GROUND.z, squash });

const SEGMENTS: readonly Segment[] = [
  // 1 · anticipation: sphere and box compress slightly
  {
    end: 180,
    pose: (p) => {
      const box = lerp(1, ANTICIPATE_BOX, easeInOutSine(p));
      return rest({ x: 0, y: REST_Y * box, z: 0, squash: lerp(1, ANTICIPATE_SQUASH, easeInOutSine(p)) }, box);
    },
  },
  // 2 · pop straight up out of the hole
  {
    end: 380,
    pose: (p) => {
      const box = lerp(ANTICIPATE_BOX, 1, clamp01(p * 3));
      const y = lerp(REST_Y * ANTICIPATE_BOX, ABOVE_HOLE_Y, easeOutCubic(p));
      return rest({ x: 0, y, z: 0, squash: via(ANTICIPATE_SQUASH, 1.14, 1, 0.35, p) }, box);
    },
  },
  // 3 · arc out to the ground beside the box
  {
    end: 840,
    pose: (p) => {
      const at = arc({ x: 0, y: ABOVE_HOLE_Y, z: 0 }, { x: GROUND.x, y: SPHERE_RADIUS, z: GROUND.z }, 0.75, easeOutQuad, p);
      return rest({ ...at, squash: 1 });
    },
  },
  // 4 · land with a squash
  { end: 1000, pose: (p) => rest(onGround(via(1, 0.78, 1, 0.35, p))) },
  // 5 · wind up
  { end: 1260, pose: (p) => rest(onGround(lerp(1, CROUCH_SQUASH, easeInOutSine(clamp01(p / 0.7))))) },
  // 6 · confident hop back over the hole
  {
    end: 1780,
    pose: (p) => {
      const from = { x: GROUND.x, y: SPHERE_RADIUS * CROUCH_SQUASH, z: GROUND.z };
      const at = arc(from, { x: 0, y: ABOVE_HOLE_Y, z: 0 }, 1.35, easeInOutQuad, p);
      return rest({ ...at, squash: via(CROUCH_SQUASH, 1.12, 1, 0.25, p) });
    },
  },
  // 7 · drop into the square hole
  {
    end: 1900,
    pose: (p) =>
      rest({ x: 0, y: lerp(ABOVE_HOLE_Y, REST_Y - DROP_OVERSHOOT, easeInQuad(p)), z: 0, squash: lerp(1, 1.08, p) }),
  },
  // 8 · settle: damped bounce of sphere and box, the other shapes wobble, then exact rest
  {
    end: 2600,
    pose: (p) => {
      const decay = (1 - p) ** 3;
      const box = 1 - 0.05 * Math.abs(Math.sin(3 * Math.PI * p)) * decay;
      const offset = -DROP_OVERSHOOT * Math.cos(3 * Math.PI * p) * decay;
      const squash = 1 + decay * (0.08 * Math.cos(3 * Math.PI * p) - 0.2 * Math.sin(3 * Math.PI * p));
      const wobble = 0.12 * Math.sin(4 * Math.PI * p) * (1 - p) ** 2;
      return rest({ x: 0, y: REST_Y * box + offset, z: 0, squash }, box, wobble);
    },
  },
];

export const SEQUENCE_MS = SEGMENTS.reduce((end, segment) => Math.max(end, segment.end), 0);

export function poseAt(ms: number): Pose {
  if (!Number.isFinite(ms) || ms <= 0 || ms >= SEQUENCE_MS) return REST_POSE;
  let start = 0;
  for (const segment of SEGMENTS) {
    if (ms < segment.end) return segment.pose((ms - start) / (segment.end - start));
    start = segment.end;
  }
  return REST_POSE;
}
