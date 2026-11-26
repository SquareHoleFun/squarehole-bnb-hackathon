/**
 * The link-preview tags of a box page (`/box/:chain/:address`): the SPA's own index.html with the box's title,
 * description, canonical URL and card picture as Open Graph and Twitter tags, so X, Telegram, Discord and iMessage show
 * the box. The picture is the card the card service draws on the droplet (api.squarehole.fun/card/..., F81 CF1), or the
 * generic one. Pure string work on our own index.html: every value from a box is escaped for an HTML attribute or text.
 */
import { CARD_HEIGHT, CARD_WIDTH, cardText, cardVersion, type ShareBox } from '@squarehole/cards';
import { boxPath, formatBoxId } from '../features/boxes/box-id';

export const SITE_NAME = 'Square Hole';

/** The landing page's card (apps/landing/public/art/card-1200x630.jpg, copied unchanged): the generic preview. */
export const GENERIC_CARD_PATH = '/share/square-hole-1200x630.jpg';
const GENERIC_DESCRIPTION = 'Different shapes. Same hole.';
/** The landing page's own words for its card (apps/landing/public/index.html). */
const GENERIC_ALT =
  'The Square Hole logo and the words “Different shapes. Same hole.” above a smiling lavender cube in the glowing square hole of a wooden toy box, with a heart and a star on either side.';

export interface ShareMeta {
  /** The document's <title>. */
  readonly title: string;
  readonly ogTitle: string;
  readonly description: string;
  /** Canonical URL (and og:url); null when the path names no box. */
  readonly url: string | null;
  readonly image: string;
  readonly imageType: 'image/png' | 'image/jpeg';
  readonly imageAlt: string;
}

/**
 * The card's path for a box on the card service: its version (design and state) in the query, so a new state is a new
 * picture for caches keyed on the URL.
 */
export function cardPath(box: ShareBox): string {
  const id = formatBoxId(box.chainId, box.token);
  return `/card${boxPath(id)}.png?v=${cardVersion(box.state)}`;
}

/**
 * A box's tags. `cardOrigin` is the card service's origin (https://api.squarehole.fun); null keeps the box's title and
 * description with the generic picture (no card service, or it does not answer; the Demo boxes).
 */
export function boxMeta(box: ShareBox, origin: string, cardOrigin: string | null): ShareMeta {
  const text = cardText(box);
  const named = text.ticker ? `${text.name} (${text.ticker})` : text.name;
  const where = `${text.chain} · ${text.address}`;
  // F130 (founder, 2026-10-11): no Demo word in a link preview either.
  const parts = [...(text.ticker ? [text.ticker] : []), text.state, where];
  return {
    title: `${named} · ${SITE_NAME}`,
    ogTitle: text.name,
    description: parts.join(' · '),
    url: `${origin}${boxPath(formatBoxId(box.chainId, box.token))}`,
    image: cardOrigin !== null ? `${cardOrigin}${cardPath(box)}` : `${origin}${GENERIC_CARD_PATH}`,
    imageType: cardOrigin !== null ? 'image/png' : 'image/jpeg',
    imageAlt: cardOrigin !== null ? `${named} on ${SITE_NAME}: ${text.state}. ${where}.` : GENERIC_ALT,
  };
}

/** The generic preview (the landing page's card), for a path that names no box this site can show. */
export function genericMeta(origin: string, canonicalPath: string | null): ShareMeta {
  return {
    title: SITE_NAME,
    ogTitle: SITE_NAME,
    description: GENERIC_DESCRIPTION,
    url: canonicalPath === null ? null : `${origin}${canonicalPath}`,
    image: `${origin}${GENERIC_CARD_PATH}`,
    imageType: 'image/jpeg',
    imageAlt: GENERIC_ALT,
  };
}

const ENTITIES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Text for an HTML attribute value or element content. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
}

/** Tags the page may already carry that this replaces (so a later default in index.html is never doubled). */
const REPLACED = [/<meta\s+(?:name|property)="(?:description|og:[^"]*|twitter:[^"]*)"[^>]*>\s*/gi, /<link\s+rel="canonical"[^>]*>\s*/gi];

export function metaTags(meta: ShareMeta): string {
  const tag = (attr: 'name' | 'property', key: string, value: string) => `<meta ${attr}="${key}" content="${escapeHtml(value)}" />`;
  const lines = [
    tag('name', 'description', meta.description),
    ...(meta.url === null ? [] : [`<link rel="canonical" href="${escapeHtml(meta.url)}" />`]),
    tag('property', 'og:type', 'website'),
    tag('property', 'og:site_name', SITE_NAME),
    tag('property', 'og:title', meta.ogTitle),
    tag('property', 'og:description', meta.description),
    ...(meta.url === null ? [] : [tag('property', 'og:url', meta.url)]),
    tag('property', 'og:image', meta.image),
    tag('property', 'og:image:type', meta.imageType),
    tag('property', 'og:image:width', String(CARD_WIDTH)),
    tag('property', 'og:image:height', String(CARD_HEIGHT)),
    tag('property', 'og:image:alt', meta.imageAlt),
    tag('name', 'twitter:card', 'summary_large_image'),
    tag('name', 'twitter:title', meta.ogTitle),
    tag('name', 'twitter:description', meta.description),
    tag('name', 'twitter:image', meta.image),
    tag('name', 'twitter:image:alt', meta.imageAlt),
  ];
  return lines.map((line) => `    ${line}\n`).join('');
}

/**
 * index.html with the preview tags: the <title> replaced, an existing description, canonical link and og/twitter tags
 * dropped, the new ones before </head>. A page without </head> is returned unchanged.
 */
export function injectMeta(html: string, meta: ShareMeta): string {
  const head = html.search(/<\/head>/i);
  if (head < 0) return html;
  let before = html.slice(0, head);
  for (const pattern of REPLACED) before = before.replace(pattern, '');
  const title = `<title>${escapeHtml(meta.title)}</title>`;
  // A function replacer: a name may hold `$&` or `$1`, which a replacement string would expand.
  before = /<title>[\s\S]*?<\/title>/i.test(before) ? before.replace(/<title>[\s\S]*?<\/title>/i, () => title) : `${before.trimEnd()}\n    ${title}\n`;
  return `${before.trimEnd()}\n${metaTags(meta)}  ${html.slice(head)}`;
}
