import { getAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';
import type { Limits } from './decide';
import type { DestinationGasReader } from './chain';
import { EIP7825_GAS_CAP, GasAdmissionError, type DestinationGasPolicy, type GasClient, type PendingGasEstimator } from './gas';
import { DEFAULT_UNBLOCKING_GAS_PER_BOX_PER_DAY } from './income';
import type { SetReleaseManifest } from '../../chain/src/core/set-v2/manifest-set-v2';

export interface CoinMinimums {
  readonly collectRaw: bigint;
}

/** Address keys are lower-case on the configured chain; amounts are raw units of that coin, never wei valuations. */
export type CoinMinimumOverrides = Readonly<Record<string, CoinMinimums>>;

/** An input ceiling, not a change to box 0's stricter on-chain per-block chunk allowance. */
export const MAX_EXECUTOR_CHUNKS = 32n;

/** Default batching floor: 0.01 P. Missing/unsupported metadata suppresses only these maintenance jobs. */
export function coinMinimumsFor(q: Address, decimals: number | null, overrides: CoinMinimumOverrides = {}): CoinMinimums | null {
  const configured = overrides[q.toLowerCase()];
  if (configured) return configured;
  const places = /^0x0{40}$/i.test(q) ? 18 : decimals;
  if (places === null || !Number.isInteger(places) || places < 6 || places > 18) return null;
  const raw = 10n ** BigInt(places - 2);
  return { collectRaw: raw };
}

/**
 * The keeper's settings, from the environment only (the ticket: "keys only from the environment; dry-run mode"). It
 * runs dry unless `SH_KEEPER_DRY_RUN=0`, and then needs `SH_KEEPER_PRIVATE_KEY`. The retained private-send configuration uses
 * a second key, `SH_KEEPER_PRIVATE_SEND_KEY`, so a private send the public node cannot see never shares a nonce with a
 * public one (review round 1, H2). Gas budgets are wei; coin minimums are raw P units, configured as decimal strings.
 */
export interface KeeperConfig {
  readonly rpcUrl: string;
  readonly rpcFallbackUrl?: string | null;
  readonly privateRpcUrl: string | null;
  readonly privateKey: Hex | null;
  readonly privateSendKey: Hex | null;
  /** Fixed Alchemist trigger for keyless private-send simulation; checked against the private signer when supplied. */
  readonly privateSendAddress: Address | null;
  readonly dryRun: boolean;
  readonly chainId: number;
  readonly allowMainnet: boolean;
  /** Public signer address for keyless dry runs (also checked against a configured signer). */
  readonly keeperAddress: Address | null;
  readonly destinationGas: DestinationGasPolicy;
  readonly boxRegistry: Address | null;
  /** Separate set-only instance, validated against its core manifest by setKeeperConfig. */
  readonly setRelease?: SetReleaseManifest;
  /** v1 box 0 (FIT): its receiver and hook run on the same rhythm; FIT's executor is its price average. */
  readonly box0: { readonly coordinator: Address; readonly hook: Address; readonly receiver: Address; readonly executor: Address } | null;
  readonly limits: Limits;
  readonly priorityFeeWei: bigint;
  readonly payoutMinWei: bigint;
  readonly graduationBountyWei?: bigint;
  readonly coinMinimums: CoinMinimumOverrides;
  readonly pollMs: number;
  readonly retryBlocks: bigint;
  readonly executorMaxChunks: bigint;
  readonly buyBackAlertBlocks: bigint;
  readonly stateFile: string;
  /**
   * The monitor view (infra/server/monitor/keeper-view.md), rewritten after each tick; dry runs add `.dry` like the
   * journal. Unset (the default): no view and no extra reads.
   */
  readonly monitorFile?: string | null;
  /** Release deployment block for bounded royalty-event backfill. */
  readonly fromBlock: bigint;
}

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((a) => getAddress(a));
const addresses = z
  .string()
  .default('')
  .transform((s) => s.split(',').map((x) => x.trim()).filter((x) => x !== ''))
  .pipe(z.array(address));
const wei = (fallback: string) => z.string().regex(/^\d+$/).default(fallback).transform((s) => BigInt(s));
const key = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const int = (fallback: string) => z.string().regex(/^\d+$/).default(fallback).transform((s) => Number.parseInt(s, 10));
const rawMinimum = z.string().regex(/^\d+$/).transform((s) => BigInt(s))
  .refine((n) => n > 0n && n < 2n ** 256n, { message: 'must be a positive uint256 decimal string' });
const coinMinimums = z.string().default('{}').transform((s, ctx): unknown => {
  try { return JSON.parse(s); }
  catch {
    ctx.addIssue({ code: 'custom', message: 'must be a JSON object of per-coin minimums' });
    return z.NEVER;
  }
}).pipe(z.record(z.string().regex(/^0x[0-9a-fA-F]{40}$/), z.strictObject({ collectRaw: rawMinimum })))
  .superRefine((entries, ctx) => {
    const keys = Object.keys(entries).map((q) => q.toLowerCase());
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: 'duplicate coin address' });
  }).transform((entries) => Object.fromEntries(Object.entries(entries).map(([q, amounts]) => [q.toLowerCase(), amounts])));

const schema = z
  .object({
    SH_KEEPER_RPC_URL: z.url(),
    SH_KEEPER_RPC_FALLBACK_URL: z.url().optional(),
    SH_KEEPER_PRIVATE_RPC_URL: z.url().optional(),
    SH_KEEPER_PRIVATE_KEY: key.optional(),
    SH_KEEPER_PRIVATE_SEND_KEY: key.optional(),
    SH_KEEPER_PRIVATE_SEND_ADDRESS: address.optional(),
    SH_KEEPER_DRY_RUN: z.enum(['0', '1']).default('1'),
    SH_KEEPER_CHAIN_ID: int('11155111'),
    SH_KEEPER_ALLOW_MAINNET: z.enum(['0', '1']).default('0'),
    SH_KEEPER_ADDRESS: address.optional(),
    SH_KEEPER_DESTINATION_FORK: z.enum(['cancun', 'osaka', 'amsterdam']),
    SH_KEEPER_TRANSACTION_GAS_CAP: z.union([z.literal('none').transform(() => null),
      z.string().regex(/^\d+$/).transform(s => BigInt(s)).refine(n => n > 0n)]),
    SH_KEEPER_BOX_REGISTRY: address.optional(),
    SH_KEEPER_BOX0: addresses,
    SH_KEEPER_FROM_BLOCK: wei('0'),
    SH_KEEPER_RETRY_BLOCKS: wei('25').refine((n) => n > 0n),
    SH_KEEPER_EXECUTOR_MAX_CHUNKS: wei('1').refine((n) => n > 0n && n <= MAX_EXECUTOR_CHUNKS),
    SH_KEEPER_BUYBACK_ALERT_BLOCKS: wei('300').refine((n) => n > 0n),
    SH_KEEPER_DRAND_RESCUE_MAX_FEE_WEI: wei('50000000000').refine(n => n > 0n),
    SH_KEEPER_DRAND_RESCUE_WINDOW_SECONDS: wei('259200'),
    SH_KEEPER_DRAND_RESCUE_WEI_PER_DAY: wei('50000000000000000'),
    SH_KEEPER_MAX_FEE_WEI: wei('3000000000').refine((n) => n > 0n),
    SH_KEEPER_STATE_FILE: z.string().min(1).default('.cache/keeper-state.json'),
    SH_KEEPER_MONITOR_FILE: z.string().min(1).refine(s => !/[\0\r\n]/.test(s)).optional(),
    // F111: wait above 3 gwei; scale KEEPER-LIMITS by 3/10 without changing gas envelopes.
    // A padded 16.2M graduation costs 0.0486 ETH; protect 0.051 ETH for recovery.
    // Another 0.051 ETH stays ordinary, plus 0.012 ETH for Box 0 pokes.
    SH_KEEPER_OURS_WEI_PER_DAY: wei('102000000000000000'),
    SH_KEEPER_POKES_WEI_PER_DAY: wei('12000000000000000'),
    SH_KEEPER_RESERVE_WEI_PER_DAY: wei('51000000000000000'),
    SH_KEEPER_TOTAL_WEI_PER_DAY: wei('114000000000000000'),
    SH_KEEPER_UNBLOCKING_GAS_PER_BOX_PER_DAY: wei(DEFAULT_UNBLOCKING_GAS_PER_BOX_PER_DAY.toString()),
    // Unset: half the ordinary ours room for all boxes, a quarter of that for each box (decide.ts unblockingWeiLimits).
    SH_KEEPER_UNBLOCKING_WEI_PER_DAY: z.string().regex(/^\d+$/).transform((s) => BigInt(s)).optional(),
    SH_KEEPER_UNBLOCKING_WEI_PER_BOX_PER_DAY: z.string().regex(/^\d+$/).transform((s) => BigInt(s)).optional(),
    SH_KEEPER_MAX_TX_PER_BLOCK: int('4'),
    SH_KEEPER_PRIORITY_FEE_WEI: wei('50000000'),
    SH_KEEPER_GRADUATION_BOUNTY_WEI: wei('0').refine(n => n <= 50_000_000_000_000_000n),
    SH_KEEPER_PAYOUT_MIN_WEI: wei('10000000000000000'),
    SH_KEEPER_COIN_MINIMUMS: coinMinimums,
    SH_KEEPER_POLL_MS: int('4000'),
  })
  .superRefine((env, ctx) => {
    if (env.SH_KEEPER_CHAIN_ID === 1 && env.SH_KEEPER_ALLOW_MAINNET !== '1') {
      ctx.addIssue({ code: 'custom', path: ['SH_KEEPER_ALLOW_MAINNET'], message: 'explicit mainnet opt-in required, including dry runs' });
    }
    if (env.SH_KEEPER_DESTINATION_FORK !== 'cancun'
      && (env.SH_KEEPER_TRANSACTION_GAS_CAP === null || env.SH_KEEPER_TRANSACTION_GAS_CAP > EIP7825_GAS_CAP)) {
      ctx.addIssue({ code: 'custom', path: ['SH_KEEPER_TRANSACTION_GAS_CAP'], message: 'Osaka/Amsterdam require a positive cap at most 16777216' });
    }
    if (env.SH_KEEPER_DRY_RUN === '0' && !env.SH_KEEPER_PRIVATE_KEY) {
      ctx.addIssue({ code: 'custom', path: ['SH_KEEPER_PRIVATE_KEY'], message: 'required unless SH_KEEPER_DRY_RUN=1' });
    }
    if (env.SH_KEEPER_BOX0.length !== 0 && env.SH_KEEPER_BOX0.length !== 4) {
      ctx.addIssue({ code: 'custom', path: ['SH_KEEPER_BOX0'], message: 'coordinator,hook,receiver,executor' });
    }
    if (env.SH_KEEPER_PRIVATE_SEND_KEY && env.SH_KEEPER_PRIVATE_SEND_KEY.toLowerCase() === env.SH_KEEPER_PRIVATE_KEY?.toLowerCase()) {
      ctx.addIssue({ code: 'custom', path: ['SH_KEEPER_PRIVATE_SEND_KEY'], message: 'must differ from SH_KEEPER_PRIVATE_KEY' });
    }
    if (env.SH_KEEPER_DRAND_RESCUE_MAX_FEE_WEI < env.SH_KEEPER_MAX_FEE_WEI) {
      ctx.addIssue({ code: 'custom', path: ['SH_KEEPER_DRAND_RESCUE_MAX_FEE_WEI'], message: 'at least SH_KEEPER_MAX_FEE_WEI' });
    }
    if (env.SH_KEEPER_GRADUATION_BOUNTY_WEI > env.SH_KEEPER_OURS_WEI_PER_DAY - env.SH_KEEPER_RESERVE_WEI_PER_DAY) {
      ctx.addIssue({ code: 'custom', path: ['SH_KEEPER_GRADUATION_BOUNTY_WEI'], message: 'at most ordinary ours room' });
    }
    const reserve = env.SH_KEEPER_RESERVE_WEI_PER_DAY;
    if (reserve > env.SH_KEEPER_OURS_WEI_PER_DAY || reserve > env.SH_KEEPER_TOTAL_WEI_PER_DAY) {
      ctx.addIssue({ code: 'custom', path: ['SH_KEEPER_RESERVE_WEI_PER_DAY'], message: 'at most the ours budget and the daily ceiling' });
    }

  });

/** Every variable the schema reads, for doc pins (docs/runbooks/keeper-sepolia-env.md). */
export const KEEPER_ENV_NAMES: readonly string[] = Object.freeze(Object.keys(schema.shape));

/** Parses the environment; an error names the variables only, never their values. */
export function loadConfig(env: Record<string, string | undefined>): KeeperConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const what = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid keeper settings (${what})`);
  }
  const e = parsed.data;
  const [coordinator, hook, receiver, executor] = e.SH_KEEPER_BOX0;
  const unblockingWeiPerDay = e.SH_KEEPER_UNBLOCKING_WEI_PER_DAY ?? (e.SH_KEEPER_OURS_WEI_PER_DAY - e.SH_KEEPER_RESERVE_WEI_PER_DAY) / 2n;
  return {
    rpcUrl: e.SH_KEEPER_RPC_URL,
    rpcFallbackUrl: e.SH_KEEPER_RPC_FALLBACK_URL ?? null,
    privateRpcUrl: e.SH_KEEPER_PRIVATE_RPC_URL ?? null,
    privateKey: (e.SH_KEEPER_PRIVATE_KEY as Hex | undefined) ?? null,
    privateSendKey: (e.SH_KEEPER_PRIVATE_SEND_KEY as Hex | undefined) ?? null,
    privateSendAddress: e.SH_KEEPER_PRIVATE_SEND_ADDRESS ?? null,
    dryRun: e.SH_KEEPER_DRY_RUN === '1',
    chainId: e.SH_KEEPER_CHAIN_ID,
    allowMainnet: e.SH_KEEPER_ALLOW_MAINNET === '1',
    keeperAddress: e.SH_KEEPER_ADDRESS ?? null,
    destinationGas: { fork: e.SH_KEEPER_DESTINATION_FORK, transactionCap: e.SH_KEEPER_TRANSACTION_GAS_CAP },
    boxRegistry: e.SH_KEEPER_BOX_REGISTRY ?? null,
    box0: coordinator && hook && receiver && executor ? { coordinator, hook, receiver, executor } : null,
    limits: {
      oursWeiPerDay: e.SH_KEEPER_OURS_WEI_PER_DAY,
      pokesWeiPerDay: e.SH_KEEPER_POKES_WEI_PER_DAY,
      reserveWeiPerDay: e.SH_KEEPER_RESERVE_WEI_PER_DAY,
      totalWeiPerDay: e.SH_KEEPER_TOTAL_WEI_PER_DAY,
      maxTxPerBlock: e.SH_KEEPER_MAX_TX_PER_BLOCK,
      maxFeePerGas: e.SH_KEEPER_MAX_FEE_WEI,
      drandRescueMaxFeeWei: e.SH_KEEPER_DRAND_RESCUE_MAX_FEE_WEI,
      drandRescueWindowSeconds: e.SH_KEEPER_DRAND_RESCUE_WINDOW_SECONDS,
      drandRescueWeiPerDay: e.SH_KEEPER_DRAND_RESCUE_WEI_PER_DAY,
      unblockingGasPerBoxPerDay: e.SH_KEEPER_UNBLOCKING_GAS_PER_BOX_PER_DAY,
      unblockingWeiPerDay,
      unblockingWeiPerBoxPerDay: e.SH_KEEPER_UNBLOCKING_WEI_PER_BOX_PER_DAY ?? unblockingWeiPerDay / 4n,
    },
    priorityFeeWei: e.SH_KEEPER_PRIORITY_FEE_WEI,
    payoutMinWei: e.SH_KEEPER_PAYOUT_MIN_WEI,
    graduationBountyWei: e.SH_KEEPER_GRADUATION_BOUNTY_WEI,
    coinMinimums: e.SH_KEEPER_COIN_MINIMUMS,
    pollMs: e.SH_KEEPER_POLL_MS,
    retryBlocks: e.SH_KEEPER_RETRY_BLOCKS,
    executorMaxChunks: e.SH_KEEPER_EXECUTOR_MAX_CHUNKS,
    buyBackAlertBlocks: e.SH_KEEPER_BUYBACK_ALERT_BLOCKS,
    stateFile: e.SH_KEEPER_STATE_FILE,
    monitorFile: e.SH_KEEPER_MONITOR_FILE ?? null,
    fromBlock: e.SH_KEEPER_FROM_BLOCK,
  };
}

/** Explicit policy only. Amsterdam defers unless the adapter supplies the paired reviewed estimate. */
export function destinationGasReader(policy: DestinationGasPolicy): DestinationGasReader {
  return async (_candidate, estimate, _pending, paired) => {
    if (policy.fork !== 'amsterdam') return policy;
    if (!paired || paired.stateGas === undefined) throw new GasAdmissionError('reviewed pending state gas unavailable');
    if (paired.gas !== estimate) throw new GasAdmissionError('pending estimate mismatch');
    return { ...policy, stateGas: paired.stateGas };
  };
}

/** EIP-8037: limits at or below 2^24 have no reservoir. Admission must still bound the signed limit. */
export function noReservoirEstimator(client: Pick<GasClient, 'estimateGas'>): PendingGasEstimator {
  return async request => {
    const gas = await client.estimateGas(request);
    if (typeof gas !== 'bigint' || gas <= 0n) throw new GasAdmissionError('invalid pending gas estimate');
    return Object.freeze({ gas, stateGas: 0n });
  };
}

export function destinationGasAdapters(policy: DestinationGasPolicy, client: Pick<GasClient, 'estimateGas'>) {
  return { reader: destinationGasReader(policy),
    estimator: policy.fork === 'amsterdam' ? noReservoirEstimator(client) : undefined };
}

/** Whether the private jobs can be sent: a private endpoint, and in live mode their own key. */
export const privateSendsReady = (c: KeeperConfig) => c.privateRpcUrl !== null && (c.privateSendKey !== null || (c.dryRun && c.privateSendAddress !== null));

/** What the keeper warns about at start (review round 1, M4): settings under which a job is always skipped. */
export function startupWarnings(c: KeeperConfig): string[] {
  return c.boxRegistry ? ['FINAL2-GAS envelopes cover measured parts; unknown P tips are budgeted as ours'] : [];
}

/** Everything a log line must never show: the key (with and without 0x) and each RPC URL with its path and query. */
export function secretsOf(c: KeeperConfig): string[] {
  const out: string[] = [];
  for (const k of [c.privateKey, c.privateSendKey]) if (k) out.push(k, k.slice(2));
  for (const u of [c.rpcUrl, c.rpcFallbackUrl, c.privateRpcUrl]) {
    if (!u) continue;
    out.push(u);
    const url = new URL(u);
    for (const part of [url.pathname + url.search, url.search, url.username, url.password]) if (part.length > 1) out.push(part);
  }
  return out;
}

/** A printable summary: hosts only, no key, no token. */
export function describeConfig(c: KeeperConfig): string {
  const host = (u: string | null) => (u ? new URL(u).host : 'none');
  return [
    `chain ${c.chainId}`,
    `fork ${c.destinationGas.fork}, transaction cap ${c.destinationGas.transactionCap ?? 'none'}`,
    ...(c.destinationGas.fork === 'amsterdam' ? ['state gas: no reservoir (limit <= cap)'] : []),
    c.dryRun ? 'dry run' : 'sending',
    `rpc ${host(c.rpcUrl)}`,
    `rpc fallback ${host(c.rpcFallbackUrl ?? null)}`,
    `private ${host(c.privateRpcUrl)}`,
    `private-send key ${c.privateSendKey ? 'set' : 'none'}`,
    `box registry ${c.boxRegistry ?? 'none'}`,
    `box 0 ${c.box0 ? 'on' : 'off'}`,
  ].join(', ');
}
