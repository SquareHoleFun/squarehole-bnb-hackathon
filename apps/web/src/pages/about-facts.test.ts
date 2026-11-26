import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GATE_CAP_SECONDS } from '../features/core/v2/v2-frozen';
import { DEADLINE_DAYS_V2, PICK_FEE_PRESETS } from '../features/create/v2/model';
import { ABOUT_FACTS, BOX0_BUY_SPLIT, BOX0_SELL_SPLIT, V2_CONTRACT_FACTS, V2_SPLIT, daysOf, minutesOf, percentOfBps, percentOfPips } from './about-facts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const solidity = (path: string) => readFileSync(join(ROOT, 'packages/contracts/src', path), 'utf8');
/** `uint256 internal constant NAME = value;` (or `private`), the value as written. */
const constant = (source: string, name: string): string | null => new RegExp(`constant ${name} = ([^;]+);`).exec(source)?.[1]?.trim() ?? null;

describe('About & risks figures (SH-V2-FE7)', () => {
  it('pins the core v2 values only the contracts hold to their Solidity constants', () => {
    const release = solidity('box-v2/interfaces/ReleaseConstantsV2.sol');
    expect(constant(release, 'FEE_SHARE_FIT_V2')).toBe(V2_CONTRACT_FACTS.fitShare.toString());
    expect(constant(release, 'FEE_SHARE_PLATFORM_V2')).toBe(V2_CONTRACT_FACTS.platformShare.toString());
    expect(constant(release, 'STEP_TICKS')).toBe(V2_CONTRACT_FACTS.stepTicks.toString());
    expect(constant(release, 'GRADUATION_ESCAPE_DELAY')).toBe('7 days');
    expect(V2_CONTRACT_FACTS.graduationHatchSeconds).toBe(7n * 86_400n);
    // RC5-A (F136): the coordinator has no claim period and no sweep, so the page names no claim deadline.
    const coordinator = solidity('box-v2/BoxCoordinatorV2.sol');
    expect(constant(coordinator, 'FAILURE_CLAIM_PERIOD')).toBeNull();
    expect(coordinator).not.toMatch(/function sweepAfterLastClaim|LatePotToFit|claimsSwept/);
    expect(coordinator).toContain('Claims use the live P balance, without expiry.');
    expect(V2_CONTRACT_FACTS).not.toHaveProperty('claimSeconds');
    expect(constant(release, 'FEE_PIPS')).toBe('10_000');
    // The creation flow's options and the open gate's cap, restated here so the page never imports the flow.
    expect(V2_CONTRACT_FACTS.deadlineDays).toEqual(DEADLINE_DAYS_V2);
    expect(V2_CONTRACT_FACTS.pickFeeBps).toEqual(PICK_FEE_PRESETS.map(BigInt));
    expect(V2_CONTRACT_FACTS.notOpenSeconds).toBe(GATE_CAP_SECONDS);
    // F213: the platform cap leaves every text, so the facts carry no cap figure (SH-245).
    expect(V2_CONTRACT_FACTS).not.toHaveProperty('v2PlatformCapWei');
    expect(ABOUT_FACTS).not.toHaveProperty('platformCap');
    expect(ABOUT_FACTS).not.toHaveProperty('v2PlatformCap');
  });

  it('splits each fee in fifteenths that add up to the whole', () => {
    for (const split of [V2_SPLIT, BOX0_BUY_SPLIT, BOX0_SELL_SPLIT]) expect(split.reduce((sum, part) => sum + part.fifteenths, 0n)).toBe(15n);
    expect(V2_SPLIT.map((part) => [part.key, part.fifteenths])).toEqual([['creator', 10n], ['fit', 2n], ['platform', 1n], ['pool', 2n]]);
    expect(BOX0_BUY_SPLIT.map((part) => part.fifteenths)).toEqual([11n, 2n, 2n]);
    expect(BOX0_SELL_SPLIT.map((part) => part.fifteenths)).toEqual([13n, 2n]);
  });

  it('formats every figure from bigint without rounding a charge down', () => {
    expect([percentOfBps(100n), percentOfBps(250n), percentOfBps(2500n), percentOfBps(500n), percentOfBps(5n)]).toEqual(['1%', '2.5%', '25%', '5%', '0.05%']);
    expect([percentOfPips(931_974), percentOfPips(80_565), percentOfPips(1_000_000)]).toEqual(['93.2%', '8.1%', '100.0%']);
    expect([minutesOf(384n), minutesOf(600n)]).toEqual(['6.4 min', '10 min']);
    expect(daysOf(1_209_600n)).toBe('14 d');
    expect(ABOUT_FACTS).toMatchObject({
      fee: '1%',
      raise: '4.206980085 ETH',
      window: '6.4 min',
      windowSteps: '32',
      stepSeconds: '12 s',
      taxFirst: '93.2%',
      taxLast: '8.1%',
      deadlineRange: '30–180 d',
      notOpen: '14 d',
      hatch: '7 d',
      claims: 'No expiry',
      stepTicks: '49',
      fitSupply: '1,000,000,000',
      draw: '1%',
      pick: '25%',
      giveBack: '5%',
      items: '10–10,000',
    });
    expect(ABOUT_FACTS.picks).toEqual(['1%', '5%', '25%']);
    expect(ABOUT_FACTS.taxTable).toHaveLength(32);
  });
});
