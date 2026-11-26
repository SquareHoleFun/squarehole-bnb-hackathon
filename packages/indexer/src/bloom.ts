/**
 * The block header's 2048-bit logs bloom (Yellow Paper M3:2048; geth core/types/bloom9.go): every log adds its
 * address and each of its topics. A negative test is certain ("no such log in this block"), a positive one may be
 * false. The per-block pipeline skips `eth_getLogs` when the bloom rules out every log the state depends on
 * (events.ts `isStateRelevant`): most Sepolia blocks touch the PoolManager but not our pool, so the head update needs
 * no RPC call at all.
 *
 * Sepolia blooms are about 40% full (808 of 2048 bits on average over the recorded window), so one address alone
 * tests positive in about 6% of blocks. The checks therefore pair each contract with the topics we read from it:
 * pool = PoolManager ∧ poolId; token burn = token ∧ Transfer ∧ zero topic; each other contract = address ∧ (one of
 * its event topics).
 */
import { hexToBytes, keccak256, type Address, type Hex } from 'viem';
import { LAUNCH_TOPICS, ZERO_TOPIC } from './events';

export function bloomContains(bloom: Hex, value: Hex): boolean {
  const bits = hexToBytes(bloom);
  if (bits.length !== 256) throw new RangeError('a logs bloom has 256 bytes');
  const hash = hexToBytes(keccak256(value));
  for (let i = 0; i < 6; i += 2) {
    const bitIndex = (((hash[i] ?? 0) << 8) | (hash[i + 1] ?? 0)) & 0x7ff;
    const byteIndex = 255 - (bitIndex >> 3);
    const mask = 1 << (bitIndex & 7);
    if (((bits[byteIndex] ?? 0) & mask) === 0) return false;
  }
  return true;
}

export interface BloomTarget {
  readonly poolManager: Address;
  readonly poolId: Hex;
  readonly token: Address;
  readonly hook: Address;
  readonly collector: Address;
  readonly executor: Address;
  readonly launchRouter: Address;
  readonly genesis: Address;
}

export interface BloomQuery {
  /** PoolManager AND the poolId topic: a log of our pool is possible. */
  readonly pool: boolean;
  /** One of our launch contracts may have emitted an event the state reads. */
  readonly contracts: boolean;
}

/** Each launch contract with the topics we read from it (all of `anyOf` alternatives; `all` must all be present). */
function launchChecks(t: BloomTarget): readonly { readonly address: Address; readonly anyOf: readonly Hex[]; readonly all?: readonly Hex[] }[] {
  const L = LAUNCH_TOPICS;
  return [
    { address: t.token, anyOf: [L.Transfer], all: [ZERO_TOPIC] },
    { address: t.hook, anyOf: [L.PoolFeesRealised, L.PoolFeeNotifyFailed, L.PoolLaunched] },
    { address: t.collector, anyOf: [L.Flushed] },
    { address: t.executor, anyOf: [L.TokensBurned] },
    { address: t.launchRouter, anyOf: [L.TaxedBuy, L.Bootstrapped, L.Swept] },
    { address: t.genesis, anyOf: [L.LaunchWindowAnnounced] },
  ];
}

export function bloomQuery(bloom: Hex | undefined, target: BloomTarget): BloomQuery {
  if (!bloom) return { pool: true, contracts: true };
  const has = (value: Hex): boolean => bloomContains(bloom, value);
  return {
    pool: has(target.poolManager) && has(target.poolId),
    contracts: launchChecks(target).some((check) => has(check.address) && check.anyOf.some(has) && (check.all ?? []).every(has)),
  };
}
