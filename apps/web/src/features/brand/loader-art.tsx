/**
 * Drawings for the logo loader, copied from the brand kit (squarehole-branding, logo/svg): the full-colour master
 * `square-hole-mark.svg` (256 grid) split into layers so the glow can move on its own, and the hinted 16 and 24 px
 * drawings `square-hole-mark-16.svg` / `-24.svg`. The five toy shapes are the Misfit blocks without faces, in colours
 * outside the warning and success hues (green, red and yellow stay UI states). Nothing here is a control.
 */
import type { ReactNode } from 'react';

/** The 256 tile plus 48 units of room on every side, so a shape can sit above the tile inside the loader's box. */
export const FULL_VIEWBOX = '-48 -48 352 352';

/** A rounded square as a path (for even-odd rings: a glow with the hole cut out). */
export function roundedSquare(x: number, size: number, r: number): string {
  const e = x + size;
  if (r === 0) return `M${x} ${x}H${e}V${e}H${x}Z`;
  const arc = (toX: number, toY: number) => `A${r} ${r} 0 0 1 ${toX} ${toY}`;
  return `M${x + r} ${x}H${e - r}${arc(e, x + r)}V${e - r}${arc(e - r, e)}H${x + r}${arc(x, e - r)}V${x + r}${arc(x + r, x)}Z`;
}

/** The master's well (x 76, 104 wide, radius 6): the glow around it is cut out here, so it never tints the hole. */
const WELL = roundedSquare(76, 104, 6);
const SPILL = `M20 20H236V236H20Z${WELL}`;

interface LayerProps {
  readonly className?: string;
  readonly viewBox: string;
  readonly children: ReactNode;
  readonly shape?: string;
}

/** One full-box layer: every layer fills the loader's box, so percentages in the keyframes mean the same at any size. */
function Layer({ className, viewBox, children, shape }: LayerProps) {
  return (
    <svg className={className ? `sh-loader__layer ${className}` : 'sh-loader__layer'} viewBox={viewBox} data-shape={shape} aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

/** The master mark in four layers: tile and well, glow (moves), flash in the hole (moves), lip. */
export function FullMark({ id, moving }: { id: string; moving: boolean }) {
  const ref = (name: string) => `url(#${id}${name})`;
  return (
    <>
      <Layer viewBox={FULL_VIEWBOX}>
        <defs>
          <linearGradient id={`${id}f`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#1D2B46" />
            <stop offset="1" stopColor="#0B111D" />
          </linearGradient>
          <linearGradient id={`${id}g`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#FFFFFF" stopOpacity=".09" />
            <stop offset=".45" stopColor="#FFFFFF" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={`${id}r`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#C4B2FF" stopOpacity=".8" />
            <stop offset=".5" stopColor="#6D4AE2" stopOpacity=".35" />
            <stop offset="1" stopColor="#6D4AE2" stopOpacity=".6" />
          </linearGradient>
          <linearGradient id={`${id}w`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#2A1D3A" />
            <stop offset=".6" stopColor="#05070C" />
          </linearGradient>
        </defs>
        <rect width="256" height="256" rx="58" fill={ref('f')} />
        <rect width="256" height="256" rx="58" fill={ref('g')} />
        <rect x="1.5" y="1.5" width="253" height="253" rx="56.5" fill="none" stroke={ref('r')} strokeWidth="3" />
        <rect x="76" y="76" width="104" height="104" rx="6" fill={ref('w')} />
      </Layer>
      <Layer className="sh-loader__glow" viewBox={FULL_VIEWBOX}>
        <defs>
          <radialGradient id={`${id}s`} cx=".5" cy=".5" r=".5">
            <stop offset=".45" stopColor="#A78BFA" stopOpacity=".32" />
            <stop offset="1" stopColor="#A78BFA" stopOpacity="0" />
          </radialGradient>
          <filter id={`${id}b`} x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="7" />
          </filter>
        </defs>
        <path d={SPILL} fill={ref('s')} fillRule="evenodd" />
        <rect x="71" y="71" width="114" height="114" rx="11" fill="none" stroke="#A78BFA" strokeWidth="10" filter={ref('b')} />
      </Layer>
      {moving ? (
        <Layer className="sh-loader__flash" viewBox={FULL_VIEWBOX}>
          <defs>
            <radialGradient id={`${id}h`} cx=".5" cy=".58" r=".55">
              <stop offset="0" stopColor="#C4B2FF" stopOpacity=".7" />
              <stop offset="1" stopColor="#A78BFA" stopOpacity="0" />
            </radialGradient>
          </defs>
          <rect x="76" y="76" width="104" height="104" rx="6" fill={ref('h')} />
        </Layer>
      ) : null}
      <Layer viewBox={FULL_VIEWBOX}>
        <defs>
          <filter id={`${id}c`} x="-10%" y="-10%" width="120%" height="120%">
            <feGaussianBlur stdDeviation="1.1" />
          </filter>
        </defs>
        <rect x="71" y="71" width="114" height="114" rx="11" fill="none" stroke="#A78BFA" strokeWidth="10" />
        <rect x="71" y="71" width="114" height="114" rx="11" fill="none" stroke="#F4F0FF" strokeWidth="3.5" filter={ref('c')} />
      </Layer>
    </>
  );
}

const STAR = 'M0-40L9.99-13.75L38.04-12.36L16.17 5.25L23.51 32.36L0 17L-23.51 32.36L-16.17 5.25L-38.04-12.36L-9.99-13.75Z';

/** The five shapes in the order they drop (80-unit drawings centred on 0,0). No cross: see the brand's look-alikes. */
export const SHAPES: readonly { readonly id: string; readonly art: ReactNode }[] = [
  {
    id: 'cube',
    art: (
      <>
        <path d="M0-37L32-18.5L0 0L-32-18.5Z" fill="#CFC8FF" stroke="#CFC8FF" />
        <path d="M-32-18.5L0 0V37L-32 18.5Z" fill="#9F93F2" stroke="#9F93F2" />
        <path d="M32-18.5L0 0V37L32 18.5Z" fill="#7C6FDB" stroke="#7C6FDB" />
      </>
    ),
  },
  {
    id: 'ball',
    art: (
      <>
        <circle r="36" fill="#3F98DE" />
        <circle cx="-4" cy="-4" r="31" fill="#6CC4FF" />
        <ellipse cx="-13" cy="-15" rx="9" ry="6" transform="rotate(-30 -13 -15)" fill="#E3F4FF" />
      </>
    ),
  },
  {
    id: 'pyramid',
    art: (
      <>
        <path d="M0-38L-38 24L4 36Z" fill="#FF9A55" stroke="#FF9A55" />
        <path d="M0-38L4 36L38 22Z" fill="#DB6A26" stroke="#DB6A26" />
      </>
    ),
  },
  {
    id: 'star',
    art: (
      <g transform="translate(0 3.8)">
        <path d={STAR} fill="#22C3C9" stroke="#22C3C9" strokeWidth="7" />
        <path d={STAR} transform="translate(-3 -4) scale(.42)" fill="#7FE3E6" stroke="#7FE3E6" strokeWidth="7" />
      </g>
    ),
  },
  {
    id: 'heart',
    art: (
      <g transform="translate(0 2)">
        <path d="M0 34C-30 14-40-2-40-14C-40-30-26-38-16-38C-7-38-2-32 0-26C2-32 7-38 16-38C26-38 40-30 40-14C40-2 30 14 0 34Z" fill="#FF7EB6" />
        <ellipse cx="-19" cy="-21" rx="8" ry="5" transform="rotate(-35 -19 -21)" fill="#FFD3E6" />
      </g>
    ),
  },
];

/** Each shape on its own layer, centred on the hole; the keyframes move it from above the tile into the hole. */
export function Shapes() {
  return (
    <>
      {SHAPES.map((shape) => (
        <Layer key={shape.id} className="sh-loader__shape" viewBox={FULL_VIEWBOX} shape={shape.id}>
          <g transform="translate(128 128)" strokeLinejoin="round" strokeWidth="3">
            {shape.art}
          </g>
        </Layer>
      ))}
    </>
  );
}

/** The hinted drawings: tile radius, then [offset, side, radius] of the halo, the lip and the hole. */
const SMALL = {
  16: { r: 4, halo: [3, 10, 1.5], lip: [4, 8, 1], hole: [5, 6, 0] },
  24: { r: 5.5, halo: [5, 14, 2], lip: [6, 12, 1.5], hole: [7, 10, 0.5] },
} as const;

type Square = readonly [number, number, number];

const squarePath = ([x, side, r]: Square) => roundedSquare(x, side, r);

const square = ([x, side, r]: Square, fill: string, opacity?: string) => (
  <rect x={x} y={x} width={side} height={side} rx={r || undefined} fill={fill} fillOpacity={opacity} />
);

/** The 16 or 24 px drawing, exactly as exported; while moving, a brighter halo ring breathes over it. */
export function SmallMark({ px, moving }: { px: 16 | 24; moving: boolean }) {
  const g = SMALL[px];
  const viewBox = `0 0 ${px} ${px}`;
  return (
    <>
      <Layer viewBox={viewBox}>
        <rect width={px} height={px} rx={g.r} fill="#1A2740" />
        {square(g.halo, '#A78BFA', '.32')}
        {square(g.lip, '#C4B2FF')}
        {square(g.hole, '#05070C')}
      </Layer>
      {moving ? (
        <Layer className="sh-loader__glow" viewBox={viewBox}>
          <path d={squarePath(g.halo) + squarePath(g.lip)} fill="#C4B2FF" fillOpacity=".9" fillRule="evenodd" />
        </Layer>
      ) : null}
    </>
  );
}
