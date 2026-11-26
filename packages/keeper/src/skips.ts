import { JOBS } from './jobs';
import type { Logger } from './log';

export const SKIP_LOG_SECONDS = 3_600n;
export type SkipLog = Readonly<Record<string, { readonly at: bigint; readonly repeats: number }>>;

/** Start codes are reserved for part B; no start admission is implemented here. */
export const DEFERRAL_CODES = [
  'BOX_INCOME_CAP', 'PLATFORM_INCOME_CAP', 'INCOME_UNAVAILABLE', 'VALUATION_UNAVAILABLE', 'PIN_INVALID',
  'INCOME_CAPACITY', 'START_UNPAID', 'START_TIP_TOO_SMALL', 'START_COST_CAP', 'GAS_ADMISSION', 'FEE_CAP',
  'DAILY_TOTAL', 'DAILY_OURS', 'RATE_LIMIT', 'UNBLOCKING_LIMIT', 'NO_PRIVATE_ENDPOINT', 'SIMULATION_ERROR',
  'SEND_ERROR', 'NO_WORK', 'SLOT_TAKEN', 'OTHER',
] as const;
export type DeferralCode = typeof DEFERRAL_CODES[number];
const codes: ReadonlySet<string> = new Set(DEFERRAL_CODES);
const reasons: Readonly<Record<string, DeferralCode>> = Object.freeze({
  'start unpaid': 'START_UNPAID', 'start tip too small': 'START_TIP_TOO_SMALL', 'start cost cap': 'START_COST_CAP',
  'box income cap': 'BOX_INCOME_CAP', 'platform income cap': 'PLATFORM_INCOME_CAP',
  'income unavailable': 'INCOME_UNAVAILABLE', 'fee ceiling reached': 'FEE_CAP', 'gas price unread': 'FEE_CAP',
  'daily ceiling reached': 'DAILY_TOTAL', 'ours budget spent': 'DAILY_OURS',
  'rate limit': 'RATE_LIMIT', 'unconfirmed transactions at limit': 'RATE_LIMIT', 'takeover no longer open': 'RATE_LIMIT',
  'in flight': 'SLOT_TAKEN', 'no private endpoint': 'NO_PRIVATE_ENDPOINT',
  'simulation error': 'SIMULATION_ERROR', 'send error': 'SEND_ERROR',
  'nothing to do': 'NO_WORK', 'waited': 'NO_WORK', 'failed': 'NO_WORK', 'reverted': 'NO_WORK',
  'slot taken': 'SLOT_TAKEN', 'round posted this tick': 'SLOT_TAKEN', 'round post pending': 'SLOT_TAKEN',
  'round backup starting this tick': 'SLOT_TAKEN',
  'unblocking box unavailable': 'UNBLOCKING_LIMIT', 'box unblocking gas allowance spent': 'UNBLOCKING_LIMIT',
  'box unblocking wei spent': 'UNBLOCKING_LIMIT', 'unblocking wei spent': 'UNBLOCKING_LIMIT',
  'gas admission: invalid estimate, floor or destination limit': 'GAS_ADMISSION',
  'gas admission: invalid fork transaction cap': 'GAS_ADMISSION',
  'gas admission: invalid or missing state gas estimate': 'GAS_ADMISSION',
  'gas admission: estimate exceeds destination limit': 'GAS_ADMISSION',
  'gas admission: required floor exceeds destination limit': 'GAS_ADMISSION',
});
export function deferralCode(value: unknown): DeferralCode {
  if (typeof value !== 'string') return 'OTHER';
  return codes.has(value) ? value as DeferralCode : Object.hasOwn(reasons, value) ? reasons[value] ?? 'OTHER' : 'OTHER';
}

const jobs: ReadonlySet<string> = new Set([...JOBS.map(j => j.name), 'income']);
export function safeBoxId(value: unknown): string {
  const id = typeof value === 'bigint' ? value.toString() : value;
  return typeof id === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(id) && BigInt(id) < 1n << 256n ? id : 'unknown';
}
export function safeDeferral(data: Record<string, unknown>) {
  return {
    boxId: safeBoxId(data.boxId),
    job: typeof data.job === 'string' && jobs.has(data.job) ? data.job : 'unknown',
    code: deferralCode(data.code),
    repeats: typeof data.repeats === 'number' && Number.isSafeInteger(data.repeats) && data.repeats >= 0 ? data.repeats : 0,
  };
}
/** Both service log levels use this formatter; only the four validated fields reach stderr. */
export function formatDeferral(data: Record<string, unknown> = {}): string {
  const s = safeDeferral(data);
  return `keeper: box=${s.boxId} job=${s.job} reason=${s.code} repeats=${s.repeats}`;
}
export interface Deferral {
  readonly boxId?: bigint;
  readonly job: string;
  readonly code: DeferralCode;
}

/** Each box/job/code logs at most once per hour. Old journal keys remain readable but cannot supply log text. */
export function logSkips(prev: SkipLog | undefined, skipped: readonly Deferral[], now: bigint, log: Logger): SkipLog {
  const rows = skipped.map(s => safeDeferral({ ...s, repeats: 0 }));
  const idOf = (s: ReturnType<typeof safeDeferral>) => `${s.boxId}|${s.job}|${s.code}`;
  const active = new Set(rows.map(idOf));
  const next = new Map(Object.entries(prev ?? {}).filter(([key, last]) => active.has(key) || now - last.at < SKIP_LOG_SECONDS));
  for (const s of rows) {
    const id = idOf(s), last = next.get(id);
    if (last && now - last.at < SKIP_LOG_SECONDS) {
      next.set(id, { ...last, repeats: Math.min(Number.MAX_SAFE_INTEGER, last.repeats + 1) });
      continue;
    }
    const data = { ...s, repeats: last?.repeats ?? 0 };
    if (s.code === 'NO_WORK' || s.code === 'SLOT_TAKEN') log.info('skipped', data);
    else log.warn('skipped', data);
    next.set(id, { at: now, repeats: 0 });
  }
  return Object.freeze(Object.fromEntries(next));
}
