/**
 * Site links (F70 step 1; box creation flow § 4.1): Website, X and Telegram are site metadata, never in the spec.
 * Checked when typed and again before a link is drawn (storage is untrusted): Website `https://` with a host, up to 200
 * characters; X an @handle or an `https://x.com/<handle>` link; Telegram a `https://t.me/<name>` link. A link is
 * shown as plain text plus an anchor with `rel="noopener noreferrer"`, never fetched.
 *
 * The collection page's link (add-on 6, field 603) is the one fixed link: the spec's URL rule (RFC 3986 characters,
 * `https://` first, at most 128 bytes), checked with the spec's own `checkString`.
 */
import { RULE_PREFIXES, RULE_RANGES, Reason, checkString } from '@squarehole/box-spec';
import type { SiteLinks } from './box-model';

export type LinkKey = keyof SiteLinks;
export type LinkProblem = 'website' | 'x' | 'telegram' | 'too-long';

export const MAX_SITE_LINK_CHARS = 200;
/** add-on 6's externalLink: at most 128 bytes (add-ons.v1.json). */
export const MAX_PAGE_LINK_BYTES = 128;

const HOST = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+';
const PATH = "(?:[/?#][A-Za-z0-9\\-._~:/?#\\[\\]@!$&'()*+,;=%]*)?";
const WEBSITE = new RegExp(`^https://${HOST}${PATH}$`);
const X_LINK = /^https:\/\/(?:www\.)?x\.com\/[A-Za-z0-9_]{1,15}\/?$/;
const X_HANDLE = /^@[A-Za-z0-9_]{1,15}$/;
const TELEGRAM = /^https:\/\/t\.me\/[A-Za-z0-9_]{4,32}\/?$/;

/** Why a typed link cannot be used, or null (empty is fine: every link is optional). */
export function linkProblem(key: LinkKey, text: string): LinkProblem | null {
  const value = text.trim();
  if (value === '') return null;
  if (value.length > MAX_SITE_LINK_CHARS) return 'too-long';
  if (key === 'website') return WEBSITE.test(value) ? null : 'website';
  if (key === 'x') return X_LINK.test(value) || X_HANDLE.test(value) ? null : 'x';
  return TELEGRAM.test(value) ? null : 'telegram';
}

/** The links as kept: trimmed, each one usable (a link with a problem is not kept). */
export function cleanLinks(links: SiteLinks): SiteLinks {
  const keep = (key: LinkKey) => (linkProblem(key, links[key]) === null ? links[key].trim() : '');
  return Object.freeze({ website: keep('website'), x: keep('x'), telegram: keep('telegram') });
}

/** A link to draw: its href (an X handle becomes its x.com page) and its text; null when it is empty or not usable. */
export function linkHref(key: LinkKey, text: string): { readonly href: string; readonly text: string } | null {
  const value = text.trim();
  if (value === '' || linkProblem(key, value) !== null) return null;
  if (key === 'x' && X_HANDLE.test(value)) return { href: `https://x.com/${value.slice(1)}`, text: value };
  return { href: value, text: value.replace(/^https:\/\//, '') };
}

/** How many links are set (the Overview's "2 links"). */
export const linkCount = (links: SiteLinks): number => (['website', 'x', 'telegram'] as const).filter((key) => links[key].trim() !== '').length;

/** The spec's URL rule for the collection page's link (field 603): a Reason (OK for empty). */
export function pageLinkReason(text: string): number {
  return checkString(new TextEncoder().encode(text), 0, MAX_PAGE_LINK_BYTES, RULE_RANGES.URL, RULE_PREFIXES.URL);
}

export const pageLinkOk = (text: string): boolean => pageLinkReason(text) === Reason.OK;
