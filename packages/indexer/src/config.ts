/**
 * What the service follows and how it runs. Two Sepolia pools, chosen with `SH_POOL_TARGET` (default `sepolia-full`):
 *
 * - `sepolia-full`: the whole v2 system on Sepolia (docs/v2/sepolia-full.md), broadcast by the founder on 2026-09-30
 *   with the neutral build (`FOUNDRY_PROFILE=sepolia-neutral`): token "Rehearsal Token 2" (RHT2) on the Misfits launch
 *   curve (`FitLaunchShape` since F40 L6), genesis `MisfitsGenesis` in block 11,817,793, open block 11,818,093 (the
 *   genesis block + 300), window to 11,818,124. Addresses and blocks as checked on chain in
 *   docs/evidence/SH-V2-sepolia-full.md Part A (A1, A2, A6); the tests recompute every contract address from the
 *   genesis (CREATE at its nonces) and the pool id from the pool key.
 * - `sepolia-rehearsal`: the route rehearsal of 2026-09-30 (docs/v2/sepolia-rehearsal.md; token "Rehearsal Token",
 *   RHT, on the rehearsal curve): addresses read from the genesis getters, deploy block 11,811,774, open 11,812,074.
 *
 * Neither deployment has a squarehole deployment manifest, so the targets live here; the web app's FIT market record
 * for the full deployment (apps/web/fit-markets/fit-market-11155111.json) must name the same pool (a test compares
 * them). A pool keeps its curve shape for good, so each target carries its own.
 */
import { SEPOLIA_CHAIN_ID, SEPOLIA_PUBLIC_RPC_URLS, SEPOLIA_UNISWAP_V4 } from '@squarehole/chain';
import type { Address, Hex } from 'viem';
import { z } from 'zod';
import { MISFITS_CURVE, REHEARSAL_CURVE, type CurveShape } from './curve';
import type { DecodeTarget } from './events';
import { BAND_TARGET_WEI, MISFITS_LAUNCH_SHAPE, REHEARSAL_SHAPE } from './shape';

export const POOL_TARGET_IDS = Object.freeze(['sepolia-full', 'sepolia-rehearsal'] as const);
export type PoolTargetId = (typeof POOL_TARGET_IDS)[number];
export const DEFAULT_POOL_TARGET: PoolTargetId = 'sepolia-full';

export interface PoolTarget extends DecodeTarget {
  readonly id: PoolTargetId;
  readonly chainId: number;
  readonly label: string;
  readonly tokenSymbol: string;
  readonly deployBlock: bigint;
  readonly openBlock: bigint;
  readonly closeBlock: bigint;
  readonly targetWei: bigint;
  readonly issuance: bigint;
  /** The curve the pool was deployed with: every state, trade and the `/curve` endpoint are computed on it. */
  readonly curve: CurveShape;
}

export const SEPOLIA_REHEARSAL: PoolTarget = Object.freeze({
  id: 'sepolia-rehearsal',
  chainId: SEPOLIA_CHAIN_ID,
  label: 'Sepolia route rehearsal (RHT, placeholder names)',
  tokenSymbol: 'RHT',
  poolId: '0x6b31fc7cc51d9f7d16ec3f262fddb6e441ef96b1df63cc8d3c6bcf8ff1b1af5e' as Hex,
  poolManager: SEPOLIA_UNISWAP_V4.poolManager,
  genesis: '0xf861841794D299244E9521Bc2e8D2df8e7578B95' as Address,
  token: '0x2D9fB39AA944E8ba72285D6777AaDC1cE3b2BE01' as Address,
  hook: '0x63C05f75bc9Fe742263dc7d01FF311038e196AE0' as Address,
  collector: '0xDAc96e853DCecc45cB26e436576285A5A2ff2260' as Address,
  executor: '0x820Ce67786a8BA81576CD3ba4d0F7Bac9A41c952' as Address,
  launchRouter: '0xeD55EbBB1D266D0EAD2370eF9ac8e768D13BC3af' as Address,
  deployBlock: 11_811_774n,
  openBlock: 11_812_074n,
  closeBlock: 11_812_074n + BigInt(REHEARSAL_SHAPE.windowBlocks),
  targetWei: BAND_TARGET_WEI,
  issuance: REHEARSAL_SHAPE.issuance,
  curve: REHEARSAL_CURVE,
});

/** The genesis block of the full deployment (transaction 8, `MisfitsGenesis`). */
const FULL_GENESIS_BLOCK = 11_817_793n;
/** The open delay it was deployed with (`SH_SEPOLIA_OPEN_DELAY` default; `LaunchWindowAnnounced` and `openBlock()`). */
const FULL_OPEN_DELAY = 300n;

export const SEPOLIA_FULL: PoolTarget = Object.freeze({
  id: 'sepolia-full',
  chainId: SEPOLIA_CHAIN_ID,
  label: 'Sepolia full v2 deployment (RHT2, neutral names)',
  tokenSymbol: 'RHT2',
  poolId: '0x0d801f3742d418d5edb138064daac2d6a37cdf94ab5c8b75346f8d2241b6dda3' as Hex,
  poolManager: SEPOLIA_UNISWAP_V4.poolManager,
  genesis: '0x26d6e5De7f5F8803EB40d3b9c4CCaF565279e108' as Address,
  token: '0x07cB5710D589c9763192E76694FCd3E8F5a0B353' as Address,
  hook: '0x4769303f055c44F82975b77096EC6F07C30E6Ae0' as Address,
  collector: '0xc80043F3e50836A8274f876ECFBb8E165a0eA354' as Address,
  executor: '0xfe0D753C01d5330e4D17775643D83FF3280a8aa6' as Address,
  launchRouter: '0x2bB3Af7197a9308d3F0ED32ff7945d47661B30eB' as Address,
  deployBlock: FULL_GENESIS_BLOCK,
  openBlock: FULL_GENESIS_BLOCK + FULL_OPEN_DELAY,
  closeBlock: FULL_GENESIS_BLOCK + FULL_OPEN_DELAY + BigInt(MISFITS_LAUNCH_SHAPE.windowBlocks),
  targetWei: BAND_TARGET_WEI,
  issuance: MISFITS_LAUNCH_SHAPE.issuance,
  curve: MISFITS_CURVE,
});

export const POOL_TARGETS: Readonly<Record<PoolTargetId, PoolTarget>> = Object.freeze({
  'sepolia-full': SEPOLIA_FULL,
  'sepolia-rehearsal': SEPOLIA_REHEARSAL,
});

/** `SH_POOL_TARGET`: unset or empty means the default; anything but a known id is refused. */
const poolTargetId = z.preprocess((value) => (value === '' ? undefined : value), z.enum(POOL_TARGET_IDS).default(DEFAULT_POOL_TARGET));

/** The target named by `SH_POOL_TARGET` (the scripts use the service's rule). Throws on an unknown name. */
export function poolTargetFromEnv(env: Record<string, string | undefined> = process.env): PoolTarget {
  return POOL_TARGETS[poolTargetId.parse(env.SH_POOL_TARGET)];
}

/** Keyless Sepolia websocket endpoints, in order. publicnode was checked in the research (§ 3.1). */
export const SEPOLIA_PUBLIC_WS_URLS: readonly string[] = Object.freeze(['wss://ethereum-sepolia-rpc.publicnode.com', 'wss://sepolia.gateway.tenderly.co']);

/** Ports this repo must never use (other local projects and the chain E2E's anvil range). */
const FORBIDDEN_PORTS = new Set([4173, 4174, 4175, 5173, 8547, 8548, 8549]);

const csv = z
  .string()
  .transform((value) => value.split(',').map((item) => item.trim()).filter(Boolean));

const port = z.coerce
  .number()
  .int()
  .min(1024)
  .max(65_535)
  .refine((value) => !FORBIDDEN_PORTS.has(value), 'port is reserved by another project');

const envSchema = z.object({
  SH_INDEXER_PORT: port.default(5393),
  SH_INDEXER_HOST: z.string().default('127.0.0.1'),
  SH_STORE: z.enum(['redis', 'memory']).default('redis'),
  SH_REDIS_URL: z.string().default('redis://127.0.0.1:5395/0'),
  /** Separates environments sharing one Redis: pub/sub channels ignore the database number. */
  SH_REDIS_NAMESPACE: z.string().regex(/^[a-z0-9-]{0,32}$/).default(''),
  SH_WS_URLS: csv.optional(),
  SH_HTTP_URLS: csv.optional(),
  /** "Confirmed" = at least this many blocks deep counting the block itself (head = 1). */
  SH_CONFIRMATIONS: z.coerce.number().int().min(1).max(64).default(2),
  /** Poll interval while the websocket is silent or disabled. */
  SH_POLL_MS: z.coerce.number().int().min(250).max(60_000).default(1_500),
  /** A socket counts as silent after this long without a head (2.5 slots: Sepolia skips slots, 24 s gaps happen). */
  SH_WS_SILENCE_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  SH_DISABLE_WS: z.enum(['0', '1']).default('0'),
  SH_ROLE: z.enum(['all', 'indexer', 'gateway']).default('all'),
  /** SSE streams per gateway process (about 20 KB each measured; 20,000 fits a 4 GB droplet with the proxy and Redis). */
  SH_MAX_CLIENTS: z.coerce.number().int().min(1).max(200_000).default(20_000),
  /** SSE streams per client address (mobile carriers put many viewers behind one address: not too low). */
  SH_MAX_STREAMS_PER_IP: z.coerce.number().int().min(1).max(10_000).default(32),
  /** Peers whose CF-Connecting-IP / X-Real-IP / X-Forwarded-For are believed (the local proxy or tunnel). */
  SH_TRUSTED_PROXIES: csv.default(['127.0.0.1', '::1']),
  /** 1: serve /metrics and the debug page to proxied and remote requests too (off: direct local requests only). */
  SH_PUBLIC_DEBUG: z.enum(['0', '1']).default('0'),
  /** Which pool to follow: `sepolia-full` (the whole v2 system, default) or `sepolia-rehearsal` (the route rehearsal). */
  SH_POOL_TARGET: poolTargetId,
});

export interface ServiceConfig {
  readonly port: number;
  readonly host: string;
  readonly store: 'redis' | 'memory';
  readonly redisUrl: string;
  readonly redisNamespace: string;
  readonly wsUrls: readonly string[];
  readonly httpUrls: readonly string[];
  readonly confirmations: number;
  readonly pollMs: number;
  readonly wsSilenceMs: number;
  readonly role: 'all' | 'indexer' | 'gateway';
  readonly maxClients: number;
  readonly maxStreamsPerIp: number;
  readonly trustedProxies: readonly string[];
  readonly publicDebug: boolean;
  readonly target: PoolTarget;
}

export function loadServiceConfig(env: Record<string, string | undefined> = process.env): ServiceConfig {
  const parsed = envSchema.parse(env);
  const disableWs = parsed.SH_DISABLE_WS === '1';
  return {
    port: parsed.SH_INDEXER_PORT,
    host: parsed.SH_INDEXER_HOST,
    store: parsed.SH_STORE,
    redisUrl: parsed.SH_REDIS_URL,
    redisNamespace: parsed.SH_REDIS_NAMESPACE,
    wsUrls: disableWs ? [] : (parsed.SH_WS_URLS ?? SEPOLIA_PUBLIC_WS_URLS),
    httpUrls: parsed.SH_HTTP_URLS ?? [...SEPOLIA_PUBLIC_RPC_URLS],
    confirmations: parsed.SH_CONFIRMATIONS,
    pollMs: parsed.SH_POLL_MS,
    wsSilenceMs: parsed.SH_WS_SILENCE_MS,
    role: parsed.SH_ROLE,
    maxClients: parsed.SH_MAX_CLIENTS,
    maxStreamsPerIp: parsed.SH_MAX_STREAMS_PER_IP,
    trustedProxies: parsed.SH_TRUSTED_PROXIES,
    publicDebug: parsed.SH_PUBLIC_DEBUG === '1',
    target: POOL_TARGETS[parsed.SH_POOL_TARGET],
  };
}
