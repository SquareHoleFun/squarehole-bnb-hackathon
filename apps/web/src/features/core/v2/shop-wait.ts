/**
 * SH-300: a shop's wait for a new collection's gives, in words. The first release's shops wait 7, 14 or 30 days; the
 * second release's shop also takes ten minutes (600 s), so no line may assume whole days.
 */
import type { Hex } from 'viem';
import { shopConfigV2 } from '../../../../../../packages/chain/src/core/v2';

/** A shop's configuration as the spec holds it, or null when it does not decode (SH-300: nothing then shows a wait). */
export type ShopConfigV2 = ReturnType<typeof shopConfigV2>;
export function readShopConfigV2(contents: Hex): ShopConfigV2 | null {
  try {
    return shopConfigV2(contents);
  } catch {
    return null;
  }
}

/** The chain's field is a uint32 (seconds, ShopConfigV2.listDelay), so every wait fits a safe JavaScript number. */
const MINUTE = 60;
const HOUR = 3_600;
const DAY = 86_400;
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** A wait as set ("7 days", "10 minutes"); whole days, else whole hours, else whole minutes, else seconds. */
export function waitWords(seconds: number | bigint): string {
  const s = Number(seconds);
  if (s > 0 && s % DAY === 0) return plural(s / DAY, 'day');
  if (s > 0 && s % HOUR === 0) return plural(s / HOUR, 'hour');
  if (s > 0 && s % MINUTE === 0) return plural(s / MINUTE, 'minute');
  return plural(s, 'second');
}

/**
 * What is left until `at` (chain seconds), rounded up, in the smallest unit that stays under the next: minutes below an
 * hour, hours below a day, else days. A rounded-up 60 minutes reads "1 hour" and a rounded-up 24 hours "1 day".
 */
export function timeLeftWords(at: bigint, now: bigint): string {
  // In bigint throughout: a time far ahead (the chain's activation fields are uint64) never rounds down.
  const left = at > now ? at - now : 0n;
  const up = (unit: number) => (left + BigInt(unit) - 1n) / BigInt(unit);
  const count = (n: bigint, unit: string) => `${n} ${unit}${n === 1n ? '' : 's'}`;
  const minutes = up(MINUTE) > 1n ? up(MINUTE) : 1n;
  if (minutes < 60n) return count(minutes, 'minute');
  const hours = up(HOUR);
  if (hours < 24n) return count(hours, 'hour');
  return count(up(DAY), 'day');
}
