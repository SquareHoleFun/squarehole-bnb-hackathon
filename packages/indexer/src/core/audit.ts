/**
 * The totals audit per box (S10a § 3.4; BC-080): every 32 blocks, at ONE block hash, the box's views are read and
 * compared with what its events gave. A mismatch marks that box Unverified (snapshot, feed card, page) and touches no
 * other box (BC-094); the pipeline then repairs it (re-reads its logs from its creation block) and audits again.
 *
 * Compared (exact from events): T's totalSupply and totalBurned (its mints and burns); the vault's escrow, inside,
 * hidden, pending tickets and outside (each vault event's `*After` fields); the pool's √P, tick and active liquidity
 * (Swap, Initialize, ModifyLiquidity; PoolManager.extsload); the hook's graduated layout (Migrated), pair-and-lock
 * liquidity (Deepened), closed and migrated blocks, and phase (BC-081); the coordinator's pool share (its T balance
 * until graduation); the receiver's held depth (DepthHeld until the settlement); the stream's claimed and burned totals
 * and its T balance. The fee ledgers the Fees card shows (core-fees.ts), against the receiver's own: the platform's
 * kept total (Σ PlatformCredited.kept vs `totals().toPlatform`), owed (less PlatformPaid), held before graduation
 * (`platformHeld()`) and the epoch now with what it kept (`platformEpoch()`); for box 0 also FIT's part (Σ qFit + the
 * REV-16 returns vs `toFit`, and less FitPaid vs `fitOwed()`), the pool's Q and T parts (Σ BatchSplit.qDepth + the
 * settlement's part above the cap + gifts vs `qToDepth`; Σ tDepth vs `tToDepth`) and T marked to burn (Σ tBurned vs
 * `totals().tBurned` + `tBurnPending()`). Read and shown but not compared (no exact event source): the hook's depth
 * budget and reserve, the stream's index and outside count, the tickets' status.
 *
 * Sender-independent views use Multicall3 at the same block hash when deployed; local chains without it keep single
 * calls. Every sub-call keeps its own decoding and refusal (multicall.ts).
 */
import { boxCoordinatorAbi, boxHookAbi, boxItemStreamAbi, boxReceiverAbi, boxTokenAbi, boxVaultAbi, poolManagerAbi } from '@squarehole/chain/abi';
import { poolStateSlot, decodeSlot0, type BoxRow } from '@squarehole/chain';
import { decodeFunctionResult, encodeFunctionData, type Abi, type Address, type Hex } from 'viem';
import type { CoreReader } from './core-reader';
import { batchViews } from './multicall';
import { platformNow, poolShareOf } from './core-views';
import { balanceOf, CONTRACT_PHASE, type CoreBoxState } from './derive-core';

export interface AuditReads {
  readonly block: bigint;
  readonly hash: Hex;
  readonly values: Readonly<Record<string, string>>;
}

export interface AuditResult {
  readonly block: bigint;
  readonly hash: Hex;
  readonly ok: boolean;
  /** `name: derived ≠ chain` for each mismatch. */
  readonly mismatches: readonly string[];
  readonly reads: AuditReads;
}

export interface ReadSpec {
  readonly name: string;
  readonly to: Address;
  readonly abi: Abi;
  readonly fn: string;
  readonly args?: readonly unknown[];
  /** Picks the compared values out of the decoded result. */
  readonly pick: (result: unknown) => Record<string, string>;
}

const s = (v: unknown): string => (typeof v === 'bigint' || typeof v === 'number' ? v.toString() : typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
const tuple = (keys: readonly string[]) => (result: unknown): Record<string, string> => {
  const values = Array.isArray(result) ? result : keys.map((k) => (result as Record<string, unknown>)[k]);
  return Object.fromEntries(keys.map((k, i) => [k, s(values[i])]));
};
const one = (key: string) => (result: unknown): Record<string, string> => ({ [key]: s(result) });

/** The views the audit reads for a box (one call each). */
export function auditSpecs(row: BoxRow): ReadSpec[] {
  const c = row.contracts;
  const out: ReadSpec[] = [
    { name: 'token', to: c.token as Address, abi: boxTokenAbi as Abi, fn: 'totalSupply', pick: one('token.totalSupply') },
    { name: 'token', to: c.token as Address, abi: boxTokenAbi as Abi, fn: 'totalBurned', pick: one('token.totalBurned') },
    { name: 'hook', to: c.hook as Address, abi: boxHookAbi as Abi, fn: 'phase', pick: (r) => ({ 'hook.phase': CONTRACT_PHASE[Number(r)] ?? `unknown(${String(r)})` }) },
    { name: 'hook', to: c.hook as Address, abi: boxHookAbi as Abi, fn: 'closedAtBlock', pick: one('hook.closedAtBlock') },
    { name: 'hook', to: c.hook as Address, abi: boxHookAbi as Abi, fn: 'migratedAtBlock', pick: one('hook.migratedAtBlock') },
    { name: 'hook', to: c.hook as Address, abi: boxHookAbi as Abi, fn: 'graduatedLayout', pick: tuple(['hook.askLiquidity', 'hook.bidLiquidity', 'hook.sentinelLiquidity']) },
    { name: 'hook', to: c.hook as Address, abi: boxHookAbi as Abi, fn: 'pairedLiquidity', pick: one('hook.pairedLiquidity') },
    { name: 'hook', to: c.hook as Address, abi: boxHookAbi as Abi, fn: 'depthBudget', pick: tuple(['hook.depthBudgetQ', 'hook.depthBudgetT']) },
    { name: 'hook', to: c.hook as Address, abi: boxHookAbi as Abi, fn: 'reserveMinted', pick: one('hook.reserveMinted') },
    { name: 'coordinator', to: c.coordinator as Address, abi: boxCoordinatorAbi as Abi, fn: 'poolShare', pick: one('coordinator.poolShare') },
    { name: 'receiver', to: c.receiver as Address, abi: boxReceiverAbi as Abi, fn: 'depthHeld', pick: tuple(['receiver.depthHeldQ', 'receiver.depthHeldT']) },
    { name: 'receiver', to: c.receiver as Address, abi: boxReceiverAbi as Abi, fn: 'platformEpoch', pick: tuple(['receiver.platformEpoch', 'receiver.platformKept', 'receiver.platformRemaining']) },
    { name: 'receiver', to: c.receiver as Address, abi: boxReceiverAbi as Abi, fn: 'platformOwed', pick: one('receiver.platformOwed') },
    { name: 'receiver', to: c.receiver as Address, abi: boxReceiverAbi as Abi, fn: 'fitOwed', pick: one('receiver.fitOwed') },
    {
      name: 'receiver',
      to: c.receiver as Address,
      abi: boxReceiverAbi as Abi,
      fn: 'totals',
      pick: tuple(['receiver.toFit', 'receiver.toPlatform', 'receiver.qToDepth', 'receiver.tToDepth', 'receiver.tBurned', 'receiver.qToCreator', 'receiver.tToCreator']),
    },
    { name: 'receiver', to: c.receiver as Address, abi: boxReceiverAbi as Abi, fn: 'platformHeld', pick: one('receiver.platformHeld') },
    { name: 'receiver', to: c.receiver as Address, abi: boxReceiverAbi as Abi, fn: 'tBurnPending', pick: one('receiver.tBurnPending') },
  ];
  if (c.vault) {
    for (const [fn, key] of [
      ['escrowPrincipal', 'vault.escrow'],
      ['inside', 'vault.inside'],
      ['hiddenCount', 'vault.hidden'],
      ['pendingTickets', 'vault.tickets'],
      ['outside', 'vault.outside'],
    ] as const) {
      out.push({ name: 'vault', to: c.vault, abi: boxVaultAbi as Abi, fn, pick: one(key) });
    }
  }
  if (c.itemStream) {
    out.push({ name: 'stream', to: c.itemStream, abi: boxItemStreamAbi as Abi, fn: 'totals', pick: tuple(['stream.claimed', 'stream.burned']) });
    out.push({ name: 'stream', to: c.itemStream, abi: boxItemStreamAbi as Abi, fn: 'index', pick: one('stream.index') });
    out.push({ name: 'stream', to: c.itemStream, abi: boxItemStreamAbi as Abi, fn: 'outsideCount', pick: one('stream.outsideCount') });
    out.push({ name: 'token', to: c.token as Address, abi: boxTokenAbi as Abi, fn: 'balanceOf', args: [c.itemStream], pick: one('stream.heldT') });
  }
  return out;
}

/**
 * The views the page shows that no event gives (the hook's depth budget, the stream's index): read at every block where
 * the box had an event (each changes only with one), so they hold at the head (S10a review).
 */
export function displaySpecs(row: BoxRow): ReadSpec[] {
  const c = row.contracts;
  const out: ReadSpec[] = [{ name: 'hook', to: c.hook as Address, abi: boxHookAbi as Abi, fn: 'depthBudget', pick: tuple(['hook.depthBudgetQ', 'hook.depthBudgetT']) }];
  if (c.itemStream) out.push({ name: 'stream', to: c.itemStream, abi: boxItemStreamAbi as Abi, fn: 'index', pick: one('stream.index') });
  return out;
}

async function readSpecs(reader: Pick<CoreReader, 'callAt'>, specs: readonly ReadSpec[], hash: Hex): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  await Promise.all(
    specs.map(async (spec) => {
      const data = encodeFunctionData({ abi: spec.abi, functionName: spec.fn, args: spec.args ?? [] } as never);
      const raw = await reader.callAt(spec.to, data, hash);
      Object.assign(values, spec.pick(decodeFunctionResult({ abi: spec.abi, functionName: spec.fn, data: raw } as never)));
    }),
  );
  return values;
}

/** The display views of a box at `hash` (throws when a call fails). */
export async function readDisplay(reader: CoreReader, row: BoxRow, hash: Hex): Promise<Record<string, string>> {
  return readSpecs(batchViews(reader), displaySpecs(row), hash);
}

const poolManagerReads = poolManagerAbi as Abi;
export const LIQUIDITY_OFFSET = 3n;

/** Every view of the box at `hash` (one call each, all at that block). Throws when a call fails (no verdict then). */
export async function readBox(reader: CoreReader, row: BoxRow, block: bigint, hash: Hex): Promise<AuditReads> {
  const views = batchViews(reader);
  const values = await readSpecs(views, auditSpecs(row), hash);
  // T marked to burn: burned, or waiting after a refused burn (both are BatchSplit.tBurned).
  values['receiver.tBurnedOrPending'] = (BigInt(values['receiver.tBurned'] ?? '0') + BigInt(values['receiver.tBurnPending'] ?? '0')).toString();
  // The pool's slot0 and liquidity (StateLibrary's slots, read with extsload, as the PoC verifier does).
  const slot = poolStateSlot(row.poolId);
  const liquiditySlot = `0x${(BigInt(slot) + LIQUIDITY_OFFSET).toString(16).padStart(64, '0')}` as Hex;
  const read = async (key: Hex): Promise<Hex> => {
    const data = encodeFunctionData({ abi: poolManagerReads, functionName: 'extsload', args: [key] } as never);
    return decodeFunctionResult({ abi: poolManagerReads, functionName: 'extsload', data: await views.callAt(row.poolManager, data, hash) } as never) as Hex;
  };
  const [word, liquidityWord] = await Promise.all([read(slot as Hex), read(liquiditySlot)]);
  const slot0 = decodeSlot0(word);
  values['pool.sqrtPriceX96'] = slot0.sqrtPriceX96.toString();
  values['pool.tick'] = slot0.tick.toString();
  values['pool.liquidity'] = (BigInt(liquidityWord) & ((1n << 128n) - 1n)).toString();
  return { block, hash, values };
}

/**
 * What the events say for each compared read (undefined: not known from events yet, so not compared). `state` is at the
 * audited block, with that block's timestamp (the platform's epoch is a time rule).
 */
export function derivedValues(state: CoreBoxState, row: BoxRow): Record<string, string | undefined> {
  const v = state.vault;
  const layout = state.layout;
  const f = state.fees;
  const p = state.platform;
  const now = platformNow(state);
  const box0 = row.isBox0;
  const stream = row.contracts.itemStream;
  const n = v.collectionSize ?? BigInt(row.spec.n);
  return {
    'coordinator.poolShare': poolShareOf(row, state).toString(),
    'receiver.toPlatform': p.credited.toString(),
    'receiver.platformOwed': (p.credited - p.paid).toString(),
    'receiver.platformHeld': p.held.toString(),
    'receiver.platformEpoch': (now.epoch ?? 0n).toString(),
    'receiver.platformKept': now.kept.toString(),
    // Box 0's split is known exactly from its events; another box's ledgers also follow its spec's streams (S11).
    'receiver.toFit': box0 ? (f.qFit + f.qFitReturned).toString() : undefined,
    'receiver.fitOwed': box0 ? (f.qFit + f.qFitReturned - state.fitPaid).toString() : undefined,
    'receiver.qToDepth': box0 ? (f.qDepth + f.qDepthSettled + state.depth.giftedQ).toString() : undefined,
    'receiver.tToDepth': box0 ? f.tDepth.toString() : undefined,
    'receiver.tBurnedOrPending': box0 ? f.tBurned.toString() : undefined,
    'stream.heldT': stream ? balanceOf(state, stream).toString() : undefined,
    'vault.outside': v.inside === null ? undefined : (n > v.inside ? n - v.inside : 0n).toString(),
    'token.totalSupply': state.supply.toString(),
    'token.totalBurned': state.burned.toString(),
    'hook.phase': state.phase,
    'hook.closedAtBlock': (state.closedAtBlock ?? 0n).toString(),
    'hook.migratedAtBlock': (state.migratedAtBlock ?? 0n).toString(),
    'hook.askLiquidity': (layout?.askLiquidity ?? 0n).toString(),
    'hook.bidLiquidity': (layout?.bidLiquidity ?? 0n).toString(),
    'hook.sentinelLiquidity': (layout?.sentinelLiquidity ?? 0n).toString(),
    'hook.pairedLiquidity': state.depth.pairedLiquidity.toString(),
    'receiver.depthHeldQ': state.depth.heldQ.toString(),
    'receiver.depthHeldT': state.depth.heldT.toString(),
    'vault.escrow': v.escrow?.toString(),
    'vault.inside': v.inside?.toString(),
    'vault.hidden': v.hidden?.toString(),
    'vault.tickets': v.tickets?.toString(),
    'stream.claimed': state.stream.claimed.toString(),
    'stream.burned': state.stream.burned.toString(),
    'pool.sqrtPriceX96': state.sqrtPriceX96?.toString(),
    'pool.tick': state.tick?.toString(),
    'pool.liquidity': state.sqrtPriceX96 === null ? undefined : state.liquidity.toString(),
  };
}

/** Compares a state (at the same block, with its timestamp) with the chain's reads. */
export function compareAudit(state: CoreBoxState, reads: AuditReads, row: BoxRow): AuditResult {
  const derived = derivedValues(state, row);
  const mismatches: string[] = [];
  for (const [key, mine] of Object.entries(derived)) {
    if (mine === undefined) continue;
    const chain = reads.values[key];
    if (chain === undefined) continue;
    if (chain !== mine) mismatches.push(`${key}: ${mine} ≠ ${chain}`);
  }
  return { block: reads.block, hash: reads.hash, ok: mismatches.length === 0, mismatches, reads };
}
