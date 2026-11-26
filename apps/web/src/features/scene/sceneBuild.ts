/**
 * Builds the shape-sorter scene graph: a wooden box with a square opening, and four toy shapes
 * (red sphere, yellow rounded cube, blue pyramid, green gem). Lazy chunk only.
 * Original procedural geometry; no reference artwork or brand marks (ADR-0004).
 */
import {
  BackSide,
  BoxGeometry,
  BufferAttribute,
  CanvasTexture,
  Color,
  ConeGeometry,
  DirectionalLight,
  ExtrudeGeometry,
  Group,
  HemisphereLight,
  LatheGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Path,
  PlaneGeometry,
  RepeatWrapping,
  SRGBColorSpace,
  Scene,
  Shape,
  SphereGeometry,
  Vector2,
  type BufferGeometry,
  type Material,
  type Texture,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { BOX, SPHERE_RADIUS } from './sequence';

export const PALETTE = Object.freeze({
  wood: '#e3bf8e',
  grain: '#9c6a3a',
  red: '#e5383b',
  yellow: '#f6b92b',
  blue: '#3c6cf0',
  green: '#2fbf68',
  holeTop: '#3a2818',
  holeBottom: '#05070c',
});

export interface RestingShape {
  readonly mesh: Mesh;
  readonly baseTilt: number;
  readonly wobbleSign: number;
}

export interface ShapeSorterGraph {
  readonly scene: Scene;
  readonly box: Group;
  readonly sphere: Mesh;
  readonly sphereShadow: Mesh<PlaneGeometry, MeshBasicMaterial>;
  readonly resting: readonly RestingShape[];
  /** Every GPU resource created here, for dispose(). */
  readonly resources: readonly { dispose(): void }[];
}

/** Seeded PRNG (mulberry32): the wood grain and poster are identical on every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function woodTexture(): CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = PALETTE.wood;
    ctx.fillRect(0, 0, size, size);
    const rand = prng(0x5a4e);
    for (let i = 0; i < 26; i += 1) {
      const y0 = rand() * size;
      const amp = 2 + rand() * 5;
      const freq = (1 + Math.floor(rand() * 3)) * ((2 * Math.PI) / size);
      ctx.strokeStyle = PALETTE.grain;
      ctx.globalAlpha = 0.05 + rand() * 0.1;
      ctx.lineWidth = 1 + rand() * 2.5;
      ctx.beginPath();
      for (let x = 0; x <= size; x += 8) {
        const y = y0 + Math.sin(x * freq + i) * amp;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(0.45, 0.45);
  return texture;
}

function blobTexture(): CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(0,0,0,0.85)');
    g.addColorStop(0.45, 'rgba(0,0,0,0.45)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  return new CanvasTexture(canvas);
}

function roundedSquare(half: number, radius: number): Shape {
  const s = new Shape();
  s.moveTo(-half + radius, -half);
  s.lineTo(half - radius, -half);
  s.quadraticCurveTo(half, -half, half, -half + radius);
  s.lineTo(half, half - radius);
  s.quadraticCurveTo(half, half, half - radius, half);
  s.lineTo(-half + radius, half);
  s.quadraticCurveTo(-half, half, -half, half - radius);
  s.lineTo(-half, -half + radius);
  s.quadraticCurveTo(-half, -half, -half + radius, -half);
  return s;
}

/** Box body with a square tunnel, bevelled so the rim of the square hole catches the light. */
function boxGeometry(): ExtrudeGeometry {
  const outer = roundedSquare(BOX.width / 2 - BOX.bevel, 0.14);
  const h = BOX.holeSide / 2;
  const hole = new Path();
  hole.moveTo(-h, -h);
  hole.lineTo(-h, h);
  hole.lineTo(h, h);
  hole.lineTo(h, -h);
  hole.lineTo(-h, -h);
  outer.holes.push(hole);
  const geometry = new ExtrudeGeometry(outer, {
    depth: BOX.height,
    bevelEnabled: true,
    bevelThickness: BOX.bevel,
    bevelSize: BOX.bevel,
    bevelSegments: 3,
    curveSegments: 6,
  });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, BOX.bevel, 0);
  return geometry;
}

/** Dark open-top lining inside the tunnel; vertex colours fake depth (lighter rim, black floor). */
function liningGeometry(): BoxGeometry {
  const side = BOX.holeSide - 2 * BOX.bevel - 0.008;
  const top = BOX.height + BOX.bevel;
  const bottom = 0.12;
  const geometry = new BoxGeometry(side, top - bottom, side);
  geometry.translate(0, (top + bottom) / 2, 0);
  const positions = geometry.getAttribute('position');
  const colors = new Float32Array(positions.count * 3);
  const upper = new Color(PALETTE.holeTop);
  const lower = new Color(PALETTE.holeBottom);
  const mixed = new Color();
  for (let i = 0; i < positions.count; i += 1) {
    const t = (positions.getY(i) - bottom) / (top - bottom);
    mixed.copy(lower).lerp(upper, t ** 2.2);
    colors.set([mixed.r, mixed.g, mixed.b], i * 3);
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  return geometry;
}

function gemGeometry(): LatheGeometry {
  const points = [new Vector2(0, 0), new Vector2(0.3, 0), new Vector2(0.42, 0.2), new Vector2(0.3, 0.52), new Vector2(0, 0.74)];
  return new LatheGeometry(points, 7);
}

function standard(color: string, roughness: number, flatShading = false): MeshStandardMaterial {
  return new MeshStandardMaterial({ color, roughness, metalness: 0, flatShading });
}

export function buildShapeSorter(): ShapeSorterGraph {
  const resources: { dispose(): void }[] = [];
  const track = <T extends BufferGeometry | Material | Texture>(r: T): T => {
    resources.push(r);
    return r;
  };
  const scene = new Scene();

  scene.add(new HemisphereLight('#ece8ff', '#1a2336', 1.35));
  const key = new DirectionalLight('#fff2df', 2.7);
  key.position.set(-3, 6, 4.5);
  const rim = new DirectionalLight('#a78bfa', 1.7);
  rim.position.set(4, 3, -5);
  const fill = new DirectionalLight('#9dbbff', 0.55);
  fill.position.set(5, 1.5, 3);
  scene.add(key, rim, fill);

  const wood = track(woodTexture());
  const blob = track(blobTexture());
  const shadowMaterial = (opacity: number) =>
    track(new MeshBasicMaterial({ map: blob, color: '#000000', transparent: true, opacity, depthWrite: false }));
  const plane = track(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
  const shadow = (x: number, z: number, size: number, opacity: number) => {
    const m = new Mesh(plane, shadowMaterial(opacity));
    m.position.set(x, 0.002, z);
    m.scale.set(size, 1, size);
    m.renderOrder = -1;
    scene.add(m);
    return m;
  };

  const box = new Group();
  const hidden = track(new MeshBasicMaterial({ visible: false }));
  const liningMaterial = track(new MeshBasicMaterial({ vertexColors: true, side: BackSide }));
  box.add(
    new Mesh(track(boxGeometry()), track(new MeshStandardMaterial({ map: wood, roughness: 0.72, metalness: 0 }))),
    // BoxGeometry groups: +x, -x, +y (open top), -y, +z, -z
    new Mesh(track(liningGeometry()), [liningMaterial, liningMaterial, hidden, liningMaterial, liningMaterial, liningMaterial]),
  );
  shadow(0.08, 0.1, BOX.width * 1.55, 0.6);
  scene.add(box);

  const sphere = new Mesh(track(new SphereGeometry(SPHERE_RADIUS, 48, 32)), track(standard(PALETTE.red, 0.3)));
  scene.add(sphere);
  const sphereShadow = shadow(0, 0, SPHERE_RADIUS * 2.6, 0.5);

  const place = (mesh: Mesh, x: number, z: number, turn: number, shadowSize: number): Mesh => {
    mesh.position.set(x, 0, z);
    mesh.rotation.y = turn;
    scene.add(mesh);
    shadow(x, z, shadowSize, 0.5);
    return mesh;
  };
  const cubeGeometry = track(new RoundedBoxGeometry(0.74, 0.74, 0.74, 5, 0.16).translate(0, 0.37, 0));
  const pyramidGeometry = track(new ConeGeometry(0.54, 0.88, 4, 1).translate(0, 0.44, 0));
  const cube = place(new Mesh(cubeGeometry, track(standard(PALETTE.yellow, 0.42))), 1.8, 0.62, -0.45, 1.3);
  const pyramid = place(new Mesh(pyramidGeometry, track(standard(PALETTE.blue, 0.38, true))), 2.15, -0.7, 0.35, 1.3);
  const gem = place(new Mesh(track(gemGeometry()), track(standard(PALETTE.green, 0.26, true))), -1.9, -0.15, 0.3, 1.1);

  return {
    scene,
    box,
    sphere,
    sphereShadow,
    resting: [
      { mesh: cube, baseTilt: 0, wobbleSign: 1 },
      { mesh: pyramid, baseTilt: 0, wobbleSign: -1 },
      { mesh: gem, baseTilt: 0, wobbleSign: 0.8 },
    ],
    resources,
  };
}
