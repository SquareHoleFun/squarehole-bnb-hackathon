/**
 * SH-281: a launch as a picture, drawn in the platform's art (apps/web/src/features/create/picture/BoxPictureSvg.tsx
 * at main b8fbcef9: the box, the coins, the cast's figures, the trays, the stations, the pool, the focus rings; its
 * layout numbers are the platform's LAYOUT). Every part is a real control: a focusable group with role button, a name
 * that holds the words it shows and `aria-expanded` for its sheet; Enter and Space open it as a click does.
 */
import type { KeyboardEvent, ReactNode, Ref } from 'react';
import { CAST, type CastId } from './cast';
import { ICONS, type IconId } from './icons';
import { WORDS, type CellKind, type LaunchPicture, type PartId } from './launch-picture';

const r1 = (n: number): number => Math.round(n * 10) / 10;

/** The platform's layout (box-picture/picture.ts LAYOUT), the parts this picture uses. */
export const LAYOUT = Object.freeze({
  width: 400,
  height: 468,
  box: Object.freeze({ l: 92, r: 308, top: 110, face: 136, bottom: 222 }),
  hole: 'M171 114 H229 L237 131 H163 Z',
  token: Object.freeze({ x: 200, y: 66, r: 17, tickerY: 32 }),
  front: Object.freeze({ raiseX: 128, coinX: 200, coinY: 175, deadlineX: 272 }),
  creator: Object.freeze({ x: 44, foot: 220, h: 54 }),
  holders: Object.freeze({ x: 356, foot: 222 }),
  tray: Object.freeze({ y: 254, h: 26, buyers: [12, 190] as const, sellers: [210, 388] as const }),
  pool: Object.freeze({ x0: 158, x1: 242, y0: 304, y1: 346 }),
  station: Object.freeze({ y: 358, r: 27, burnX: 92, pileX: 308 }),
  visitor: Object.freeze({ foot: 104, h: 40, buyers: 40, sellers: 360 }),
});

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

const { box, token, front, creator, holders, tray, pool, station, visitor } = LAYOUT;

/** Each part's hit areas (at least 44 px at the picture's smallest width on a phone). */
export const HITS: Readonly<Record<PartId, readonly Rect[]>> = Object.freeze({
  token: [{ x: 150, y: 8, w: 100, h: 84 }],
  buyers: [{ x: 8, y: 56, w: 70, h: 116 }],
  sellers: [{ x: 322, y: 56, w: 70, h: 116 }],
  creator: [{ x: 8, y: 158, w: 76, h: 86 }],
  raise: [{ x: box.l + 4, y: box.face + 6, w: 66, h: 74 }],
  price: [{ x: front.coinX - 30, y: box.face + 6, w: 60, h: 80 }],
  deadline: [{ x: box.r - 70, y: box.face + 6, w: 66, h: 74 }],
  tax: [
    // The trays: 52 units high (44 px at a phone's width), from under the creator's number to above the pool.
    { x: tray.buyers[0] - 2, y: tray.y - 10, w: tray.sellers[1] - tray.buyers[0] + 4, h: 52 },
    { x: station.burnX - 52, y: station.y - station.r - 10, w: 104, h: 110 },
  ],
  pool: [{ x: pool.x0 - 6, y: pool.y0 - 6, w: pool.x1 - pool.x0 + 12, h: 92 }],
  pile: [
    { x: station.pileX - 52, y: station.y - station.r - 10, w: 104, h: 110 },
    { x: holders.x - 40, y: 172, w: 80, h: 76 },
  ],
  // SH-319 (a launched token's page only): the holders on their own, the card shop in the top right corner.
  holders: [{ x: holders.x - 40, y: 172, w: 80, h: 76 }],
  shop: [{ x: 282, y: 4, w: 114, h: 48 }],
});

function Figure({ id, x, foot, h, mirror = false }: { id: CastId; x: number; foot: number; h: number; mirror?: boolean }) {
  const figure = CAST[id];
  const s = h / figure.h;
  const w = figure.w * s;
  const transform = mirror ? `translate(${r1(x + w / 2)} ${r1(foot - h)}) scale(${-s} ${s})` : `translate(${r1(x - w / 2)} ${r1(foot - h)}) scale(${s})`;
  return (
    <g transform={transform} className="sh-pic-cast">
      <path d={figure.body} className="sh-pic-cast__body" strokeWidth={r1(2.6 / s)} />
      <path d={figure.face} className="sh-pic-cast__face" />
    </g>
  );
}

function Coin({ x, y, r, token: isToken = false }: { x: number; y: number; r: number; token?: boolean }) {
  return (
    <g className={isToken ? 'sh-pic-coin sh-pic-coin--token' : 'sh-pic-coin'}>
      <circle cx={x} cy={y} r={r} className="sh-pic-coin__face" />
      <circle cx={x} cy={y} r={r1(r * 0.66)} className="sh-pic-coin__rim" strokeWidth={r1(Math.max(1.2, r * 0.12))} />
    </g>
  );
}

function Hits({ rects }: { rects: readonly Rect[] }) {
  const each = (className: string) => rects.map((rect, i) => <rect key={`${className}-${i}`} className={className} x={rect.x} y={rect.y} width={rect.w} height={rect.h} rx="10" />);
  return (
    <>
      {each('sh-pic-hit')}
      {each('sh-pic-casing')}
      {each('sh-pic-ring sh-pic-ring--focus')}
      {each('sh-pic-ring sh-pic-ring--open')}
    </>
  );
}

function Lines({ x, y, lines, className, size = 12.5, anchor = 'middle' }: { x: number; y: number; lines: readonly string[]; className: string; size?: number; anchor?: 'start' | 'middle' | 'end' }) {
  return (
    <>
      {lines.map((line, i) => (
        <text key={`${i}-${line}`} x={x} y={y + i * (size + 2.5)} textAnchor={anchor} className={className} fontSize={size}>
          {line}
        </text>
      ))}
    </>
  );
}

/** A value's size in the box front's column (a long one smaller). */
const valueSize = (text: string): number => (text.length <= 5 ? 20 : text.length <= 7 ? 16 : text.length <= 9 ? 13 : 11);
/** A unit's size under it ("USDT (test)" smaller than "BNB"). */
const unitSize = (text: string): number => (text.length <= 6 ? 13 : 10);

function Station({ x, icon, warn }: { x: number; icon: IconId; warn: boolean }) {
  const { y, r } = station;
  return (
    <g>
      {warn ? null : <circle cx={x} cy={y} r={r + 9} className="sh-pic-glow" />}
      <circle cx={x} cy={y} r={r} className={warn ? 'sh-pic-door sh-pic-door--warn' : 'sh-pic-door'} />
      <g transform={`translate(${r1(x - 15)} ${y - 15}) scale(1.25)`} className="sh-pic-icon">
        {ICONS[icon]}
      </g>
    </g>
  );
}

/** The holders standing by the pile, with their word under them. */
function HolderFigures({ lines }: { lines?: readonly string[] | null }) {
  return (
    <>
      <Figure id="visitor" x={holders.x - 22} foot={holders.foot + 2} h={24} />
      <Figure id="crowd" x={holders.x + 22} foot={holders.foot + 2} h={24} />
      <Figure id="holder" x={holders.x} foot={holders.foot} h={32} />
      {lines && lines.length ? (
        <Lines x={holders.x} y={237} lines={lines} className="sh-pic-label sh-pic-small" size={11} />
      ) : (
        <text x={holders.x} y="238" textAnchor="middle" className="sh-pic-label sh-pic-small" fontSize="12">
          {WORDS.holders}
        </text>
      )}
    </>
  );
}

/** A part's problem mark: a small badge at its first area's corner. */
function WarnBadge({ id }: { id: PartId }) {
  const rect = HITS[id][0]!;
  const x = rect.x + rect.w - 6;
  const y = rect.y + 6;
  return (
    <g data-warn={id}>
      <circle cx={x} cy={y} r="9" className="sh-pic-warn-badge" />
      <text x={x} y={y + 5} textAnchor="middle" className="sh-pic-warn-badge__text" fontSize="13">
        !
      </text>
    </g>
  );
}

/** A tray of 10 in the picture's order of kinds (LaunchPicture.cells); on the sells side mirrored. */
function trayCells(side: 'buyers' | 'sellers', kinds: readonly CellKind[]) {
  const [x0, x1] = tray[side];
  const pad = 5;
  const gap = 1.8;
  const cell = (x1 - x0 - 2 * pad - 9 * gap) / 10;
  return kinds.map((kind, i) => {
    const idx = side === 'buyers' ? i : 9 - i;
    return { x: r1(x0 + pad + idx * (cell + gap)), w: r1(cell), kind };
  });
}

const CELL_CLASS: Readonly<Record<CellKind, string>> = Object.freeze({
  burn: 'sh-pic-cell--burn',
  buyburn: 'sh-pic-cell--buyburn',
  creator: 'sh-pic-cell--creator',
  pile: 'sh-pic-cell--pick',
  holders: 'sh-pic-cell--holders',
  shop: 'sh-pic-cell--shop',
});

export interface LaunchPictureSvgProps {
  readonly picture: LaunchPicture;
  readonly open: PartId | null;
  readonly onPart: (id: PartId) => void;
  readonly svgRef?: Ref<SVGSVGElement>;
  readonly labelledBy?: string;
  readonly describedBy?: string;
  readonly idPrefix?: string;
  /** SH-294: the launch's own picture (a checked blob: URL) on the token's coin, or null for the plain coin. */
  readonly coinPicture?: string | null;
  /** SH-319: the parts lead to the page's panels (no sheet): no `aria-haspopup`, no `aria-expanded`. */
  readonly leads?: boolean;
  /** The picture's test id (the create forms' "launch-picture"; a token page's its own, so the two never mix). */
  readonly testId?: string;
}

/** SH-294: the launch's picture inside the token's coin (one self-contained part; the plain coin stays under it). */
function CoinPicture({ url, x, y, r, id }: { url: string; x: number; y: number; r: number; id: string }) {
  return (
    <g data-coin-picture="">
      <clipPath id={id}>
        <circle cx={x} cy={y} r={r} />
      </clipPath>
      <image href={url} x={x - r} y={y - r} width={2 * r} height={2 * r} clipPath={`url(#${id})`} preserveAspectRatio="xMidYMid slice" />
    </g>
  );
}

export function LaunchPictureSvg({ picture, open, onPart, svgRef, labelledBy, describedBy, idPrefix = 'sh-lp', coinPicture = null, leads = false, testId = 'launch-picture' }: LaunchPictureSvgProps) {
  const names = new Map(picture.parts.map((p) => [p.id, p.name]));
  // SH-319: the holders as their own part (a launched token's page with a stake); else they stand in the pile's part.
  const ownHolders = names.has('holders');
  const warn = new Set(picture.warn);
  const part = (id: PartId, children: ReactNode) => {
    const name = names.get(id);
    if (name === undefined) return null;
    const onKeyDown = (event: KeyboardEvent<SVGGElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      onPart(id);
    };
    return (
      <g
        key={id}
        className={`sh-pic-part${open === id ? ' is-open' : ''}${warn.has(id) ? ' is-warn' : ''}`}
        data-part={id}
        role="button"
        tabIndex={0}
        aria-label={warn.has(id) ? `${name} (to fix)` : name}
        aria-haspopup={leads ? undefined : 'dialog'}
        aria-expanded={leads ? undefined : open === id}
        onClick={() => onPart(id)}
        onKeyDown={onKeyDown}
      >
        <Hits rects={id === 'tax' && !picture.burn ? HITS.tax.slice(0, 1) : id === 'pile' && ownHolders ? HITS.pile.slice(0, 1) : HITS[id]} />
        {children}
      </g>
    );
  };
  const buyersTray = trayCells('buyers', picture.cells);
  const sellersTray = trayCells('sellers', picture.cells);
  /** The middle of the cells that run to the flame (burned, bought back and burned) or to the pile. */
  const mid = (cells: { x: number; w: number; kind: CellKind }[], burn: boolean) => {
    const own = cells.filter((c) => (burn ? c.kind === 'burn' || c.kind === 'buyburn' : c.kind === 'pile'));
    if (!own.length) return null;
    const xs = own.map((c) => c.x);
    return r1((Math.min(...xs) + Math.max(...own.map((c) => c.x + c.w))) / 2);
  };
  const bottom = tray.y + tray.h;
  const route = (from: number | null, to: number, kind: 'burn' | 'pile', key: string) =>
    from === null ? null : (
      <path key={key} d={`M${from} ${bottom} C ${from} ${bottom + 24}, ${to} ${station.y - station.r - 30}, ${to} ${station.y - station.r - 2}`} className={`sh-pic-route sh-pic-route--${kind === 'burn' ? 'burn' : 'pick'}`} />
    );
  return (
    <svg
      ref={svgRef}
      className={`sh-pic${open ? ' has-open' : ''}`}
      viewBox={`0 0 ${LAYOUT.width} ${LAYOUT.height}`}
      role="group"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      data-testid={testId}
    >
      <defs>
        <linearGradient id={`${idPrefix}-top`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" className="sh-pic-stop-maple-light" />
          <stop offset="1" className="sh-pic-stop-maple" />
        </linearGradient>
        <linearGradient id={`${idPrefix}-front`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" className="sh-pic-stop-maple" />
          <stop offset="1" className="sh-pic-stop-maple-dark" />
        </linearGradient>
        <linearGradient id={`${idPrefix}-water`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" className="sh-pic-stop-water-light" />
          <stop offset="1" className="sh-pic-stop-water" />
        </linearGradient>
      </defs>
      {/* The routes, under everything: the lanes into the hole, each tray's burned cells and the rest to their stations. */}
      <g className="sh-pic-routes" aria-hidden="true">
        <path d="M70 96 C 112 98, 138 118, 166 126" className="sh-pic-lane" />
        <path d="M330 96 C 288 98, 262 118, 234 126" className="sh-pic-lane sh-pic-route--sell" />
        {picture.burn ? route(mid(buyersTray, true), station.burnX, 'burn', 'b-burn') : null}
        {picture.burn ? route(mid(sellersTray, true), station.burnX, 'burn', 's-burn') : null}
        {route(mid(buyersTray, false), station.pileX, 'pile', 'b-pile')}
        {route(mid(sellersTray, false), station.pileX, 'pile', 's-pile')}
        <path d={`M200 ${box.bottom + 4} V ${pool.y0 - 2}`} className="sh-pic-route sh-pic-route--pool sh-pic-route--sell" />
      </g>
      {part(
        'buyers',
        <>
          <Figure id="visitor" x={visitor.buyers} foot={visitor.foot} h={visitor.h} />
          <text x={visitor.buyers} y="124" textAnchor="middle" className="sh-pic-label sh-pic-small" fontSize="13">
            {WORDS.buys}
          </text>
        </>,
      )}
      {part(
        'token',
        <>
          <path d={`M${token.x} 106 V 88`} className="sh-pic-rise" />
          <circle cx={token.x} cy={token.y} r="26" className="sh-pic-glow" />
          <Coin x={token.x} y={token.y} r={token.r} token />
          {coinPicture ? <CoinPicture url={coinPicture} x={token.x} y={token.y} r={token.r} id={`${idPrefix}-coin-picture`} /> : null}
          <text x={token.x} y={token.tickerY} textAnchor="middle" className="sh-pic-ticker" fontSize={picture.ticker.length > 8 ? 15 : 20}>
            {picture.ticker}
          </text>
        </>,
      )}
      {part(
        'sellers',
        <>
          <Figure id="visitor" x={visitor.sellers} foot={visitor.foot} h={visitor.h} mirror />
          <text x={visitor.sellers} y="124" textAnchor="middle" className="sh-pic-label sh-pic-small" fontSize="13">
            {WORDS.sells}
          </text>
        </>,
      )}
      {/* The box itself. */}
      <g className="sh-pic-box" aria-hidden="true">
        <ellipse cx="200" cy={box.bottom + 4} rx="120" ry="9" className="sh-pic-shadow" />
        <path d={`M${box.l + 18} ${box.top} H${box.r - 18} L${box.r} ${box.face} H${box.l} Z`} fill={`url(#${idPrefix}-top)`} className="sh-pic-wood-edge" />
        <path
          d={`M${box.l} ${box.face} H${box.r} V${box.bottom - 10} Q${box.r} ${box.bottom} ${box.r - 10} ${box.bottom} H${box.l + 10} Q${box.l} ${box.bottom} ${box.l} ${box.bottom - 10} Z`}
          fill={`url(#${idPrefix}-front)`}
          className="sh-pic-wood-edge"
        />
        {[158, 176, 196].map((y, i) => (
          <path key={y} d={`M${box.l + 10} ${y} q 30 ${i % 2 ? 4 : -4} 60 0 t 60 0 t 60 0`} className="sh-pic-grain" />
        ))}
        <path d={LAYOUT.hole} className="sh-pic-hole" />
        <path d={LAYOUT.hole} className="sh-pic-hole__glow" />
      </g>
      {part(
        'creator',
        <>
          <Figure id="creator" x={creator.x} foot={creator.foot} h={creator.h} />
          {picture.creatorTag ? (
            <g data-creator-tag="">
              {picture.creatorTagOf ? (
                <>
                  <rect x={50} y={160} width={46} height={27} rx="8" className="sh-pic-tag sh-pic-tag--creator" />
                  <text x={73} y={172} textAnchor="middle" className="sh-pic-tag__text" fontSize="11">
                    {picture.creatorTag}
                  </text>
                  <text x={73} y={182.5} textAnchor="middle" className="sh-pic-tag__text" fontSize="7.5">
                    {picture.creatorTagOf}
                  </text>
                </>
              ) : (
                <>
                  <rect x={52} y={160} width={40} height={18} rx="9" className="sh-pic-tag sh-pic-tag--creator" />
                  <text x={72} y={173} textAnchor="middle" className="sh-pic-tag__text" fontSize="12">
                    {picture.creatorTag}
                  </text>
                </>
              )}
            </g>
          ) : null}
          <Lines x={creator.x} y={237} lines={picture.creator} className="sh-pic-label sh-pic-small" size={11} />
        </>,
      )}
      {part(
        'raise',
        <>
          <text x={front.raiseX} y="159" textAnchor="middle" className="sh-pic-wood-text sh-pic-small" fontSize="11">
            {picture.front.left.label}
          </text>
          <text x={front.raiseX} y="183" textAnchor="middle" className={warn.has('raise') ? 'sh-pic-warn-wood' : 'sh-pic-wood-text'} fontSize={valueSize(picture.front.left.value)}>
            {picture.front.left.value}
          </text>
          <text x={front.raiseX} y="201" textAnchor="middle" className="sh-pic-wood-text sh-pic-small" fontSize={unitSize(picture.front.left.unit)}>
            {picture.front.left.unit}
          </text>
        </>,
      )}
      {part(
        'price',
        <>
          <circle cx={front.coinX} cy={front.coinY} r="22" className="sh-pic-socket" />
          <Coin x={front.coinX} y={front.coinY} r={17} />
          <text x={front.coinX} y="213" textAnchor="middle" className="sh-pic-wood-text" fontSize={unitSize(picture.coin)}>
            {picture.coin}
          </text>
        </>,
      )}
      {picture.front.right
        ? part(
            'deadline',
            <>
              <text x={front.deadlineX} y="159" textAnchor="middle" className="sh-pic-wood-text sh-pic-small" fontSize="11">
                {picture.front.right.label}
              </text>
              <text x={front.deadlineX} y="183" textAnchor="middle" className={warn.has('deadline') ? 'sh-pic-warn-wood' : 'sh-pic-wood-text'} fontSize={valueSize(picture.front.right.value)}>
                {picture.front.right.value}
              </text>
              <text x={front.deadlineX} y="201" textAnchor="middle" className="sh-pic-wood-text sh-pic-small" fontSize="13">
                {picture.front.right.unit}
              </text>
            </>,
          )
        : null}
      {part(
        'tax',
        <>
          {(['buyers', 'sellers'] as const).map((side) => (
            <g key={side} data-tray={side}>
              <rect x={tray[side][0]} y={tray.y} width={tray[side][1] - tray[side][0]} height={tray.h} rx="8" className="sh-pic-tray" />
              {(side === 'buyers' ? buyersTray : sellersTray).map((cell, i) => (
                <rect key={i} x={cell.x} y={tray.y + 5} width={cell.w} height={tray.h - 10} rx="2.2" className={CELL_CLASS[cell.kind]} data-cell={cell.kind} />
              ))}
            </g>
          ))}
          {picture.burn ? <Station x={station.burnX} icon="burn" warn={warn.has('tax')} /> : null}
        </>,
      )}
      {part(
        'pool',
        <>
          <rect x={pool.x0} y={pool.y0} width={pool.x1 - pool.x0} height={pool.y1 - pool.y0} rx="10" className="sh-pic-tank" />
          <path
            d={`M${pool.x0} ${pool.y0 + 16} q 10.5 -4 21 0 t 21 0 t 21 0 t 21 0 V ${pool.y1 - 10} a 10 10 0 0 1 -10 10 H ${pool.x0 + 10} a 10 10 0 0 1 -10 -10 Z`}
            fill={`url(#${idPrefix}-water)`}
            className="sh-pic-water"
          />
          <Coin x={182} y={330} r={7} token />
          <Coin x={200} y={334} r={7} />
          <Coin x={218} y={330} r={7} token />
          <rect x={pool.x0} y={pool.y0} width={pool.x1 - pool.x0} height={pool.y1 - pool.y0} rx="10" className="sh-pic-tank__edge" />
          <text x="200" y="364" textAnchor="middle" className="sh-pic-muted sh-pic-small" fontSize="12">
            {picture.pool.label}
          </text>
        </>,
      )}
      {part(
        'pile',
        <>
          {ownHolders ? null : <HolderFigures />}
          <Station x={station.pileX} icon="pile" warn={false} />
        </>,
      )}
      {ownHolders
        ? part(
            'holders',
            <>
              <HolderFigures lines={picture.holdersLines} />
              {picture.holdersTag ? (
                <text x={holders.x} y="184" textAnchor="middle" className="sh-pic-number" fontSize={picture.holdersTag.length > 9 ? 11 : 13} data-holders-tag="">
                  {picture.holdersTag}
                </text>
              ) : null}
            </>,
          )
        : null}
      {picture.shop
        ? part(
            'shop',
            <>
              <rect x={290} y={14} width={20} height={28} rx="3" className="sh-pic-card" transform="rotate(-12 300 28)" />
              <rect x={298} y={12} width={20} height={28} rx="3" className="sh-pic-card sh-pic-card--front" />
              <Lines x={326} y={25} lines={picture.shop} className="sh-pic-label sh-pic-small" size={11.5} anchor="start" />
            </>,
          )
        : null}
      {/* The words beside the controls: plain text, never inside one (each control's name holds them too). */}
      <g className="sh-pic-words" aria-hidden="true">
        <Lines x={visitor.buyers} y={140} lines={picture.buyers} className={warn.has('buyers') ? 'sh-pic-warn-text sh-pic-small' : 'sh-pic-muted sh-pic-small'} size={11.5} />
        <Lines x={visitor.sellers} y={140} lines={picture.sellers} className={warn.has('sellers') ? 'sh-pic-warn-text sh-pic-small' : 'sh-pic-muted sh-pic-small'} size={11.5} />
        {/* Above the buyers' tray, ending short of the pool's line: no route runs through it. */}
        <Lines x={190} y={248} lines={picture.center} className={warn.has('tax') ? 'sh-pic-warn-text sh-pic-small' : 'sh-pic-label sh-pic-small'} size={11} anchor="end" />
        {picture.burn ? <Lines x={station.burnX} y={station.y + station.r + 18} lines={picture.burn} className={warn.has('tax') ? 'sh-pic-warn-text sh-pic-small' : 'sh-pic-label sh-pic-small'} /> : null}
        <Lines x={station.pileX} y={station.y + station.r + 18} lines={picture.pile} className="sh-pic-label sh-pic-small" />
        <text x="200" y="384" textAnchor="middle" className={warn.has('pool') || warn.has('raise') ? 'sh-pic-warn-text' : 'sh-pic-number'} fontSize={picture.pool.number.length > 12 ? 12 : 15}>
          {picture.pool.number}
        </text>
      </g>
      <g aria-hidden="true">
        {picture.warn.map((id) => (
          <WarnBadge key={id} id={id} />
        ))}
      </g>
    </svg>
  );
}
