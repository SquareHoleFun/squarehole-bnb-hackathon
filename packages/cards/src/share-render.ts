/**
 * The 1200 x 630 card of one box, in the landing card's style (apps/landing/scripts/card.mjs): the brand kit's
 * horizontal lockup top left (mark and wordmark with the kit's proportions), the words in Plus Jakarta Sans on the
 * site's dark ground with the brand violet's glow, and the box's selected picture whole in a square on the right.
 * Without a drawable picture the brand mark itself stands there. The card has one dark theme.
 *
 * Drawn by satori (layout and text as paths) and resvg (SVG to PNG); both are passed in (engine.ts: resvg's native
 * build on the card service, its wasm build as the fallback and in the tests; the same resvg 2.6.2 either way). Nothing
 * here fetches anything.
 */
import { CARD_HEIGHT, CARD_WIDTH, cardText, type ShareBox, type ShareState } from './share-model';
import { logoFits, type Logo } from './share-art';
import { convertedPictureFits } from './converted-picture';

export interface CardAssets {
  /** Plus Jakarta Sans, latin, static weights 500 and 700 (WOFF: satori reads TTF, OTF and WOFF). */
  readonly regular: ArrayBuffer;
  readonly bold: ArrayBuffer;
  /** The brand kit's mark and wordmark (SVG text, unchanged). */
  readonly mark: string;
  readonly wordmark: string;
}

export interface CardFont {
  readonly name: string;
  readonly data: ArrayBuffer;
  readonly weight: 500 | 700;
  readonly style: 'normal';
}

export interface CardEngine {
  readonly webpDrawing?: boolean;
  decodeWebp?(picture: Logo): Promise<Logo | null>;
  close?(): Promise<void>;
  satori(element: CardNode, options: { readonly width: number; readonly height: number; readonly fonts: readonly CardFont[] }): Promise<string>;
  png(svg: string): Uint8Array;
  /** The real engine checks that resvg decodes the picture, including transparent pixels; test layout engines may omit this. */
  pictureDecodes?(picture: Logo): boolean;
}

/** A satori element: React's shape without React. */
export interface CardNode {
  readonly type: string;
  readonly props: { readonly style?: Readonly<Record<string, string | number>>; readonly children?: CardChild | readonly CardChild[]; readonly src?: string; readonly width?: number; readonly height?: number };
}
export type CardChild = CardNode | string;

const FONT = 'Plus Jakarta Sans';
const TEXT = '#f3f5fb';
const MUTED = '#899ab6';
const VIOLET = '#a78bfa';

/** The site's state colours (design tokens --sh-box-*). */
const STATE_COLOUR: Readonly<Record<ShareState['kind'], string>> = {
  upcoming: '#9fb3d6',
  open: VIOLET,
  graduating: '#67e8f9',
  graduated: '#62dca3',
  failed: '#ff8ca8',
};

const h = (type: string, style: Record<string, string | number>, children?: CardChild | readonly CardChild[]): CardNode => ({ type, props: { style, ...(children === undefined ? {} : { children }) } });
const img = (src: string, width: number, height: number, style: Record<string, string | number> = {}): CardNode => ({ type: 'img', props: { src, width, height, style: { width, height, ...style } } });

/** Base64 without Node's Buffer (runs anywhere). */
export function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
const svgUri = (svg: string): string => `data:image/svg+xml;base64,${base64(new TextEncoder().encode(svg))}`;

/** The mark's side in the lockup; the wordmark is placed from it as card.mjs does (the brand kit's proportions). */
const M = 56;
const WORDMARK = { width: 758.26, height: 128.46, cap: 100, ascent: 101.61 };

function lockup(assets: CardAssets): CardNode {
  const scale = (0.38 * M) / WORDMARK.cap;
  const left = 1.25 * M;
  const top = M / 2 + (0.38 * M) / 2 - WORDMARK.ascent * scale;
  return h('div', { display: 'flex', position: 'relative', width: left + WORDMARK.width * scale, height: M }, [
    img(svgUri(assets.mark), M, M, { position: 'absolute', left: 0, top: 0 }),
    img(svgUri(assets.wordmark), WORDMARK.width * scale, WORDMARK.height * scale, { position: 'absolute', left, top }),
  ]);
}

/** The left column (the words), left of the hole: nothing drawn in it reaches past its edges. */
export const COLUMN = { left: 72, top: 60, width: 590, height: 510 } as const;

/**
 * The name's size: by its length, so up to the spec's 32 bytes fit in two lines of the column, and by its longest
 * unbroken run, so one long word starts small. The spec needs no space (32 bytes of printable ASCII), so a run wider
 * than the column still breaks inside the word and the name stops at two lines with an ellipsis (`nameText`).
 */
export function nameSize(name: string): number {
  const length = Array.from(name).length;
  const run = Math.max(0, ...name.split(/[\s-]+/).map((word) => Array.from(word).length));
  const byLength = length <= 13 ? 76 : length <= 20 ? 64 : 52;
  const byRun = run <= 11 ? 76 : run <= 14 ? 64 : 52;
  return Math.min(byLength, byRun);
}

/**
 * Width the name's lines are laid out in: less than the column, because satori's two-line ellipsis can end up to about
 * 30 px past the width it was given (measured with 32 x "W", "%", "Q" or "w" at 52 px).
 */
export const NAME_WIDTH = COLUMN.width - 30;

/**
 * The name's text, at most two lines: satori breaks a word that does not fit on its own line (`break-word`) and
 * stops at two lines with an ellipsis (`lineClamp`, which satori applies to `display: block` only).
 */
export function nameText(name: string): CardNode {
  return h('div', { display: 'block', width: NAME_WIDTH, wordBreak: 'break-word', lineClamp: 2, fontSize: nameSize(name), fontWeight: 700, lineHeight: 1.06, letterSpacing: '-0.015em', color: TEXT }, name);
}

/**
 * The name in the column: anything past the column's width is clipped (a guard: `nameText` stays inside it), with room
 * below the last line for descenders, which a clip at the line box would cut ("Pegs"); the negative margin keeps the
 * layout as if that room were not there.
 */
function nameNode(name: string): CardNode {
  const below = Math.ceil(nameSize(name) * 0.3);
  return h('div', { display: 'flex', width: COLUMN.width, overflow: 'hidden', paddingBottom: below, marginBottom: -below }, nameText(name));
}

function chip(label: string, colour: string, ground: string, edge: string): CardNode {
  return h('div', { display: 'flex', padding: '6px 18px', borderRadius: 999, border: `2px solid ${edge}`, backgroundColor: ground, color: colour, fontSize: 28, fontWeight: 700, letterSpacing: '0.02em' }, label);
}

/** The square hole: a contained foreground on its blurred copy, as on the page. Only the backdrop is clipped. */
function hole(logo: Logo | null, assets: CardAssets): CardNode {
  const side = 380;
  const place = { position: 'absolute', left: 710, top: 125 } as const;
  if (logo === null) return img(svgUri(assets.mark), side, side, place);
  const inner = 268;
  return h(
    'div',
    {
      ...place,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: side,
      height: side,
      borderRadius: 86,
      border: '3px solid rgba(196, 178, 255, 0.55)',
      backgroundImage: 'linear-gradient(180deg, #1d2b46 0%, #0b111d 100%)',
    },
    h(
      'div',
      { display: 'flex', width: inner + 20, height: inner + 20, padding: 10, borderRadius: 24, backgroundColor: VIOLET, boxShadow: '0 0 40px 8px rgba(167, 139, 250, 0.7)' },
      h('div', { display: 'flex', position: 'relative', width: inner, height: inner }, [
        h('div', { display: 'flex', position: 'absolute', width: inner, height: inner, overflow: 'hidden', backgroundImage: 'radial-gradient(circle at 50% 40%, #22324f 0%, #111b2b 70%)' },
          img(`data:${logo.type};base64,${base64(logo.bytes)}`, inner + 96, inner + 96, { position: 'absolute', left: -48, top: -48, objectFit: 'cover', filter: 'blur(16px)' })),
        img(`data:${logo.type};base64,${base64(logo.bytes)}`, inner, inner, { position: 'absolute', left: 0, top: 0, objectFit: 'contain' }),
      ]),
    ),
  );
}

/** The glow behind the hole (its side in px), and the hole's echoes: faint rounded squares around it. */
const GLOW = 620;
const ECHOES: readonly (readonly [number, number])[] = [
  [470, 0.16],
  [560, 0.09],
];

/** The full address's size: 42 characters fit the column's width even in the widest digit ("0x000…", 572 px). */
const ADDRESS_SIZE = 19;

/** The left column: the lockup, the name, its chips and state, and at the foot the chain over the full address. */
export function textColumn(box: ShareBox, assets: CardAssets): CardNode {
  const text = cardText(box);
  const colour = STATE_COLOUR[box.state.kind];
  const chips: CardNode[] = [
    ...(text.ticker ? [chip(text.ticker, '#d9ccff', 'rgba(167, 139, 250, 0.14)', 'rgba(167, 139, 250, 0.45)')] : []),
    ...(text.demo ? [chip('Demo', '#ffd17a', '#2b2412', 'rgba(255, 209, 122, 0.5)')] : []),
  ];
  const state = h('div', { display: 'flex', flexDirection: 'column', marginTop: 34 }, [
    ...(text.stateLead ? [h('div', { display: 'flex', fontSize: 26, fontWeight: 500, color: MUTED, marginBottom: 4 }, text.stateLead)] : []),
    h('div', { display: 'flex', alignItems: 'center' }, [
      h('div', { display: 'flex', width: 16, height: 16, borderRadius: 8, backgroundColor: colour, marginRight: 14 }),
      h('div', { display: 'flex', fontSize: 36, fontWeight: 700, color: TEXT }, text.stateMain),
    ]),
  ]);
  return h('div', { position: 'absolute', left: COLUMN.left, top: COLUMN.top, width: COLUMN.width, height: COLUMN.height, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }, [
    lockup(assets),
    h('div', { display: 'flex', flexDirection: 'column' }, [nameNode(text.name), ...(chips.length > 0 ? [h('div', { display: 'flex', marginTop: 22, gap: 12 }, chips)] : []), state]),
    h('div', { display: 'flex', flexDirection: 'column' }, [
      h('div', { display: 'flex', fontSize: 26, fontWeight: 500, color: MUTED }, text.chain),
      h('div', { display: 'flex', fontSize: ADDRESS_SIZE, fontWeight: 500, color: MUTED, marginTop: 4 }, text.address),
    ]),
  ]);
}

/** The card's element tree (pure: the tests read its words). */
export function cardTree(box: ShareBox, logo: Logo | null, assets: CardAssets): CardNode {
  return h(
    'div',
    {
      display: 'flex',
      position: 'relative',
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      backgroundColor: '#0b0f1c',
      // A vertical tint (each row one colour: resvg's PNG of it is about 5 KB, a horizontal one about 80 KB) and one glow
      // behind the hole.
      backgroundImage: 'linear-gradient(180deg, #161335 0%, #0b0f1c 100%)',
      fontFamily: FONT,
      color: TEXT,
    },
    [
      h('div', { position: 'absolute', left: 900 - GLOW / 2, top: 315 - GLOW / 2, width: GLOW, height: GLOW, display: 'flex', backgroundImage: 'radial-gradient(circle, rgba(124, 92, 240, 0.42) 0%, rgba(124, 92, 240, 0.12) 45%, rgba(124, 92, 240, 0) 70%)' }),
      ...ECHOES.map(([side, alpha]) => h('div', { position: 'absolute', left: 900 - side / 2, top: 315 - side / 2, width: side, height: side, display: 'flex', borderRadius: side * 0.23, border: `2px solid rgba(167, 139, 250, ${alpha})` })),
      hole(logo, assets),
      textColumn(box, assets),
    ],
  );
}

/** Every string a card tree shows, in order (for tests and the evidence). */
export function treeText(node: CardChild): string[] {
  if (typeof node === 'string') return [node];
  const children = node.props.children;
  if (children === undefined) return [];
  return (Array.isArray(children) ? children : [children]).flatMap((child: CardChild) => treeText(child));
}

export function cardFonts(assets: CardAssets): readonly CardFont[] {
  return [
    { name: FONT, data: assets.regular, weight: 500, style: 'normal' },
    { name: FONT, data: assets.bold, weight: 700, style: 'normal' },
  ];
}

/**
 * The card as PNG bytes. A logo the renderer cannot draw falls back to the brand mark, and so does one whose decoded size
 * is unknown or too large (`logoFits`: resvg would decode it whole), whoever passes it. With `fallback` false the
 * refusal reaches the service, which stops at brand without changing the selected creator picture.
 */
export async function renderCardPng(box: ShareBox, given: Logo | null, assets: CardAssets, engine: CardEngine, fallback = true): Promise<Uint8Array> {
  const options = { width: CARD_WIDTH, height: CARD_HEIGHT, fonts: cardFonts(assets) };
  let logo = given !== null && (logoFits(given) || convertedPictureFits(given)) ? given : null;
  const hadPicture = logo !== null;
  if (given !== null && logo === null && !fallback) throw new Error('picture cannot be drawn');
  try {
    if (logo?.type === 'image/webp') {
      logo = await engine.decodeWebp?.(logo) ?? null;
      if (logo === null || logo.type !== 'image/png' || !(logoFits(logo) || convertedPictureFits(logo))) throw new Error('picture cannot be drawn');
    }
    if (logo !== null && engine.pictureDecodes?.(logo) === false) throw new Error('picture cannot be drawn');
    return engine.png(await engine.satori(cardTree(box, logo, assets), options));
  } catch (error) {
    if (!hadPicture || !fallback) throw error;
    return engine.png(await engine.satori(cardTree(box, null, assets), options));
  }
}
