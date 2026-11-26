/**
 * SH-288: a card's picture on the launch page, a small copy of the platform's rule for an item's picture
 * (apps/web set-pictures.ts, cut down to what this page may do: its content policy allows images from 'self' only).
 *
 * The card's own `tokenURI` is read once. Only inline JSON metadata is looked at (`data:application/json`, base64 or
 * percent-encoded, at most 64 KiB); its `image` must be `ipfs://<raw CID>` in the one canonical form the site's picture
 * route serves (`/ipfs/bafkrei…`, the same origin: the stack's guard checks the bytes and the withheld list there).
 * Anything else (a link elsewhere, another CID form, metadata behind a link, malformed JSON) is no picture: the card
 * keeps its empty tile and works without it.
 */

/** The site's raw CID form (hackathon/stack/Caddyfile `@ipfs_art`): a CIDv1, raw codec, sha2-256, base32. */
export const RAW_CID = /^bafkrei[a-h][a-z2-7]{50}[aeimquy4]$/;

/** The most metadata characters decoded. */
export const MAX_METADATA_CHARS = 64 * 1024;

const BASE64 = /^data:application\/json;base64,([A-Za-z0-9+/=\s]*)$/i;
const PLAIN = /^data:application\/json(?:;charset=utf-8|;utf8)?,(.*)$/is;

function decodeBase64(text: string): string | null {
  const clean = text.replace(/\s+/g, '');
  if (clean.length > Math.ceil(MAX_METADATA_CHARS / 3) * 4 + 4) return null;
  try {
    const binary = atob(clean);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The metadata JSON a tokenURI holds inline, or null. */
export function inlineMetadata(tokenUri: string): unknown {
  if (typeof tokenUri !== 'string' || tokenUri.length > MAX_METADATA_CHARS * 2) return null;
  let text: string | null = null;
  const b = BASE64.exec(tokenUri);
  if (b) text = decodeBase64(b[1] ?? '');
  else {
    const p = PLAIN.exec(tokenUri);
    if (p) {
      try {
        text = decodeURIComponent(p[1] ?? '');
      } catch {
        text = null;
      }
    }
  }
  if (text === null || text.length > MAX_METADATA_CHARS) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** The picture's address on this site (`/ipfs/<raw CID>`) from a card's tokenURI, or null for no picture. */
export function pictureAddressOf(tokenUri: string): string | null {
  const meta = inlineMetadata(tokenUri);
  if (typeof meta !== 'object' || meta === null) return null;
  const image = (meta as { image?: unknown }).image;
  if (typeof image !== 'string') return null;
  const m = /^ipfs:\/\/([a-z0-9]+)$/.exec(image.trim());
  const cid = m?.[1];
  return cid && RAW_CID.test(cid) ? `/ipfs/${cid}` : null;
}

/** A card's name from its metadata ("Paper Boat"), or null. Shown only as a title: the card's number names it. */
export function cardNameOf(tokenUri: string): string | null {
  const meta = inlineMetadata(tokenUri);
  const name = typeof meta === 'object' && meta !== null ? (meta as { name?: unknown }).name : undefined;
  return typeof name === 'string' && name.trim() !== '' && name.length <= 80 ? name.trim() : null;
}

/**
 * The names cards show: each collection's own name, less the leading words every listed name shares, where the names
 * differ ("Test Trading Cards Common" and "... Rare" read "Common" and "Rare"); one name, or equal names, stay whole; a
 * collection without a name: its short address. (The platform's shortNamesV2, copied.)
 */
export function shortNames(collections: readonly { readonly address: string; readonly name: string | null }[]): Map<string, string> {
  const named = collections.filter((c): c is { address: string; name: string } => typeof c.name === 'string' && c.name.trim() !== '');
  const words = named.map((c) => c.name.trim().split(/\s+/));
  let shared = 0;
  if (new Set(named.map((c) => c.name.trim())).size > 1) {
    const first = words[0] ?? [];
    while (shared < first.length && words.every((w) => w.length > shared + 1 && w[shared] === first[shared])) shared += 1;
  }
  const out = new Map<string, string>();
  for (const c of collections) {
    const name = typeof c.name === 'string' && c.name.trim() !== '' ? c.name.trim().split(/\s+/).slice(shared).join(' ') : `${c.address.slice(0, 6)}…${c.address.slice(-4)}`;
    out.set(c.address.toLowerCase(), name);
  }
  return out;
}
