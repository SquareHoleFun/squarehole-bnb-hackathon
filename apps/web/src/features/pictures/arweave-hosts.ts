/**
 * SH-ARWEAVE-PICTURES-WEB (founder 2026-10-24): the hosts a v2 box's logo and cover use. The creator's browser publishes
 * them to Arweave through ArDrive Turbo's free tier, and every visitor's browser finds and reads them on the Arweave
 * gateways; no server of ours stores, hosts or relays a picture. The site's connect-src adds exactly
 * `PICTURE_ORIGINS` (share/share-headers.ts `SITE_CSP_ORIGINS.pictures`, infra/server/app/config.mjs); img-src gains
 * nothing, because the bytes are checked against their hash and drawn from a blob: URL.
 */

/** Turbo's upload service (`GET /info` for the free size, `POST /v1/tx` for a signed data item). */
export const TURBO_UPLOAD_ORIGIN = 'https://upload.ardrive.io';
/** Where an item's bytes are read (`/raw/<id>`: no sandbox redirect), in turn: Turbo's own gateway serves new items at once. */
export const ARWEAVE_RAW_GATEWAYS: readonly string[] = Object.freeze(['https://turbo-gateway.com', 'https://arweave.net']);
/** Where items are searched by their tags (Arweave GraphQL), all three at once. */
export const ARWEAVE_SEARCH_GATEWAYS: readonly string[] = Object.freeze(['https://turbo-gateway.com', 'https://arweave.net', 'https://goldsky.arweave.net']);
/** Every origin above, once: the connect-src additions. */
export const PICTURE_ORIGINS: readonly string[] = Object.freeze([TURBO_UPLOAD_ORIGIN, ...new Set([...ARWEAVE_RAW_GATEWAYS, ...ARWEAVE_SEARCH_GATEWAYS])]);

/** The App-Name tag every published picture carries (the search's first tag; the second is its SHA-256). */
export const APP_NAME = 'Square Hole';
/** Turbo's free item size on 2026-10-24 (`GET /info` `freeUploadLimitBytes`), used while `/info` cannot be read. */
export const TURBO_FREE_BYTES = 107_520;
/**
 * The largest box picture the site makes or reads from Arweave: Turbo's free size today plus a margin. Create never
 * shrinks a picture above it (even if Turbo raised its free size) and the reader never downloads more than it.
 */
export const MAX_PICTURE_BYTES = 128 * 1024;
