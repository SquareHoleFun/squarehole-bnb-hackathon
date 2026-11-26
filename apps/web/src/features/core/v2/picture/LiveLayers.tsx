/**
 * SH-255: what the box page draws into the shared picture (create/picture/BoxPictureSvg.tsx `layers`): the raise's
 * fill and the front's words, the burned total by the token, the holders' count, the items out, the pile's coin, the
 * empty pool before graduation and the picture's key, all plain text outside the controls; and one more control, the
 * inbox, drawn and named like the picture's own parts.
 */
import type { KeyboardEvent } from 'react';
import { formatTokenShort } from '../../../fit-pair/fit-format';
import { TEMPLATE_ICONS } from '../../../brand/template-icons';
import { LAYOUT, type Rect } from '../../../box-picture/picture';
import { Hits, type PictureLayers } from '../../../create/picture/BoxPictureSvg';
import type { LiveModel } from './live-picture';
import { BOX_PICTURE_WORDS as W } from './box-picture-words';

const r1 = (n: number): number => Math.round(n * 10) / 10;
/** The life strip's own drawings (LifeViewV2.tsx), on a 20-unit grid. */
const GRADUATE = 'M1.8 7.5 10 3.8l8.2 3.7L10 11.2zM5.2 9.3v3.9c1.3 1.4 3 2 4.8 2s3.5-.6 4.8-2V9.3M17.4 7.9v4.6';
const CLOSED = 'M10 3a7 7 0 1 0 0 14a7 7 0 1 0 0-14zM7.3 7.3l5.4 5.4M12.7 7.3l-5.4 5.4';
/** A number's size that fits its column on the box's front. */
const fit = (text: string, size: number, room: number): number => Math.min(size, r1(room / Math.max(1, text.length * 0.58)));

/** The inbox's place: top left of the box, under the buys lane's start. */
export const INBOX = Object.freeze({ x: 125, y: 59, hit: Object.freeze({ x: 100, y: 40, w: 50, h: 52 }) as Rect });

/** The front's right column's room for its state word: twice the box edge's distance from the column's centre, less a margin. */
const STATE_ROOM = 2 * (LAYOUT.box.r - LAYOUT.front.deadlineX) - 4;
/** A state word on one line where it fits at 12, else on two at its last space. */
export function stateLines(word: string): readonly string[] {
  const space = word.lastIndexOf(' ');
  return fit(word, 12, STATE_ROOM) >= 12 || space < 0 ? [word] : [word.slice(0, space), word.slice(space + 1)];
}

function Front({ model }: { model: LiveModel }) {
  const { front } = LAYOUT;
  const { left, right } = model.front;
  return (
    <>
      <text x={front.raiseX} y="159" textAnchor="middle" className="sh-pic-wood-text sh-pic-small" fontSize="11">{left.label}</text>
      <text x={front.raiseX} y="183" textAnchor="middle" className="sh-pic-wood-text" fontSize={fit(left.value, 20, 64)} data-number="front-left">{left.value}</text>
      <text x={front.raiseX} y="201" textAnchor="middle" className="sh-pic-wood-text sh-pic-small" fontSize={fit(left.sub, 12, 118)}>{left.sub}</text>
      {right.kind === 'figure' ? (
        <>
          <text x={front.deadlineX} y="159" textAnchor="middle" className="sh-pic-wood-text sh-pic-small" fontSize="11">{right.label}</text>
          <text x={front.deadlineX} y="183" textAnchor="middle" className="sh-pic-wood-text" fontSize="20" data-number="front-right">{right.value}</text>
          <text x={front.deadlineX} y="201" textAnchor="middle" className="sh-pic-wood-text sh-pic-small" fontSize="12">{right.sub}</text>
        </>
      ) : (
        <>
          <g transform={`translate(${front.deadlineX - 17} 152) scale(1.7)`} className="sh-bpic-glyph" data-state={right.glyph}><path d={right.glyph === 'graduate' ? GRADUATE : CLOSED} /></g>
          {/* The column's room is the box's edge each side of its centre (272 to 308: 68 units with a margin): a word of
              two that would not fit at 12 takes two lines ("Deadline" / "passed"), never a cut letter. */}
          {stateLines(right.word).map((line, i, lines) => (
            <text key={line} x={front.deadlineX} y={lines.length === 1 ? 201 : 196 + i * 14} textAnchor="middle" className="sh-pic-wood-text sh-pic-small" fontSize={fit(line, 12, STATE_ROOM)} data-number={i === 0 ? 'front-state' : undefined}>{line}</text>
          ))}
        </>
      )}
    </>
  );
}

/**
 * How full the raise is: the empty front in pale wood, the raised part in the box's maple up to its level. Where it is
 * not known (unpublished), the pale front with a dashed edge: never drawn as empty or full.
 */
function Fill({ model, idPrefix }: { model: LiveModel; idPrefix: string }) {
  const known = model.front.fill;
  if (known !== null && known >= 1) return null;
  const fill = known ?? 0;
  const { box } = LAYOUT;
  const shape = `M${box.l} ${box.face} H${box.r} V${box.bottom - 10} Q${box.r} ${box.bottom} ${box.r - 10} ${box.bottom} H${box.l + 10} Q${box.l} ${box.bottom} ${box.l} ${box.bottom - 10} Z`;
  const level = r1(box.bottom - (box.bottom - box.face) * fill);
  let wave = `M${box.l} ${level}`;
  for (let i = 0; i < 8; i += 1) wave += ` q 6.75 ${i % 2 ? 3 : -3} 13.5 0 t 13.5 0`;
  wave += ` V ${box.bottom} H ${box.l} Z`;
  return (
    <g data-fill={known === null ? 'unknown' : fill.toFixed(4)}>
      <clipPath id={`${idPrefix}-front-clip`}><path d={shape} /></clipPath>
      <path d={shape} className="sh-bpic-empty" />
      {fill > 0 ? <path d={wave} fill={`url(#${idPrefix}-front)`} clipPath={`url(#${idPrefix}-front-clip)`} className="sh-bpic-level" /> : null}
      <path d={shape} className={known === null ? 'sh-pic-wood-edge sh-bpic-outline sh-bpic-outline--unknown' : 'sh-pic-wood-edge sh-bpic-outline'} />
    </g>
  );
}

/** A badge's width: its round size for a short text, wider by `perChar` for each character past two. */
const badgeWidth = (text: string, round: number, perChar: number): number => r1(Math.max(round, round + (text.length - 2) * perChar));
/** The inbox's count of other coins where every coin was read; null where a read is missing or partial. */
const inboxCount = (model: LiveModel): number | null => (model.inbox.complete ? model.inbox.coins : null);
/** The drawing's right edge (its 400-unit width), less a margin. */
const DRAWING_RIGHT = 398;
/**
 * The holder badge's words: the count as the tile prints it while it fits a round badge (three characters), else the
 * site's short form (formatTokenShort: "123.45K"), so no digit leaves the badge (round 3b, G6).
 */
export function holderBadgeText(holders: string): string {
  if (holders.length <= 3) return holders;
  const count = BigInt(holders.replace(/\D/g, '') || '0');
  return formatTokenShort(count * 10n ** 18n, '').trim();
}
/** A badge centred at `x` but kept inside the drawing: its centre moves left as far as its width needs. */
const keptInside = (x: number, width: number): number => r1(Math.min(x, DRAWING_RIGHT - width / 2));

function Words({ model }: { model: LiveModel }) {
  const { token, contents, holders, pool, visitor } = LAYOUT;
  const holderX = (text: string) => keptInside(holders.x + 27, badgeWidth(holderBadgeText(text), 22, 7));
  const tickerWidth = model.ticker.length * 11.5;
  const pillX = token.x + tickerWidth / 2 + 8;
  const pillW = model.burned ? 25 + model.burned.length * 6.8 : 0;
  return (
    <g className="sh-bpic-words">
      {/* Each side's fees so far carry their coin under them, as the sheet and the ledger print an amount: never a count. */}
      {model.fees ? (['buyers', 'sellers'] as const).map((side) => (
        <text key={`unit-${side}`} x={visitor[side]} y="155" textAnchor="middle" className="sh-pic-muted sh-pic-small" fontSize="11.5" data-number={`fee-unit-${side}`}>{model.coin}</text>
      )) : null}
      {model.fees ? (
        <g data-key="">
          <circle cx="19" cy="19" r="6.5" className="sh-pic-coin__face" />
          <text x="31" y="23" className="sh-pic-muted sh-pic-small" fontSize="11">{W.feesIn(model.coin)}</text>
        </g>
      ) : null}
      {model.burned ? (
        <g transform={`translate(${r1(pillX)} 16)`} data-badge="burned">
          <rect width={r1(pillW)} height="21" rx="10.5" className="sh-bpic-pill" />
          <g transform="translate(4 2.4) scale(0.68)" className="sh-bpic-fire">{TEMPLATE_ICONS.burn.art}</g>
          <text x="22" y="15" className="sh-pic-number" fontSize="12" data-number="burned">{model.burned}</text>
        </g>
      ) : null}
      {model.holders !== null ? (
        // A round badge for a short count, a pill as wide as a long one (123,456 holders): its digits always inside it.
        <g data-badge="holders">
          <rect x={r1(holderX(model.holders) - badgeWidth(holderBadgeText(model.holders), 22, 7) / 2)} y="170" width={badgeWidth(holderBadgeText(model.holders), 22, 7)} height="22" rx="11" className="sh-bpic-badge" data-badge-shape="holders" />
          <text x={holderX(model.holders)} y="185.5" textAnchor="middle" className="sh-bpic-badge__text" fontSize="12" data-number="holders">{holderBadgeText(model.holders)}</text>
        </g>
      ) : null}
      {model.items?.out ? <text x={contents.x + 26} y={contents.y + 20} className="sh-pic-muted sh-pic-small" fontSize="11" data-number="out">{model.items.out}</text> : null}
      {model.pileCoin ? <text x={contents.x + 28} y={contents.y + 14} className="sh-pic-muted sh-pic-small" fontSize="11" data-number="pile-coin">{model.pileCoin}</text> : null}
      {model.poolOpen || !model.canGraduate ? null : (
        <g data-pool="closed">
          <text x="200" y={pool.y0 + 19} textAnchor="middle" className="sh-pic-muted sh-pic-small" fontSize="10.5">{W.opensAt}</text>
          <text x="200" y={pool.y0 + 32} textAnchor="middle" className="sh-pic-muted sh-pic-small" fontSize="10.5">{W.graduation}</text>
        </g>
      )}
      {/* Only a count every coin of which was read: a partial read is never said as final (round 3, D14). */}
      {inboxCount(model) !== null && (inboxCount(model) ?? 0) > 0 ? (
        <g data-badge="inbox">
          <rect x={r1(INBOX.x + 14 - badgeWidth(String(inboxCount(model)), 14, 6) / 2)} y={INBOX.y - 16} width={badgeWidth(String(inboxCount(model)), 14, 6)} height="14" rx="7" className="sh-bpic-badge" data-badge-shape="inbox" />
          <text x={INBOX.x + 14} y={INBOX.y - 5} textAnchor="middle" className="sh-bpic-badge__text" fontSize="10" data-number="inbox">{inboxCount(model)}</text>
        </g>
      ) : null}
    </g>
  );
}

function InboxControl({ model, open, onOpen, idPrefix }: { model: LiveModel; open: boolean; onOpen: () => void; idPrefix: string }) {
  const onKeyDown = (event: KeyboardEvent<SVGGElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onOpen();
  };
  // A partial or missing read draws the muted envelope and says no count (round 3, D14), as an unread one does.
  const coins = inboxCount(model) ?? 0;
  // A known royalty balance lights the envelope whatever the other coins' read (round 3b, G5 a); a partial read says
  // so in the Inbox card's own line, never a count (G5 b).
  const full = (model.inbox.royaltyHeld ?? 0n) > 0n || coins > 0;
  const partial = model.inbox.coins !== null && !model.inbox.complete;
  const description = partial ? W.someCoinsUnread : coins > 0 ? String(coins) : null;
  return (
    <g className={`sh-pic-part${open ? ' is-open' : ''}`} data-part="inbox" role="button" tabIndex={0} aria-label={W.inbox}
      aria-describedby={description ? `${idPrefix}-desc-inbox` : undefined} aria-haspopup="dialog" aria-expanded={open} onClick={onOpen} onKeyDown={onKeyDown}>
      {description ? <desc id={`${idPrefix}-desc-inbox`}>{description}</desc> : null}
      <Hits rects={[INBOX.hit]} />
      <g className={full ? 'sh-bpic-inbox' : 'sh-bpic-inbox sh-bpic-inbox--empty'}>
        <rect x={INBOX.x - 14} y={INBOX.y - 9} width="28" height="19" rx="3.5" />
        <path d={`M${INBOX.x - 12.5} ${INBOX.y - 7.5} L${INBOX.x} ${INBOX.y + 2} L${INBOX.x + 12.5} ${INBOX.y - 7.5}`} />
      </g>
      <text x={INBOX.x} y={INBOX.y + 25} textAnchor="middle" className="sh-pic-muted sh-pic-small" fontSize="11">{W.inbox}</text>
    </g>
  );
}

/** The layers for one box at one moment. */
export function liveLayers(model: LiveModel, idPrefix: string, inbox: { readonly open: boolean; readonly onOpen: () => void }): PictureLayers {
  return {
    ...(model.fees ? { visitor: model.visitor } : {}),
    front: <Front model={model} />,
    fill: <Fill model={model} idPrefix={idPrefix} />,
    routes: model.routes,
    poolOpen: model.poolOpen,
    words: <Words model={model} />,
    controls: <InboxControl model={model} open={inbox.open} onOpen={inbox.onOpen} idPrefix={idPrefix} />,
  };
}
