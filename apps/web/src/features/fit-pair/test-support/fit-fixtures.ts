/**
 * The e2e fixtures for the local-chain FIT market (apps/web/e2e/fixtures/fit-live-31337.json): what the live service
 * and the RPC answer in the browser tests, which intercept both (no server runs, nothing is deployed). Built from the
 * Demo chain simulator on the fixture target, so every frame is what the indexer's own view builders serialise and
 * every RPC answer is the ABI encoding of the same state. `fit-fixtures.test.ts` writes the file with
 * SH_WRITE_FIXTURES=1 and otherwise checks that the committed file is exactly this output.
 */
import {
  FIT_HOOK_READ_ABI,
  FIT_PLACEHOLDERS_READ_ABI,
  FIT_POOL_MANAGER_READ_ABI,
  FIT_TOKEN_READ_ABI,
  FIT_VAULT_READ_ABI,
  poolStateSlot,
} from '@squarehole/chain';
import { toJson } from '@squarehole/indexer/client';
import { encodeFunctionData, encodeFunctionResult, pad, toHex, type Abi } from 'viem';
import { DemoChain } from '../demo-chain';
import { FIT_ISSUANCE_RAW, parseFitMarket, type FitMarketTarget } from '../fit-target';

export const FIXTURE_RPC_URL = 'http://127.0.0.1:8599';
/** Blocks after the open the fixture's head sits at: past the window, mid-curve. */
const HEAD_OFFSET = 120n;
/** The fixture's vault: every Misfit inside, 37 placeholders taken (before graduation). */
const VAULT = { inside: 4_200n, size: 4_200n, gateOpen: false, slots: 37, minted: 37 };

function sse(events: readonly { readonly id?: string; readonly event: string; readonly data: string }[], retryMs: number): string {
  return `retry: ${retryMs}\n: fixture\n\n${events.map((e) => `${e.id ? `id: ${e.id}\n` : ''}event: ${e.event}\ndata: ${e.data}\n\n`).join('')}`;
}

function slot0Word(sqrt: bigint, tick: number): `0x${string}` {
  const tickBits = BigInt(tick < 0 ? tick + 0x1000000 : tick);
  return pad(toHex(sqrt | (tickBits << 160n) | (10_000n << 208n)), { size: 32 });
}

function selector(abi: Abi, functionName: string, args?: readonly unknown[]): string {
  return encodeFunctionData({ abi, functionName, args } as never).slice(0, 10);
}

function result(abi: Abi, functionName: string, value: unknown): string {
  return encodeFunctionResult({ abi, functionName, result: value } as never);
}

export interface FitLiveFixture {
  readonly note: string;
  readonly head: string;
  readonly headAfter: string;
  /** The snapshot endpoint's body at the head, and after two more blocks. */
  readonly snapshot: string;
  readonly snapshotAfter: string;
  /** Whole SSE bodies (each connection gets one; the browser reconnects after `retry`). */
  readonly streams: {
    readonly initial: string;
    readonly next: string;
    readonly stale: string;
    readonly unverified: string;
    readonly reorg: string;
    readonly wrongPool: string;
  };
  /** JSON-RPC answers: the latest header and eth_call results by `<to lowercase>:<selector>`. */
  readonly rpc: {
    readonly latest: { readonly number: string; readonly hash: string; readonly timestamp: string };
    readonly calls: Readonly<Record<string, string>>;
  };
}

export function fixtureTarget(record: unknown): FitMarketTarget {
  return parseFitMarket(record, FIXTURE_RPC_URL);
}

export function buildFitLiveFixture(record: unknown): FitLiveFixture {
  const target = fixtureTarget(record);
  const chain = new DemoChain(target);
  chain.mineTo(target.openBlock + HEAD_OFFSET);
  const nowMs = Number(chain.head.header.timestamp) * 1000;
  const snapshot = toJson(chain.snapshot(nowMs));
  const head = chain.head;
  let seq = 100;
  const status = (indexer: string, reason: string | null) => JSON.stringify({ indexer, reason, atMs: nowMs });
  const initial = sse(
    [
      { id: `${seq}-${head.header.number}:${head.header.hash.slice(2, 10)}`, event: 'snapshot', data: snapshot },
      { event: 'status', data: status('live', null) },
    ],
    1_000,
  );
  const stale = sse([{ event: 'snapshot', data: snapshot }, { event: 'status', data: status('stale', 'no new block') }], 600_000);
  const unverified = sse([{ event: 'snapshot', data: snapshot }, { event: 'status', data: status('unverified', 'the indexer state differs from the chain') }], 600_000);
  const wrongPool = sse([{ event: 'snapshot', data: snapshot.replace(target.poolId, `0x${'ee'.repeat(32)}`) }], 600_000);

  // A reorg of the head block: the snapshot, then the head replaced (its trades dropped).
  const forked = new DemoChain(target);
  forked.mineTo(target.openBlock + HEAD_OFFSET);
  const rolled = forked.rollback(1);
  const reorg = sse(
    [
      { event: 'snapshot', data: snapshot },
      { event: 'status', data: status('live', null) },
      { id: `${seq + 1}-${rolled.ancestor.header.number}:${rolled.ancestor.header.hash.slice(2, 10)}`, event: 'reorg', data: toJson(forked.reorgEvent(seq + 1, rolled)) },
    ],
    600_000,
  );

  const first = chain.mineNext();
  const second = chain.mineNext();
  seq += 1;
  const next = sse(
    [
      { id: `${seq}-${first.header.number}:${first.header.hash.slice(2, 10)}`, event: 'block', data: toJson(chain.blockEvent(seq, first)) },
      { id: `${seq + 1}-${second.header.number}:${second.header.hash.slice(2, 10)}`, event: 'block', data: toJson(chain.blockEvent(seq + 1, second)) },
    ],
    600_000,
  );
  const snapshotAfter = toJson(chain.snapshot(Number(second.header.timestamp) * 1000));

  // The RPC at the head the fixture's direct reads see (the first snapshot's head).
  const state = head.state;
  const key = (to: string, sel: string) => `${to.toLowerCase()}:${sel}`;
  const calls: Record<string, string> = {
    [key(target.poolManager, selector(FIT_POOL_MANAGER_READ_ABI, 'extsload', [poolStateSlot(target.poolId)]))]: result(FIT_POOL_MANAGER_READ_ABI, 'extsload', slot0Word(state.sqrtPriceX96, state.tick)),
    [key(target.hook, selector(FIT_HOOK_READ_ABI, 'phase'))]: result(FIT_HOOK_READ_ABI, 'phase', 0),
    [key(target.hook, selector(FIT_HOOK_READ_ABI, 'completedAtBlock'))]: result(FIT_HOOK_READ_ABI, 'completedAtBlock', 0n),
    [key(target.hook, selector(FIT_HOOK_READ_ABI, 'migratedAtBlock'))]: result(FIT_HOOK_READ_ABI, 'migratedAtBlock', 0n),
    [key(target.hook, selector(FIT_HOOK_READ_ABI, 'liquidityOpensAt'))]: result(FIT_HOOK_READ_ABI, 'liquidityOpensAt', 0n),
    [key(target.hook, selector(FIT_HOOK_READ_ABI, 'openBlock'))]: result(FIT_HOOK_READ_ABI, 'openBlock', target.openBlock),
    [key(target.token, selector(FIT_TOKEN_READ_ABI, 'totalSupply'))]: result(FIT_TOKEN_READ_ABI, 'totalSupply', FIT_ISSUANCE_RAW - state.burnedRaw),
    [key(target.vault ?? '', selector(FIT_VAULT_READ_ABI, 'inside'))]: result(FIT_VAULT_READ_ABI, 'inside', VAULT.inside),
    [key(target.vault ?? '', selector(FIT_VAULT_READ_ABI, 'collectionSize'))]: result(FIT_VAULT_READ_ABI, 'collectionSize', VAULT.size),
    [key(target.vault ?? '', selector(FIT_VAULT_READ_ABI, 'gateOpen'))]: result(FIT_VAULT_READ_ABI, 'gateOpen', VAULT.gateOpen),
    [key(target.placeholders ?? '', selector(FIT_PLACEHOLDERS_READ_ABI, 'status'))]: result(FIT_PLACEHOLDERS_READ_ABI, 'status', {
      minted: VAULT.minted,
      slots: VAULT.slots,
      wordRequestedAt: 0,
      wordAcceptedAt: 0,
      terminalAt: 0,
      drawsRequested: 0,
      drawsSettled: 0,
    }),
  };
  return {
    note: 'Generated by apps/web/src/features/fit-pair/test-support/fit-fixtures.ts (SH_WRITE_FIXTURES=1 pnpm vitest run --project web fit-fixtures). Invented trades on the Misfits curve, exact v4 math, the indexer’s own view builders. Nothing here was read from or sent to a chain.',
    head: head.header.number.toString(),
    headAfter: second.header.number.toString(),
    snapshot,
    snapshotAfter,
    streams: { initial, next, stale, unverified, reorg, wrongPool },
    rpc: {
      latest: { number: toHex(head.header.number), hash: head.header.hash, timestamp: toHex(head.header.timestamp) },
      calls,
    },
  };
}
