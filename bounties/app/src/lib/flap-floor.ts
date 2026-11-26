/**
 * SH-296: Flap's floor on the page. Flap's Portal refuses a pool below a minimum in USD (`liquidityFloor(raise,
 * poolToken, totalSupply, viaPortal)` answers (the pool's USD, the USD required)); Flap's test-network helper
 * (0x77779969a11eff7582f3bCf48135A846A3457777) scales that minimum for a launcher factory, to 0 for none, and anyone can
 * set it back (hackathon/evidence/SH-293.md). So the page reads it live:
 * - the smallest target Flap accepts now, under the target, in the sale's coin, checked by reads at that exact number
 *   (none: the page's own minimum);
 * - the default target follows it: a target a visitor can fill alone with what "Set me up" gave them when the floor
 *   allows it, today's defaults when it does not;
 * - before a buy that would launch the sale, the floor again: the Portal checks it at the launch, so a sale below it
 *   cannot launch and unwinds at its deadline.
 * Amounts shown: at most four decimals (cut for a plain amount; a minimum is rounded UP at the fourth decimal, because a
 * cut minimum would be a number Flap refuses).
 */
import type { Abi, Address } from 'viem';
import { curveFactoryAbi, curveLauncherAbi, flapPortalAbi } from '../abi/flap';
import { CREATE_DEFAULTS, readCreateForm, type CreateForm } from './flap';

/** The page's own smallest target in BNB, whatever Flap allows: 0.0002 BNB (about 0.14 USD at the Portal's price). */
export const PAGE_MIN_BNB = 200_000_000_000_000n;
/**
 * The small BNB default: 0.003 BNB, which a visitor fills alone with the 0.01 tBNB "Set me up" sends. Measured on a fork
 * of chain 97 at its own gas price (0.1 gwei, base fee 0; SH-296): creating through Flap's Portal costs 0.005065 BNB
 * (its 0.005 fee and the gas), leaving 0.004935; the launch then costs 0.00303 (the rest with its 1% curve fee) plus
 * about 0.00074 of gas, leaving 0.00117. A 0.005 BNB target would need 0.00505 plus gas and does not fit; the largest
 * that fits is about 0.0041. The curve keeps the entry's shape (virtual = target × 16 ÷ 2.35, as lane d's fork run
 * used).
 */
export const SMALL_BNB: Pick<CreateForm, 'target' | 'virtualBnb'> = Object.freeze({ target: '0.003', virtualBnb: '0.0204255319' });

/** A plain amount: at most four decimals, cut ("2.35", never "2.350000000000000001"). */
export function shortAmount(raw: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals);
  const whole = raw / unit;
  const fraction = (raw % unit).toString().padStart(decimals, '0').slice(0, 4).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
/** A minimum: at most four decimals, rounded up (so the number shown is one Flap accepts). */
export function shortMinimum(raw: bigint, decimals: number): string {
  if (decimals <= 4) return shortAmount(raw, decimals);
  const step = 10n ** BigInt(decimals - 4);
  return shortAmount(((raw + step - 1n) / step) * step, decimals);
}

/**
 * A first guess of the smallest target Flap accepts now: the target scaled by required ÷ pool, rounded up; never below
 * the page's own minimum. Only a guess: the required USD also moves with the pool's token side and the supply, which
 * move with the target. `exactMinimum` checks it by reads before anything is shown.
 */
export function smallestTarget(target: bigint, floor: readonly [bigint, bigint], pageMin: bigint): bigint {
  const [pool, required] = floor;
  if (required === 0n || pool === 0n) return pageMin;
  const scaled = (target * required + pool - 1n) / pool;
  return scaled > pageMin ? scaled : pageMin;
}

/** One step of a shown minimum: the fourth decimal of the coin (a minimum is shown with at most four decimals). */
export const minimumStep = (decimals: number): bigint => (decimals > 4 ? 10n ** BigInt(decimals - 4) : 1n);
const upToStep = (v: bigint, step: bigint): bigint => ((v + step - 1n) / step) * step;

/**
 * The smallest target, on the four-decimal grid and at or above the page's minimum, that Flap's floor accepts now, found
 * by reads: `probe(t)` answers the factory's `liquidityFloor` for a sale of target `t` (its curve's raise, pool tokens
 * and supply, as `checkConfig` and the form's floor line read them). A guess from required ÷ pool, then each answer
 * refines the next guess; it ends when a target passes and the one a step below fails (or is under the page's minimum).
 * The shown number is then accepted by the same read, and one step less is not. Undefined after `maxReads` without that
 * pair, so the page shows no number rather than an unchecked one.
 */
export async function exactMinimum(
  probe: (target: bigint) => Promise<readonly [bigint, bigint]>,
  start: { target: bigint; floor: readonly [bigint, bigint] },
  pageMin: bigint,
  step: bigint,
  maxReads = 8,
): Promise<bigint | undefined> {
  const least = upToStep(pageMin, step);
  const guess = (t: bigint, f: readonly [bigint, bigint]) => {
    const g = upToStep(smallestTarget(t, f, pageMin), step);
    return g < least ? least : g;
  };
  let lo: bigint | undefined; // the largest grid target known to fail
  let hi: bigint | undefined; // the smallest grid target known to pass
  let t = guess(start.target, start.floor);
  for (let reads = 0; reads < maxReads; reads++) {
    const f = await probe(t);
    if (belowFloor(f)) {
      lo = lo === undefined || t > lo ? t : lo;
    } else {
      hi = hi === undefined || t < hi ? t : hi;
    }
    if (hi !== undefined && (hi === least || (lo !== undefined && hi - lo <= step))) return hi;
    // The next target: the answer's own guess, kept strictly inside what is still unknown.
    let next = guess(t, f);
    if (lo !== undefined && next <= lo) next = lo + step;
    if (hi !== undefined && next >= hi) next = hi - step;
    if (lo !== undefined && hi !== undefined && (next <= lo || next >= hi)) next = lo + ((hi - lo) / step / 2n) * step;
    if (next === t) next = belowFloor(f) ? t + step : t - step;
    t = next < least ? least : next;
  }
  return undefined;
}

/**
 * The default target and depth Create shows, decided once (SH-296 round 3). The first floor answer for this factory
 * decides it, and nothing after that: the form then only changes when the visitor edits it, so what a press sends is
 * what the screen showed (a press locks the form). When that first answer arrives after the visitor has edited the
 * target or the depth, or while a press is under way, the form is left as it is. `set` is what to put in the form, or
 * null for nothing.
 */
export function decideDefault(s: {
  decided: boolean;
  touched: boolean;
  locked: boolean;
  smallAccepted: boolean | null;
}): { decided: boolean; set: Pick<CreateForm, 'target' | 'virtualBnb'> | null } {
  if (s.decided || s.smallAccepted === null) return { decided: s.decided, set: null };
  if (s.touched || s.locked) return { decided: true, set: null };
  return { decided: true, set: s.smallAccepted ? SMALL_BNB : { target: CREATE_DEFAULTS.target, virtualBnb: CREATE_DEFAULTS.virtualBnb } };
}

/** The default target of a BNB sale: the small one when Flap accepts it now, today's otherwise. */
export function defaultFor(smallAccepted: boolean): CreateForm {
  return smallAccepted ? { ...CREATE_DEFAULTS, ...SMALL_BNB } : CREATE_DEFAULTS;
}

/** The page's own refusal of a BNB target below its minimum (the form's line). */
export function belowPageMinimum(target: bigint, pageMin: bigint = PAGE_MIN_BNB, decimals = 18): string | null {
  return target < pageMin ? `At least ${shortMinimum(pageMin, decimals)}.` : null;
}

/**
 * The sale page's line when the sale is below Flap's minimum now. It says nothing about why (the multiplier, the
 * Portal's quote price and Flap's base floor all move it), and "now" because it can pass again; the second sentence is
 * the form's own for a deadline that passes first. As a refusal the press lowers its first letter ("Nothing was sent:
 * this sale is below …").
 */
export const FLOOR_ROSE = "This sale is below Flap's minimum now, so it cannot launch now. If the deadline passes first, buyers can take back what the sale holds for them.";

/** Whether a pool of this sale would be below Flap's floor now (the Portal refuses the launch then). */
export const belowFloor = (floor: readonly [bigint, bigint]): boolean => floor[0] < floor[1];

/** The page's own minimum target in the sale's coin: 0.0002 BNB, or 0.14 of a test dollar (the same USD, roughly). */
export const pageMinFor = (native: boolean, decimals: number): bigint => (native ? PAGE_MIN_BNB : (14n * 10n ** BigInt(decimals)) / 100n);

type FloorReader = { readContract(args: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }): Promise<unknown> };
/**
 * Whether `factory` (the one Create will use: the plain native factory, or the rules pair's launcher factory) accepts the
 * small BNB default now: its own `curveFor` and `liquidityFloor`, which reads the Portal's multiplier for THAT factory
 * (`launcherFactoryMultiplier(address(this))`; the helper sets it per factory). A read that fails counts as no.
 */
export async function smallAcceptedBy(c: FloorReader, factory: Address, fAbi: Abi, viaPortal: boolean): Promise<boolean> {
  const want = readCreateForm({ ...CREATE_DEFAULTS, ...SMALL_BNB }, 18);
  if (!want.ok) return false;
  try {
    const curve = (await c.readContract({ address: factory, abi: fAbi, functionName: 'curveFor', args: [want.config.saleTokens, want.config.targetRaise, want.config.virtualBnb] })) as readonly unknown[];
    const floor = (await c.readContract({ address: factory, abi: fAbi, functionName: 'liquidityFloor', args: [curve[1], curve[2], curve[3], viaPortal] })) as readonly [bigint, bigint];
    return !belowFloor(floor);
  } catch {
    return false;
  }
}

/**
 * Whether this sale's pool would be below Flap's floor if it launched now. The floor of the sale's OWN factory (the
 * launcher's `factory()`: a rules sale reads the rules pair's factory), and through the Portal or not as the sale was
 * made: the factory scales the floor by its multiplier only for a launcher the Portal created (`liquidityFloor`'s
 * `viaPortal`), and a sale made directly (`createLauncher`) meets the full floor at its launch. Which one it was is the
 * Portal's own record (the entry's FlapPortal ABI, `getLauncher(launcher)` returning `LauncherRecord { launcherFactory }`,
 * zeroed for a launcher the Portal did not create).
 */
export async function saleBelowFloor(c: FloorReader, launcher: Address): Promise<boolean> {
  const r = (fn: string) => c.readContract({ address: launcher, abi: curveLauncherAbi, functionName: fn });
  const [factory, raise, poolToken, totalSupply] = (await Promise.all([r('factory'), r('raiseTarget'), r('poolToken'), r('totalSupply')])) as [Address, bigint, bigint, bigint];
  const portal = (await c.readContract({ address: factory, abi: curveFactoryAbi, functionName: 'hub' })) as Address;
  const record = (await c.readContract({ address: portal, abi: flapPortalAbi, functionName: 'getLauncher', args: [launcher] })) as { launcherFactory: Address };
  const viaPortal = BigInt(record.launcherFactory) !== 0n;
  const floor = (await c.readContract({ address: factory, abi: curveFactoryAbi, functionName: 'liquidityFloor', args: [raise, poolToken, totalSupply, viaPortal] })) as readonly [bigint, bigint];
  return belowFloor(floor);
}
