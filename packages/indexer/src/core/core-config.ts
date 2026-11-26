/**
 * The core v1 service's configuration (S10a), from the environment. The manifest is the only source of contract
 * identities (`SH_CORE_MANIFEST`, a `squarehole.core-deployment/v1` file): an `awaiting-broadcast` manifest is refused
 * ("Core v1 is not on Sepolia yet: nothing to index", `CoreNotDeployedError`), never filled in; the service then idles
 * on the gateway's address until the file names a deployment (idle.ts).
 *
 *   SH_CORE_MANIFEST         path to the core manifest (required)
 *   SH_CORE_HTTP_URLS        keyless RPC URLs, comma-separated (default: the test network profile's public list for the
 *                            manifest's chain, Sepolia or BNB Chain testnet; required on a local chain)
 *   SH_CORE_WS_URLS          websocket head feeds (default none: polling)
 *   SH_CORE_GATEWAY_PORT     default 5394; SH_CORE_GATEWAY_HOST default 127.0.0.1
 *   SH_CORE_POLL_MS          head poll interval (default 1000)
 *   SH_CORE_BLOCK_MS         the chain's block time in milliseconds (default: the profile's for the manifest's chain,
 *                            BNB Chain testnet 450, otherwise 12000); under 2000 the catch-up takes the fast pace
 *                            (chain-indexer.ts CorePace, SH-259)
 *   SH_STORE                 memory (the core path keeps its hot state in process; Redis is S10b's)
 *   SH_HISTORY               off (default) | memory | postgres; SH_HISTORY_PG_HOST (a socket directory or host),
 *                            SH_HISTORY_PG_PORT, SH_HISTORY_PG_DATABASE, SH_HISTORY_PG_USER
 *   SH_CORE_ART_GATEWAYS     IPFS gateway origins, comma-separated, box 0's item picture route asks by raw CID
 *                            (art.ts; only bytes matching the commitment are served); default none. No picture decides
 *                            a listing (SH-NO-PICTURE-GATE)
 *   SH_CORE_ART_DIR          where checked item pictures are kept for good (default: in memory)
 *   SH_CORE_CREATE_OPTIONS_DIR absolute existing folder of Create lists (unset/empty: packaged data)
 *   SH_CORE_MANIFEST_POLL_MS while the manifest awaits the broadcast, how often it is read again (default 15000)
 *   SH_CORE_MAX_STREAMS_PER_CLIENT  open SSE streams per client (an IPv4 address or an IPv6 /64; default 8)
 *   SH_CORE_TRUSTED_PROXIES  addresses or CIDRs, comma-separated, whose last X-Forwarded-For entry names the client (the
 *                            proxy in front; default none: the peer is the client)
 */
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseCoreManifest, SEPOLIA_PUBLIC_RPC_URLS, testnetProfileOfChain, type CoreManifest, type DeployedCoreManifest } from '@squarehole/chain';
import { z } from 'zod';
import { parseSetManifest, type SetReleaseManifest } from '@squarehole/chain/core/set-v2';
import { parseCoreManifestV2, type DeployedCoreManifestV2 } from './v2/chain-v2';
import { trustedProxyList } from './client-key';
import { paceForBlockTime, type CorePace } from './chain-indexer';
import { CREATE_OPTIONS_DATA } from './create-options';

/** Resolve once at startup, before even the awaiting-manifest listener. A configured folder never falls back. */
export function createOptionsDirectoryOf(env: Record<string, string | undefined> = process.env): URL {
  const directory = env.SH_CORE_CREATE_OPTIONS_DIR;
  if (directory === undefined || directory === '') return CREATE_OPTIONS_DATA;
  if (!isAbsolute(directory)) throw new Error('SH_CORE_CREATE_OPTIONS_DIR must be an absolute path to an existing folder');
  try {
    if (!statSync(directory).isDirectory()) throw new Error('not a folder');
  } catch (cause) {
    throw new Error('SH_CORE_CREATE_OPTIONS_DIR must name an existing folder', { cause });
  }
  return pathToFileURL(directory.endsWith(sep) ? directory : `${directory}${sep}`);
}

/** Ports this repo must never take: other projects, the founder's preview, the e2e builds, other workflows' anvils. */
const FORBIDDEN_PORTS = new Set([4173, 4174, 4175, 5173, 5391, 5392, 5396, 5397, 8547, 8548, 8549]);

const csv = z.string().transform((value) => value.split(',').map((item) => item.trim()).filter(Boolean));
const port = z.coerce
  .number()
  .int()
  .min(1024)
  .max(65_535)
  .refine((value) => !FORBIDDEN_PORTS.has(value), 'port is reserved by another project');

const envSchema = z.object({
  SH_CORE_MANIFEST: z.string().min(1),
  SH_SET_MANIFEST: z.string().min(1).optional(),
  SH_CORE_HTTP_URLS: csv.optional(),
  SH_CORE_WS_URLS: csv.optional(),
  SH_CORE_GATEWAY_PORT: port.default(5394),
  SH_CORE_GATEWAY_HOST: z.string().default('127.0.0.1'),
  SH_CORE_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  SH_CORE_BLOCK_MS: z.coerce.number().int().min(100).max(600_000).optional(),
  SH_STORE: z.enum(['memory']).default('memory'),
  SH_HISTORY: z.enum(['off', 'memory', 'postgres']).default('off'),
  SH_HISTORY_PG_HOST: z.string().optional(),
  SH_HISTORY_PG_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  SH_HISTORY_PG_DATABASE: z.string().default('squarehole_history'),
  SH_HISTORY_PG_USER: z.string().optional(),
  SH_CORE_ART_GATEWAYS: csv.optional(),
  SH_CORE_ART_DIR: z.string().min(1).optional(),
  SH_CORE_MANIFEST_POLL_MS: z.coerce.number().int().min(1_000).max(600_000).default(15_000),
  SH_CORE_MAX_STREAMS_PER_CLIENT: z.coerce.number().int().min(1).max(2_000).default(8),
  SH_CORE_TRUSTED_PROXIES: csv.optional(),
});

/** The manifest names no deployment yet (`awaiting-broadcast`): nothing to index; the service idles (idle.ts). */
export class CoreNotDeployedError extends Error {
  constructor(
    readonly chainId: number,
    readonly network: CoreManifest['network'],
  ) {
    super(`Core v1 is not on ${network === 'sepolia' ? 'Sepolia' : network === 'mainnet' ? 'Ethereum mainnet' : 'this chain'} yet (the manifest is awaiting the broadcast): nothing to index`);
    this.name = 'CoreNotDeployedError';
  }
}

/** Where the gateway listens and how often an awaiting manifest is read again (the environment checked as a whole). */
export function idleOptionsOf(env: Record<string, string | undefined> = process.env): { readonly port: number; readonly host: string; readonly manifestPollMs: number } {
  const parsed = envSchema.parse(env);
  return { port: parsed.SH_CORE_GATEWAY_PORT, host: parsed.SH_CORE_GATEWAY_HOST, manifestPollMs: parsed.SH_CORE_MANIFEST_POLL_MS };
}

export interface CoreServiceConfig {
  readonly setManifest?: SetReleaseManifest;
  readonly manifest: DeployedCoreManifest | DeployedCoreManifestV2;
  readonly httpUrls: readonly string[];
  readonly wsUrls: readonly string[];
  readonly port: number;
  readonly host: string;
  readonly pollMs: number;
  /** The catch-up pace for the chain's block time (SH_CORE_BLOCK_MS); absent: the 12-second pace. */
  readonly pace?: CorePace;
  readonly history: 'off' | 'memory' | 'postgres';
  readonly pg: { readonly host: string | undefined; readonly port: number | undefined; readonly database: string; readonly user: string | undefined };
  /** The item picture route: gateway origins (none: no item pictures) and the folder checked bytes are kept in. */
  readonly art: { readonly gateways: readonly string[]; readonly dir: string | null };
  /** Open SSE streams per client, and the proxies whose X-Forwarded-For names the client. */
  readonly maxStreamsPerClient: number;
  readonly trustedProxies: readonly string[];
}

export function loadCoreConfig(env: Record<string, string | undefined> = process.env, read: (path: string) => string = (path) => readFileSync(path, 'utf8')): CoreServiceConfig {
  const parsed = envSchema.parse(env);
  const input: unknown = JSON.parse(read(parsed.SH_CORE_MANIFEST));
  const manifest = input !== null && typeof input === 'object' && 'releases' in input ? parseCoreManifestV2(input) : parseCoreManifest(input);
  if (manifest.status !== 'deployed') throw new CoreNotDeployedError(manifest.chainId, manifest.network);
  // The profile of the manifest's chain, whichever test network this build follows (SH_TESTNET), never a local chain.
  const profile = manifest.network === 'local' ? null : testnetProfileOfChain(manifest.chainId);
  const httpUrls = parsed.SH_CORE_HTTP_URLS ?? (profile ? [...profile.publicRpcUrls] : manifest.network === 'sepolia' ? [...SEPOLIA_PUBLIC_RPC_URLS] : []);
  if (httpUrls.length === 0) throw new Error(`SH_CORE_HTTP_URLS is required for ${manifest.network === 'mainnet' ? 'mainnet (no default RPC)' : 'a local chain'}`);
  for (const url of httpUrls) {
    const u = new URL(url);
    if (u.username || u.password || u.search) throw new Error('RPC URLs must be keyless (no credentials or query string)');
  }
  const trustedProxies = parsed.SH_CORE_TRUSTED_PROXIES ?? [];
  trustedProxyList(trustedProxies); // throws on an entry that is not an address or CIDR
  const artGateways = parsed.SH_CORE_ART_GATEWAYS ?? [];
  for (const url of artGateways) {
    const u = new URL(url);
    if (u.username || u.password || u.search || (u.protocol !== 'https:' && u.protocol !== 'http:')) throw new Error('art gateways must be plain http(s) origins without credentials');
  }
  return {
    manifest,
    ...(parsed.SH_SET_MANIFEST ? {setManifest: parseSetManifest(JSON.parse(read(parsed.SH_SET_MANIFEST)), input)} : {}),
    httpUrls,
    wsUrls: parsed.SH_CORE_WS_URLS ?? [],
    port: parsed.SH_CORE_GATEWAY_PORT,
    host: parsed.SH_CORE_GATEWAY_HOST,
    pollMs: parsed.SH_CORE_POLL_MS,
    pace: paceForBlockTime(parsed.SH_CORE_BLOCK_MS ?? profile?.blockTimeMs ?? 12_000),
    history: parsed.SH_HISTORY,
    pg: { host: parsed.SH_HISTORY_PG_HOST, port: parsed.SH_HISTORY_PG_PORT, database: parsed.SH_HISTORY_PG_DATABASE, user: parsed.SH_HISTORY_PG_USER },
    art: { gateways: artGateways, dir: parsed.SH_CORE_ART_DIR ?? null },
    maxStreamsPerClient: parsed.SH_CORE_MAX_STREAMS_PER_CLIENT,
    trustedProxies,
  };
}
