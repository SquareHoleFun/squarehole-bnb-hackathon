/**
 * The card service's configuration, from its environment (infra/server/compose.yaml and cards.env on the droplet).
 * Everything is optional except where noted; nothing here is a secret (keyless RPCs, public gateways).
 *
 *   SH_CARDS_HOST, SH_CARDS_PORT     where it listens (default 127.0.0.1:5395; 0.0.0.0 inside the container)
 *   SH_CARDS_INDEXER_ORIGIN          the indexer gateway (http or https origin; `none`: the chain only)
 *   SH_CARDS_MANIFEST                the Sepolia core manifest file (re-read when it changes; none: no box is known)
 *   SH_CARDS_RPC_URLS                keyless https RPCs for the chain fallback (default: the chain package's list)
 *   SH_CARDS_ART_GATEWAYS            IPFS gateway origins for logos, comma-separated, at most 4 (default none)
 *   SH_CARDS_ITEM_PNG_MANIFEST       private JSON file: committed image hash -> PNG copy hash (read at startup)
 *   SH_CARDS_CACHE_DIR               a folder for finished cards (default none: memory only)
 *   SH_CARDS_ENGINE                  `native` (default; wasm when the native build does not load) or `wasm`
 *   SH_CARDS_GENERIC, SH_CARDS_ASSETS  the generic card (a JPEG) and the fonts/brand folder (defaults: this repository's)
 *   SH_CARDS_LOCAL_MANIFEST, SH_CARDS_LOCAL_RPC_URL  local testing against a local twin only; never on the server
 */
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGateways } from '../share-art';
import { originOf, rpcUrlsOf } from '../origin';
import { CARD_ASSETS_DIR, type EngineKind } from '../engine';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The landing page's card, the generic preview the site serves too (apps/web/public/share/). */
export const DEFAULT_GENERIC = resolve(HERE, '../../../../apps/web/public/share/square-hole-1200x630.jpg');

export interface ServiceConfig {
  readonly host: string;
  readonly port: number;
  readonly indexerOrigin: string | null;
  readonly manifestPath: string | null;
  readonly localManifestPath: string | null;
  readonly localRpcUrl: string | null;
  readonly rpcUrls: readonly string[];
  readonly artGateways: readonly string[];
  readonly cacheDir: string | null;
  readonly genericPath: string;
  readonly assetsDir: string;
  readonly engine: EngineKind;
  readonly itemPngManifestPath: string | null;
}

type Env = Readonly<Record<string, string | undefined>>;

const value = (env: Env, name: string): string | undefined => {
  const raw = env[name]?.trim();
  return raw === undefined || raw === '' ? undefined : raw;
};

/** An http(s) origin set by the operator (the indexer inside the compose network is plain http), or null for `none`. */
export function serviceOrigin(raw: string | undefined): string | null {
  if (raw === undefined || raw === 'none') return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`not an origin: ${raw}`);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error(`not a plain http(s) origin: ${raw}`);
  }
  return url.origin;
}

const path = (raw: string | undefined): string | null => (raw === undefined ? null : isAbsolute(raw) ? raw : resolve(raw));

/** The configuration, or throws naming the setting that is wrong (the service then does not start). */
export function serviceConfig(env: Env): ServiceConfig {
  const portRaw = value(env, 'SH_CARDS_PORT') ?? '5395';
  const port = Number(portRaw);
  if (!/^[0-9]{1,5}$/.test(portRaw) || port < 1 || port > 65_535) throw new Error(`SH_CARDS_PORT: not a port: ${portRaw}`);
  const engine = value(env, 'SH_CARDS_ENGINE') ?? 'native';
  if (engine !== 'native' && engine !== 'wasm') throw new Error(`SH_CARDS_ENGINE: native or wasm, not ${engine}`);
  const gatewaysRaw = value(env, 'SH_CARDS_ART_GATEWAYS');
  const artGateways = parseGateways(gatewaysRaw);
  if (gatewaysRaw !== undefined && artGateways.length !== gatewaysRaw.split(',').filter((g) => g.trim() !== '').length) {
    throw new Error('SH_CARDS_ART_GATEWAYS: https origins only (at most 4), no path, query or credentials');
  }
  const localRpcRaw = value(env, 'SH_CARDS_LOCAL_RPC_URL');
  const localRpcUrl = originOf(localRpcRaw);
  if (localRpcRaw !== undefined && localRpcUrl === null) throw new Error('SH_CARDS_LOCAL_RPC_URL: an http origin on loopback, or https');
  return {
    host: value(env, 'SH_CARDS_HOST') ?? '127.0.0.1',
    port,
    indexerOrigin: serviceOrigin(value(env, 'SH_CARDS_INDEXER_ORIGIN')),
    manifestPath: path(value(env, 'SH_CARDS_MANIFEST')),
    localManifestPath: path(value(env, 'SH_CARDS_LOCAL_MANIFEST')),
    localRpcUrl,
    rpcUrls: rpcUrlsOf(value(env, 'SH_CARDS_RPC_URLS')),
    artGateways,
    cacheDir: path(value(env, 'SH_CARDS_CACHE_DIR')),
    genericPath: path(value(env, 'SH_CARDS_GENERIC')) ?? DEFAULT_GENERIC,
    assetsDir: path(value(env, 'SH_CARDS_ASSETS')) ?? CARD_ASSETS_DIR,
    engine,
    itemPngManifestPath: path(value(env, 'SH_CARDS_ITEM_PNG_MANIFEST')),
  };
}


/** Runtime JSON object keyed by committed image digest. Only the reveal-gated service may use it. */
export function itemPngsOf(raw: string | undefined): Readonly<Record<string, `0x${string}`>> {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const out: Record<string, `0x${string}`> = {};
    for (const [image, png] of Object.entries(value)) {
      if (!/^0x[0-9a-f]{64}$/.test(image) || typeof png !== 'string' || !/^0x[0-9a-f]{64}$/.test(png) || /^0x0{64}$/.test(image) || /^0x0{64}$/.test(png)) throw new Error();
      out[image] = png as `0x${string}`;
    }
    return Object.freeze(out);
  } catch { throw new Error('SH_CARDS_ITEM_PNG_MANIFEST must map image sha256 to PNG sha256'); }
}
