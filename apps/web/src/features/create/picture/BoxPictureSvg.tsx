/**
 * SH-251: the box as a picture (box-picture/picture.ts lays it out). Every part is a real control: a focusable SVG group
 * with role button, a name that holds the words it shows, one description element (`<desc>`, the part's description:
 * what sits beside it as plain text) and `aria-expanded` for its sheet; Enter and Space open it as a click does. The
 * words beside a control (a side's pick, tag and number; the pool's and Square Hole's number; the box's item count) are
 * plain text outside every control, so no control holds words its name does not have. Focus shows as a solid ring on a
 * dark casing (the app's focus colours), an open sheet's part as a dashed maple ring on the same casing.
 * The routes' paths carry ids (`<idPrefix>-<route>-<side>`), so "What happens" can send coins along them (flight.ts).
 */
import type { KeyboardEvent, ReactNode, Ref } from 'react';
import { TEMPLATE_ICONS } from '../../brand/template-icons';
import { CAST, type CastId } from '../../box-picture/cast';
import { LOCK_ICON } from '../../box-picture/mini';
import { LAYOUT, SIDES, type BoxPicture, type PartId, type Rect, type SideView, type StationIcon } from '../../box-picture/picture';
import { PICTURE_WORDS } from '../../box-picture/picture-words';

/**
 * SH-255: what the box page draws into the same picture (core/v2/picture/: what IS and what HAPPENED). Each layer is
 * optional and Create passes none, so Create's picture is unchanged.
 */
export interface PictureLayers {
  /** The words under "Buys" and "Sells" in place of the fee's 1% (each side's fees so far). */
  readonly visitor?: Readonly<Record<'buyers' | 'sellers', string>>;
  /** The box front's words, inside the raise control, in place of Raise and Deadline. */
  readonly front?: ReactNode;
  /** Over the box's front, under its words: how full the raise is. */
  readonly fill?: ReactNode;
  /** Each side's routes: flowing where money went, faded where none did yet. */
  readonly routes?: Readonly<Record<'buyers' | 'sellers', 'flow' | 'idle'>>;
  /** False: the pool is not open yet (its tank empty, dashed). */
  readonly poolOpen?: boolean;
  /** More words beside the controls: plain text, outside every control. */
  readonly words?: ReactNode;
  /** More controls, after the picture's own (in reading order last). */
  readonly controls?: ReactNode;
}

export interface BoxPictureSvgProps {
  readonly picture: BoxPicture;
  /** The part whose sheet is open, or null. */
  readonly open: PartId | null;
  readonly onPart: (id: PartId) => void;
  readonly svgRef?: Ref<SVGSVGElement>;
  readonly idPrefix?: string;
  /** The picture's heading and the hint that says what to do with it. */
  readonly labelledBy?: string;
  readonly describedBy?: string;
  /** SH-255: the box page's layers (none on Create). */
  readonly layers?: PictureLayers;
}

const r1 = (n: number): number => Math.round(n * 10) / 10;
/** A number's size, smaller only when it would run past `room` (SH-255: the box page's long amounts); short ones keep `size`. */
export const numberSize = (text: string, size: number, room: number): number => Math.min(size, r1(room / Math.max(1, text.length * 0.6)));

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

function Coin({ x, y, r, token = false }: { x: number; y: number; r: number; token?: boolean }) {
  return (
    <g className={token ? 'sh-pic-coin sh-pic-coin--token' : 'sh-pic-coin'}>
      <circle cx={x} cy={y} r={r} className="sh-pic-coin__face" />
      <circle cx={x} cy={y} r={r1(r * 0.66)} className="sh-pic-coin__rim" strokeWidth={r1(Math.max(1.2, r * 0.12))} />
    </g>
  );
}

function StationArt({ icon }: { icon: StationIcon | null }) {
  if (icon === null) return <text x="12" y="17" textAnchor="middle" className="sh-pic-warn-text" fontSize="16">?</text>;
  if (icon === 'lock') return <path d={LOCK_ICON} className="sh-pic-icon" />;
  return <g className="sh-pic-icon">{TEMPLATE_ICONS[icon].art}</g>;
}

export function Hits({ rects }: { rects: readonly Rect[] }) {
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

/** A raise's digits at a size that fits the box front's column (a seven-digit raise included). */
const raiseSize = (text: string): number => (text.length <= 6 ? 20 : text.length <= 8 ? 16 : 13);

function Lines({ x, y, lines, className }: { x: number; y: number; lines: readonly string[]; className: string }) {
  return <>{lines.map((line, i) => <text key={`${i}-${line}`} x={x} y={y + i * 15} textAnchor="middle" className={className} fontSize="12.5">{line}</text>)}</>;
}

function ContentsArt({ picture }: { picture: BoxPicture }) {
  const { x, y } = LAYOUT.contents;
  const { kind, pile } = picture.contents;
  if (kind === null) return <text x={x} y={y + 6} textAnchor="middle" className="sh-pic-warn-text" fontSize="22">?</text>;
  if (kind === 'collection') {
    const tiles: readonly (readonly [string, number, number])[] = [['ball', 0, 0], ['peak', 1, 0], ['arch', 0, 1], ['peak', 1, 1]];
    return (
      <g data-contents="collection">
        {tiles.map(([shape, i, j]) => {
          const tx = x - 17 + i * 18;
          const ty = y - 18 + j * 18;
          const mx = tx + 8;
          const my = ty + 8;
          return (
            <g key={`${i}-${j}`}>
              <rect x={tx} y={ty} width="16" height="16" rx="3.5" className="sh-pic-tile" />
              {shape === 'ball' ? <circle cx={mx} cy={my} r="4.2" className="sh-pic-tile__shape" />
                : shape === 'peak' ? <path d={`M${mx} ${my - 4.6}L${mx + 4.8} ${my + 3.8}H${mx - 4.8}Z`} className="sh-pic-tile__shape" />
                  : <path d={`M${mx - 4.5} ${my + 4.5}V${my}a4.5 4.5 0 0 1 9 0V${my + 4.5}Z`} className="sh-pic-tile__shape" />}
            </g>
          );
        })}
      </g>
    );
  }
  if (kind === 'shop') {
    const sx = x - 20;
    const sy = y - 20;
    return (
      <g data-contents="shop">
        <rect x={sx + 2} y={sy + 12} width="36" height="26" rx="3" className="sh-pic-stall" />
        <rect x={sx} y={sy + 2} width="40" height="7" rx="2" className="sh-pic-wood-dark" />
        {[0, 1, 2, 3, 4].map((i) => <path key={i} d={`M${sx + i * 8} ${sy + 8}h8v4a4 4 0 0 1-8 0z`} className={i % 2 ? 'sh-pic-awning' : 'sh-pic-wood'} />)}
        <rect x={sx + 6} y={sy + 24} width="10" height="8" rx="2" className="sh-pic-wood-light" />
        <rect x={sx} y={sy + 36} width="40" height="3" rx="1.5" className="sh-pic-wood-dark" />
      </g>
    );
  }
  if (pile) {
    return (
      <g data-contents="pile">
        <path d={`M${x - 20} ${y + 16}V${y - 2}a20 20 0 0 1 40 0V${y + 16}`} className="sh-pic-dome" />
        {[0, 1, 2, 3].map((i) => <ellipse key={`a${i}`} cx={x} cy={y + 10 - i * 5} rx="11" ry="3.6" className="sh-pic-coin__face" />)}
        {[0, 1].map((i) => <ellipse key={`b${i}`} cx={x + 12} cy={y + 12 - i * 5} rx="8" ry="3" className="sh-pic-coin__face" />)}
        <rect x={x - 24} y={y + 15} width="48" height="4" rx="2" className="sh-pic-dome__base" />
      </g>
    );
  }
  return <g data-contents="token" />;
}

function Tray({ view }: { view: SideView }) {
  const { y, h } = LAYOUT.tray;
  return (
    <g data-tray={view.side}>
      <rect x={view.tray.x0} y={y} width={view.tray.x1 - view.tray.x0} height={h} rx="8" className="sh-pic-tray" />
      {view.tray.cells.map((cell, i) => (
        <rect key={i} data-cell={`${view.side}-${i}`} x={cell.x} y={y + 5} width={cell.w} height={h - 10} rx="2.2"
          className={`sh-pic-cell sh-pic-cell--${cell.role}${cell.role === 'pick' && view.warn ? ' sh-pic-cell--warn' : ''}`} />
      ))}
    </g>
  );
}

/** A side's station inside its control: the door, the choice's drawing and, when the box cannot take it, a mark. */
function StationDoor({ view }: { view: SideView }) {
  const { y, r } = LAYOUT.station;
  const x = view.stationX;
  return (
    <g data-station={view.side}>
      {view.warn ? null : <circle cx={x} cy={y} r={r + 9} className="sh-pic-glow" />}
      <circle cx={x} cy={y} r={r} className={view.warn ? 'sh-pic-door sh-pic-door--warn' : 'sh-pic-door'} />
      <g transform={`translate(${r1(x - 15)} ${y - 15}) scale(1.25)`}><StationArt icon={view.icon} /></g>
      {view.warn ? (
        <g data-warn={view.side}>
          <circle cx={x + r - 4} cy={y - r + 4} r="9" className="sh-pic-warn-badge" />
          <text x={x + r - 4} y={y - r + 9} textAnchor="middle" className="sh-pic-warn-badge__text" fontSize="13">!</text>
        </g>
      ) : null}
    </g>
  );
}

/** The words beside a side's station: its pick, what it carries, its number. Plain text, outside every control. */
function StationWords({ view }: { view: SideView }) {
  const { y, r } = LAYOUT.station;
  const x = view.stationX;
  const tagWidth = view.tag ? Math.max(34, view.tag.length * 7 + 12) : 0;
  const below = view.tag ? 12 : 0;
  const labelY = y + r + 18 + below;
  return (
    <g className="sh-pic-words" data-words={view.side}>
      {view.tag ? (
        <g transform={`translate(${r1(x - tagWidth / 2)} ${y + r - 9})`}>
          <rect width={r1(tagWidth)} height="20" rx="10" className="sh-pic-tag" />
          <text x={r1(tagWidth / 2)} y="14" textAnchor="middle" className="sh-pic-tag__text" fontSize="12">{view.tag}</text>
        </g>
      ) : null}
      <Lines x={x} y={labelY} lines={view.label} className={view.warn ? 'sh-pic-warn-text sh-pic-small' : 'sh-pic-label sh-pic-small'} />
      {view.number ? <text x={x} y={labelY + view.label.length * 15 + 6} textAnchor="middle" className="sh-pic-number" fontSize={numberSize(view.number, 16, 96)} data-number={view.side}>{view.number}</text> : null}
    </g>
  );
}

export function BoxPictureSvg({ picture, open, onPart, svgRef, idPrefix = 'sh-pic', labelledBy, describedBy, layers }: BoxPictureSvgProps) {
  const { box, token, front, creator, holders, mark, pool, visitor, feeY, contents } = LAYOUT;
  const parts = new Map(picture.parts.map((part) => [part.id, part]));
  const describedId = (id: PartId) => `${idPrefix}-desc-${id}`;
  const part = (id: PartId, children: ReactNode) => {
    const own = parts.get(id);
    if (!own) return null;
    const onKeyDown = (event: KeyboardEvent<SVGGElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      onPart(id);
    };
    return (
      <g key={id} className={`sh-pic-part${open === id ? ' is-open' : ''}`} data-part={id} role="button" tabIndex={0} aria-label={own.name}
        aria-describedby={own.description ? describedId(id) : undefined} aria-haspopup="dialog" aria-expanded={open === id} onClick={() => onPart(id)} onKeyDown={onKeyDown}>
        {own.description ? <desc id={describedId(id)}>{own.description}</desc> : null}
        <Hits rects={own.hit} />
        {children}
      </g>
    );
  };
  const side = (view: SideView) => {
    const buys = view.side === 'buyers';
    return part(view.side, (
      <>
        <Figure id="visitor" x={view.visitorX} foot={visitor.foot} h={visitor.h} mirror={!buys} />
        <text x={view.visitorX} y="124" textAnchor="middle" className="sh-pic-label sh-pic-small" fontSize="13">{buys ? PICTURE_WORDS.buys : PICTURE_WORDS.sells}</text>
        <Tray view={view} />
        <StationDoor view={view} />
      </>
    ));
  };
  return (
    <svg ref={svgRef} className={`sh-pic${open ? ' has-open' : ''}`} viewBox={`0 0 ${picture.width} ${picture.height}`} role="group"
      aria-label={labelledBy ? undefined : PICTURE_WORDS.pictureName} aria-labelledby={labelledBy} aria-describedby={describedBy}>
      <defs>
        <linearGradient id={`${idPrefix}-top`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" className="sh-pic-stop-maple-light" /><stop offset="1" className="sh-pic-stop-maple" /></linearGradient>
        <linearGradient id={`${idPrefix}-front`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" className="sh-pic-stop-maple" /><stop offset="1" className="sh-pic-stop-maple-dark" /></linearGradient>
        <linearGradient id={`${idPrefix}-water`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" className="sh-pic-stop-water-light" /><stop offset="1" className="sh-pic-stop-water" /></linearGradient>
      </defs>
      {/* The routes, under everything else: lanes into the hole, each tray's 10 to its station and 2 to the pool. */}
      {SIDES.map((s) => {
        const view = picture.sides[s];
        const sell = `${s === 'sellers' ? ' sh-pic-route--sell' : ''}${layers?.routes ? ` sh-pic-route--${layers.routes[s]}` : ''}`;
        return (
          <g key={`routes-${s}`} className="sh-pic-routes" aria-hidden="true">
            <path id={`${idPrefix}-lane-${s}`} d={view.paths.lane} className={`sh-pic-lane${sell}`} />
            <path id={`${idPrefix}-pick-${s}`} d={view.paths.pick} className={`sh-pic-route sh-pic-route--pick${sell}${view.warn ? ' sh-pic-route--warn' : ''}`} />
            <path id={`${idPrefix}-pool-${s}`} d={view.paths.pool} className={`sh-pic-route sh-pic-route--pool${sell}`} />
            <path id={`${idPrefix}-mark-${s}`} d={view.paths.mark} className="sh-pic-route--hidden" />
            <path id={`${idPrefix}-drop-${s}`} d={view.paths.drop} className="sh-pic-route--hidden" />
          </g>
        );
      })}
      {side(picture.sides.buyers)}
      {part('token', (
        <>
          <path d={`M${token.x} 106 V 88`} className="sh-pic-rise" />
          <circle cx={token.x} cy={token.y} r="26" className="sh-pic-glow" />
          <Coin x={token.x} y={token.y} r={token.r} token />
          <text x={token.x} y={token.tickerY} textAnchor="middle" className="sh-pic-ticker" fontSize="20">{picture.ticker}</text>
        </>
      ))}
      {/* The box itself. */}
      <g className="sh-pic-box" aria-hidden="true">
        <ellipse cx="200" cy={box.bottom + 4} rx="120" ry="9" className="sh-pic-shadow" />
        <path d={`M${box.l + 18} ${box.top} H${box.r - 18} L${box.r} ${box.face} H${box.l} Z`} fill={`url(#${idPrefix}-top)`} className="sh-pic-wood-edge" />
        <path d={`M${box.l} ${box.face} H${box.r} V${box.bottom - 10} Q${box.r} ${box.bottom} ${box.r - 10} ${box.bottom} H${box.l + 10} Q${box.l} ${box.bottom} ${box.l} ${box.bottom - 10} Z`} fill={`url(#${idPrefix}-front)`} className="sh-pic-wood-edge" />
        {layers?.fill ?? null}
        {[158, 176, 196].map((y, i) => <path key={y} d={`M${box.l + 10} ${y} q 30 ${i % 2 ? 4 : -4} 60 0 t 60 0 t 60 0`} className="sh-pic-grain" />)}
        <path d={LAYOUT.hole} className="sh-pic-hole" />
        <path d={LAYOUT.hole} className="sh-pic-hole__glow" />
      </g>
      {part('contents', <ContentsArt picture={picture} />)}
      {side(picture.sides.sellers)}
      {part('creator', (
        <>
          {picture.lit.creator ? <circle cx={creator.x} cy="196" r="34" className="sh-pic-glow sh-pic-glow--lit" /> : null}
          <Figure id="creator" x={creator.x} foot={creator.foot} h={creator.h} />
          <text x={creator.x} y="238" textAnchor="middle" className="sh-pic-label sh-pic-small" fontSize="12">{PICTURE_WORDS.creator}</text>
        </>
      ))}
      {part('raise', layers?.front ?? (
        <>
          <text x={front.raiseX} y="159" textAnchor="middle" className="sh-pic-wood-text sh-pic-small" fontSize="11">{PICTURE_WORDS.raise}</text>
          <text x={front.raiseX} y="183" textAnchor="middle" className="sh-pic-wood-text" fontSize={raiseSize(picture.front.raise)}>{picture.front.raise}</text>
          <text x={front.raiseX} y="201" textAnchor="middle" className="sh-pic-wood-text sh-pic-small" fontSize="13">{picture.front.symbol}</text>
          <text x={front.deadlineX} y="159" textAnchor="middle" className="sh-pic-wood-text sh-pic-small" fontSize="11">{PICTURE_WORDS.deadline}</text>
          <text x={front.deadlineX} y="183" textAnchor="middle" className="sh-pic-wood-text" fontSize="20">{picture.front.deadline}</text>
          <text x={front.deadlineX} y="201" textAnchor="middle" className="sh-pic-wood-text sh-pic-small" fontSize="13">{PICTURE_WORDS.days}</text>
        </>
      ))}
      {part('price', (
        <>
          <circle cx={front.coinX} cy={front.coinY} r="22" className="sh-pic-socket" />
          <Coin x={front.coinX} y={front.coinY} r={17} />
          <text x={front.coinX} y="213" textAnchor="middle" className="sh-pic-wood-text" fontSize="13">{picture.front.symbol}</text>
        </>
      ))}
      {part('holders', (
        <>
          {picture.lit.holders ? <circle cx={holders.x} cy="200" r="36" className="sh-pic-glow sh-pic-glow--lit" /> : null}
          <Figure id="visitor" x={holders.x - 22} foot={holders.foot + 2} h={24} />
          <Figure id="crowd" x={holders.x + 22} foot={holders.foot + 2} h={24} />
          <Figure id="holder" x={holders.x} foot={holders.foot} h={32} />
          <text x={holders.x} y="238" textAnchor="middle" className="sh-pic-label sh-pic-small" fontSize="12">{PICTURE_WORDS.holders}</text>
        </>
      ))}
      <g aria-hidden="true">
        {SIDES.map((s) => {
          const x = picture.sides[s].feeX;
          const buys = s === 'buyers';
          return (
            <g key={`fee-${s}`}>
              <Coin x={x} y={feeY} r={7} />
              <text x={buys ? x - 12 : x + 12} y={feeY + 5} textAnchor={buys ? 'end' : 'start'} className="sh-pic-label" fontSize="13">{PICTURE_WORDS.fee}</text>
            </g>
          );
        })}
      </g>
      {part('mark', (
        <>
          <rect x={mark.x - mark.size / 2} y={mark.y - mark.size / 2} width={mark.size} height={mark.size} rx="5" className="sh-pic-mark" />
          <rect x={mark.x - 4.5} y={mark.y - 4.5} width="9" height="9" rx="1.6" className="sh-pic-mark__hole" />
        </>
      ))}
      {part('pool', (
        <>
          <rect x={pool.x0} y={pool.y0} width={pool.x1 - pool.x0} height={pool.y1 - pool.y0} rx="10" className="sh-pic-tank" />
          {layers?.poolOpen === false ? null : (
            <>
              <path d={`M${pool.x0} ${pool.y0 + 16} q 10.5 -4 21 0 t 21 0 t 21 0 t 21 0 V ${pool.y1 - 10} a 10 10 0 0 1 -10 10 H ${pool.x0 + 10} a 10 10 0 0 1 -10 -10 Z`} fill={`url(#${idPrefix}-water)`} className="sh-pic-water" />
              <Coin x={182} y={330} r={7} token />
              <Coin x={200} y={334} r={7} />
              <Coin x={218} y={330} r={7} token />
            </>
          )}
          <rect x={pool.x0} y={pool.y0} width={pool.x1 - pool.x0} height={pool.y1 - pool.y0} rx="10" className={layers?.poolOpen === false ? 'sh-pic-tank__edge sh-pic-tank__edge--closed' : 'sh-pic-tank__edge'} />
          <text x="200" y="364" textAnchor="middle" className="sh-pic-muted sh-pic-small" fontSize="12">{PICTURE_WORDS.pool}</text>
        </>
      ))}
      {/* The words beside the controls: plain text, never inside one (each control's description holds them too). */}
      <g className="sh-pic-words">
        {SIDES.map((s) => (
          <g key={`words-${s}`}>
            <text x={picture.sides[s].visitorX} y="140" textAnchor="middle" className={layers?.visitor ? 'sh-pic-number' : 'sh-pic-muted sh-pic-small'} fontSize={layers?.visitor ? numberSize(layers.visitor[s], 15, 88) : 13} data-number={layers?.visitor ? `fee-${s}` : undefined}>{layers?.visitor?.[s] ?? PICTURE_WORDS.fee}</text>
            <StationWords view={picture.sides[s]} />
          </g>
        ))}
        {picture.contents.items !== null ? <text x={contents.x + 26} y={contents.y + 5} className="sh-pic-number" fontSize="15" data-number="items">{picture.contents.items}</text> : null}
        <text x={mark.x} y={mark.y + 30} textAnchor="middle" className="sh-pic-label" fontSize={numberSize(picture.mark.number, 12, 72)} data-number="mark">{picture.mark.number}</text>
        <text x="200" y="384" textAnchor="middle" className="sh-pic-number" fontSize={numberSize(picture.pool.number, 16, 150)} data-number="pool">{picture.pool.number}</text>
        {layers?.words ?? null}
      </g>
      {layers?.controls ?? null}
      <g id={`${idPrefix}-fx`} className="sh-pic-fx" aria-hidden="true" />
    </svg>
  );
}
