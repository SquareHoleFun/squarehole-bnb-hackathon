/**
 * SH-294: a launch's picture on its card. The link form is the launch page's (a copy of bounties/app/src/lib/pictures/
 * publish.ts `parsePictureLink`; the platform cannot import the launch app): `https://arweave.net/<id>#sha256=<hex>`
 * (or turbo-gateway.com, with or without `/raw/`). Anything else (another host, ipfs://, a JSON document, no hash) is no
 * picture. The bytes are read only the way the platform reads its own pictures (pictures/arweave-read.ts
 * `arweavePicture`: the site's two raw gateways, the withheld list before every request, a time box, raster only,
 * checked against the hash), from the link's item only (no search).
 */
export interface LaunchPictureRef { readonly id: string; readonly sha256: string }

export function parsePictureLink(link: string | null | undefined): LaunchPictureRef | null {
  if (typeof link !== 'string') return null;
  const m = /^https:\/\/(?:arweave\.net|turbo-gateway\.com)\/(?:raw\/)?([A-Za-z0-9_-]{43})#sha256=([0-9a-f]{64})$/.exec(link);
  return m && m[1] && m[2] ? { id: m[1], sha256: m[2] } : null;
}
