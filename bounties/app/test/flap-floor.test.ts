/**
 * SH-296: Flap's floor on the page: the smallest target shown, the default that follows the floor, the page's own
 * minimum, and a sale below the floor refused before its completing buy.
 */
import { describe, expect, it } from 'vitest';
import { CREATE_DEFAULTS, readCreateForm } from '../src/lib/flap';
import type { Address } from 'viem';
import { curveFactoryAbi } from '../src/abi/flap';
import { belowPageMinimum, decideDefault, defaultFor, exactMinimum, FLOOR_ROSE, minimumStep, pageMinFor, PAGE_MIN_BNB, saleBelowFloor, shortAmount, shortMinimum, smallAcceptedBy, SMALL_BNB, smallestTarget } from '../src/lib/flap-floor';

const E18 = 10n ** 18n;
describe('the first guess of the smallest target', () => {
  it('scales the target by required over pool, rounded up (a guess: exactMinimum checks it)', () => {
    // lane d's measure (SH-293): 2.35 BNB gives a pool of 1,645 USD against 1,610.16 USD required.
    const min = smallestTarget(235n * 10n ** 16n, [1645n * E18, 161016n * 10n ** 16n], PAGE_MIN_BNB);
    expect(shortMinimum(min, 18)).toBe('2.3003');
    expect(min * 1645n * E18 >= 235n * 10n ** 16n * 161016n * 10n ** 16n).toBe(true);
  });
  it('no floor (required 0): the page\'s own minimum, 0.0002 BNB (0.14 of a test dollar)', () => {
    expect(shortMinimum(smallestTarget(5n * 10n ** 15n, [3n * E18, 0n], PAGE_MIN_BNB), 18)).toBe('0.0002');
    expect(shortMinimum(pageMinFor(false, 18), 18)).toBe('0.14');
  });
  it('never below the page\'s minimum, even under a low floor', () => {
    expect(smallestTarget(10n ** 15n, [10n * E18, 1n], PAGE_MIN_BNB)).toBe(PAGE_MIN_BNB);
  });
});

describe('the default target follows the floor', () => {
  it('accepted: 0.003 BNB with the entry\'s curve shape; not accepted: today\'s 2.35', () => {
    expect([defaultFor(true).target, defaultFor(true).virtualBnb]).toEqual(['0.003', '0.0204255319']);
    expect(defaultFor(false)).toEqual(CREATE_DEFAULTS);
    const small = readCreateForm(defaultFor(true), 18);
    expect(small.ok).toBe(true);
    if (small.ok) expect(Number(small.config.virtualBnb) / Number(small.config.targetRaise)).toBeCloseTo(16 / 2.35, 6);
  });
  it('the page refuses a BNB target below 0.0002 BNB, and lets 0.0002 through', () => {
    expect(belowPageMinimum(PAGE_MIN_BNB - 1n)).toBe('At least 0.0002.');
    expect(belowPageMinimum(PAGE_MIN_BNB)).toBeNull();
    expect(SMALL_BNB.target).toBe('0.003');
  });
});

describe('amounts', () => {
  it('a plain amount is cut at four decimals; a minimum rounds up there', () => {
    expect([shortAmount(2_350_000_000_000_000_001n, 18), shortMinimum(2_350_000_000_000_000_001n, 18), shortMinimum(23_018_000_000_000_000_00n, 18)]).toEqual(['2.35', '2.3501', '2.3018']);
  });
});

describe('the minimum shown is checked by reads (exactMinimum)', () => {
  const step = minimumStep(18);
  // Models of the factory's floor where the required USD moves with the target (through the pool's token side and the
  // supply), so required over pool alone is off: rising, falling, and a pool that sits a millionth below the target.
  const rising = async (t: bigint) => [t * 700n, 161016n * 10n ** 16n + t * 7n] as const;
  const falling = async (t: bigint) => [t * 700n, 1700n * E18 - t * 30n] as const;
  const hair = async (t: bigint) => [(t - t / 1_000_000n) * 700n, 161016n * 10n ** 16n] as const;
  for (const [name, probe] of [['rising', rising], ['falling', falling], ['a pool a millionth below', hair]] as const) {
    it(`${name}: the shown number passes, one step below fails, in a few reads`, async () => {
      let reads = 0;
      const counted = async (t: bigint) => {
        reads++;
        return probe(t);
      };
      const start = 235n * 10n ** 16n;
      const min = await exactMinimum(counted, { target: start, floor: await probe(start) }, PAGE_MIN_BNB, step);
      expect(min).toBeDefined();
      expect(min! % step).toBe(0n);
      const [poolAt, reqAt] = await probe(min!);
      expect(poolAt >= reqAt).toBe(true);
      const [poolBelow, reqBelow] = await probe(min! - step);
      expect(poolBelow < reqBelow).toBe(true);
      expect(reads).toBeLessThanOrEqual(6);
    });
  }
  it('the guess of required over pool would have been wrong here (SH-293 measured 2.3018 where the guess said 2.3003)', async () => {
    const start = 235n * 10n ** 16n;
    // Here the required USD falls as the target grows: the guess comes out a few steps low, and Flap refuses it.
    const guessed = (smallestTarget(start, await falling(start), PAGE_MIN_BNB) + step - 1n) / step * step;
    const exact = await exactMinimum(falling, { target: start, floor: await falling(start) }, PAGE_MIN_BNB, step);
    expect(guessed < exact!).toBe(true);
    const [p, r] = await falling(guessed);
    expect(p < r).toBe(true);
  });
  it('no floor: the page\'s own minimum after one read', async () => {
    let reads = 0;
    const none = async (t: bigint) => {
      reads++;
      return [t * 700n, 0n] as const;
    };
    expect(await exactMinimum(none, { target: 3n * 10n ** 15n, floor: [21n * 10n ** 17n, 0n] }, PAGE_MIN_BNB, step)).toBe(PAGE_MIN_BNB);
    expect(reads).toBe(1);
  });
  it('no pair found within its reads: no number at all', async () => {
    const never = async (t: bigint) => [t, t + 1n] as const;
    expect(await exactMinimum(never, { target: E18, floor: [E18, E18 + 1n] }, PAGE_MIN_BNB, step, 4)).toBeUndefined();
  });
});

describe('the default is decided once and never moves under a press', () => {
  it('the first answer decides; a later answer changes nothing', () => {
    const first = decideDefault({ decided: false, touched: false, locked: false, smallAccepted: true });
    expect(first).toEqual({ decided: true, set: SMALL_BNB });
    expect(decideDefault({ decided: true, touched: false, locked: false, smallAccepted: false })).toEqual({ decided: true, set: null });
  });
  it('an answer that flips during a press: the screen and what is sent stay as they were', () => {
    // The page's form as the effect would leave it after each answer; the press sends the form it locked.
    let form = { ...CREATE_DEFAULTS };
    let decided = false;
    const answer = (smallAccepted: boolean, locked: boolean) => {
      const next = decideDefault({ decided, touched: false, locked, smallAccepted });
      decided = next.decided;
      if (next.set) form = { ...form, ...next.set };
    };
    answer(true, false);
    expect(form.target).toBe('0.003');
    const sent = readCreateForm(form, 18);
    const shown = { ...form };
    answer(false, true); // the floor is back at full while the wallet window is open
    answer(true, true);
    expect(form).toEqual(shown);
    expect(readCreateForm(form, 18)).toEqual(sent);
  });
  it('a first answer that arrives during a press, or after the visitor\'s own edit, leaves the form as it is', () => {
    expect(decideDefault({ decided: false, touched: false, locked: true, smallAccepted: true })).toEqual({ decided: true, set: null });
    expect(decideDefault({ decided: false, touched: true, locked: false, smallAccepted: false })).toEqual({ decided: true, set: null });
    expect(decideDefault({ decided: false, touched: false, locked: false, smallAccepted: null })).toEqual({ decided: false, set: null });
  });
});

/**
 * A small model of the chain: the Portal's multiplier per launcher factory (Flap's helper sets it per factory; a factory
 * nobody set is at the full floor), the Portal's record of the launchers it created (`getLauncher`, zero for a launcher
 * made directly), and each factory's liquidityFloor scaled by ITS entry and only for `viaPortal`, as
 * CurveLauncherFactory.sol:173-175 and RulesCurveLauncherFactory.sol:175-177 do.
 */
const PORTAL: Address = '0x0000000000000000000000000000000000000Ff0';
const ZERO: Address = '0x0000000000000000000000000000000000000000';
const PLAIN: Address = '0x00000000000000000000000000000000000000a1';
const RULES: Address = '0x00000000000000000000000000000000000000b2';
const USD_PER_BNB = 700n;
const FULL_USD = 161016n * 10n ** 16n;
type Sale = { factory: Address; viaPortal: boolean; raise: bigint };
function chainWith(multiplier: Record<Address, number | undefined>, sales: Record<Address, Sale>) {
  const asked: { factory: Address; viaPortal: boolean }[] = [];
  const reader = {
    readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args?: readonly unknown[] }) => {
      if (functionName === 'curveFor') return [0n, args?.[1], 1n, 2n];
      if (functionName === 'hub') return PORTAL;
      if (functionName === 'getLauncher') {
        const sale = sales[args?.[0] as Address];
        return { launcherFactory: sale?.viaPortal ? sale.factory : ZERO };
      }
      if (functionName === 'liquidityFloor') {
        const viaPortal = args?.[3] as boolean;
        asked.push({ factory: address, viaPortal });
        const m = multiplier[address];
        const required = viaPortal && m !== undefined && m < 10_000 ? (FULL_USD * BigInt(m)) / 10_000n : FULL_USD;
        return [(args?.[0] as bigint) * USD_PER_BNB, required];
      }
      const sale = sales[address]!;
      const answers: Record<string, unknown> = { factory: sale.factory, raiseTarget: sale.raise, poolToken: 1n, totalSupply: 2n };
      return answers[functionName];
    },
  };
  return { reader, asked };
}

describe('a sale below the floor before its completing buy', () => {
  const S: Address = '0x00000000000000000000000000000000000000c3';
  it('below: refused, with the line; at or above: not', async () => {
    const low = chainWith({ [PLAIN]: undefined }, { [S]: { factory: PLAIN, viaPortal: true, raise: 5n * 10n ** 15n } });
    expect(await saleBelowFloor(low.reader, S)).toBe(true);
    const none = chainWith({ [PLAIN]: 0 }, { [S]: { factory: PLAIN, viaPortal: true, raise: 5n * 10n ** 15n } });
    expect(await saleBelowFloor(none.reader, S)).toBe(false);
  });
  it('the line says what is true in every state, and reads right after the press lowers its first letter', () => {
    expect(FLOOR_ROSE).toBe("This sale is below Flap's minimum now, so it cannot launch now. If the deadline passes first, buyers can take back what the sale holds for them.");
    expect(FLOOR_ROSE).not.toMatch(/went up/);
    const lowered = FLOOR_ROSE.charAt(0).toLowerCase() + FLOOR_ROSE.slice(1).replace(/\.$/, '');
    expect(`Nothing was sent: ${lowered}`).toMatch(/^Nothing was sent: this sale is below Flap's minimum now/);
  });
});

describe('a sale made directly (not through the Portal) meets the full floor at its launch', () => {
  const DIRECT: Address = '0x00000000000000000000000000000000000000d1';
  const VIA: Address = '0x00000000000000000000000000000000000000d2';
  it('under a multiplier of 0: the Portal\'s sale is not below, the direct one is; each read with its own viaPortal', async () => {
    const small = 5n * 10n ** 16n; // 0.05 BNB: 35 USD against the full 1,610.16
    const { reader, asked } = chainWith({ [PLAIN]: 0 }, { [DIRECT]: { factory: PLAIN, viaPortal: false, raise: small }, [VIA]: { factory: PLAIN, viaPortal: true, raise: small } });
    expect(await saleBelowFloor(reader, VIA)).toBe(false);
    expect(await saleBelowFloor(reader, DIRECT)).toBe(true);
    expect(asked).toEqual([
      { factory: PLAIN, viaPortal: true },
      { factory: PLAIN, viaPortal: false },
    ]);
  });
});

describe('each factory answers with its own multiplier (a rules sale reads the rules factory)', () => {
  const PLAIN_SALE: Address = '0x00000000000000000000000000000000000000c3';
  const RULES_SALE: Address = '0x00000000000000000000000000000000000000d4';
  const sales = { [PLAIN_SALE]: { factory: PLAIN, viaPortal: true, raise: 3n * 10n ** 15n }, [RULES_SALE]: { factory: RULES, viaPortal: true, raise: 3n * 10n ** 15n } };
  it('Create: the small default is offered by the factory whose multiplier is 0, not by the other', async () => {
    const { reader, asked } = chainWith({ [PLAIN]: 0, [RULES]: undefined }, sales);
    expect(await smallAcceptedBy(reader, PLAIN, curveFactoryAbi, true)).toBe(true);
    expect(await smallAcceptedBy(reader, RULES, curveFactoryAbi, true)).toBe(false);
    expect(asked.map((a) => a.factory)).toEqual([PLAIN, RULES]);
    const flipped = chainWith({ [PLAIN]: 10_000, [RULES]: 0 }, sales);
    expect(await smallAcceptedBy(flipped.reader, PLAIN, curveFactoryAbi, true)).toBe(false);
    expect(await smallAcceptedBy(flipped.reader, RULES, curveFactoryAbi, true)).toBe(true);
  });
  it('the sale page: each sale reads its launcher\'s own factory', async () => {
    const { reader, asked } = chainWith({ [PLAIN]: 0, [RULES]: 10_000 }, sales);
    expect(await saleBelowFloor(reader, PLAIN_SALE)).toBe(false);
    expect(await saleBelowFloor(reader, RULES_SALE)).toBe(true);
    expect(asked.map((a) => a.factory)).toEqual([PLAIN, RULES]);
  });
});
