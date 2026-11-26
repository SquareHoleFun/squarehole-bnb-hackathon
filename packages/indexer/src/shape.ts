/**
 * Launch shapes as the contracts hard-code them (`packages/contracts/src/v2/genesis/FitLaunchShape.sol`, F23 C4,
 * ADR-0013 § 2.2) and the launch-window tax table (`LaunchTaxRouter.taxTable()`, F33). Copied, not derived: the tests
 * recompute every derived value from the ported v4 math (`v4-math.test.ts`) and compare the tax table with the table
 * the live Sepolia router returns (recorded fixture).
 *
 * Two shapes on the same ticks: `REHEARSAL_SHAPE`, the one the live Sepolia route rehearsal was deployed with (and the
 * only pool this service follows today), and `MISFITS_LAUNCH_SHAPE`, `FitLaunchShape` since F40 (L6), whose curve
 * raises exactly the target. A deployed pool keeps its shape for good.
 *
 * The pool is native ETH (currency0) / token (currency1). A buy moves the tick DOWN, from the upper edge (start price)
 * to the lower edge (completion price).
 */
export interface LaunchShape {
  readonly issuance: bigint;
  readonly curveTokens: bigint;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly sqrtPriceLowerX96: bigint;
  readonly sqrtPriceUpperX96: bigint;
  readonly liquidity: bigint;
  readonly curveTokensDeposited: bigint;
  readonly curveRaiseWei: bigint;
  readonly bootstrapWei: bigint;
  readonly lpFeePips: number;
  readonly tickSpacing: number;
  readonly windowBlocks: number;
}

/**
 * The Sepolia route rehearsal as deployed on 2026-09-30 (genesis block 11,811,774; `FitLaunchShape` at main `3baefb8`,
 * before F40 L6): 80% of the token on the curve, which raises 4.216794836692248391 ETH, 0.23% above the target.
 */
export const REHEARSAL_SHAPE: LaunchShape = Object.freeze({
  issuance: 10n ** 27n,
  curveTokens: 800_000_000n * 10n ** 18n,
  tickLower: 177_180,
  tickUpper: 204_060,
  sqrtPriceLowerX96: 557_316_679_617_586_024_814_736_431_134_799n,
  sqrtPriceUpperX96: 2_136_803_773_902_134_283_171_573_647_428_656n,
  liquidity: 40_128_552_009_550_614_593_458n,
  curveTokensDeposited: 799_999_999_999_999_999_999_989_841n,
  /** ETH the range holds once fully crossed, rounded down: getAmount0Delta(lower, upper, L, false). */
  curveRaiseWei: 4_216_794_836_692_248_391n,
  bootstrapWei: 1_500_000_000_000_000n,
  lpFeePips: 10_000,
  tickSpacing: 60,
  windowBlocks: 32,
});

/**
 * The band's target (BOX-SYSTEM § 4.1; ADR-0013's R, F15 D5, ADR-0014 G02): 4.206980085 ETH. The manifest carries it
 * for the Misfits launch; the rehearsal has no manifest, so the same value is configured here.
 */
export const BAND_TARGET_WEI = 4_206_980_085_000_000_000n;

/**
 * `FitLaunchShape` since F40 (L6): the same ticks, prices and k; the smallest liquidity whose fully crossed range holds
 * exactly the target, and exactly the tokens that liquidity takes (798,137,969.320803416571965883, ≈ 79.81%; no dust).
 * So the curve's completion price and the band's 100% are the same point.
 */
export const MISFITS_LAUNCH_SHAPE: LaunchShape = Object.freeze({
  issuance: 10n ** 27n,
  curveTokens: 798_137_969_320_803_416_571_965_883n,
  tickLower: 177_180,
  tickUpper: 204_060,
  sqrtPriceLowerX96: 557_316_679_617_586_024_814_736_431_134_799n,
  sqrtPriceUpperX96: 2_136_803_773_902_134_283_171_573_647_428_656n,
  liquidity: 40_035_151_265_858_715_901_343n,
  curveTokensDeposited: 798_137_969_320_803_416_571_965_883n,
  /** ETH the range holds once fully crossed, rounded down: exactly the target. */
  curveRaiseWei: BAND_TARGET_WEI,
  bootstrapWei: 1_500_000_000_000_000n,
  lpFeePips: 10_000,
  tickSpacing: 60,
  windowBlocks: 32,
});

/** `LaunchTaxRouter.taxTable()`: tax in pips (10^6 = 100%) for blocks openBlock + 0 … openBlock + 31. */
export const LAUNCH_TAX_TABLE_PIPS: readonly number[] = Object.freeze([
  931_974, 926_013, 919_530, 912_479, 904_810, 896_469, 887_397, 877_531, 866_799, 855_128, 842_433, 828_627, 813_610,
  797_278, 779_515, 760_195, 739_182, 716_328, 691_472, 664_437, 635_033, 603_054, 568_271, 530_441, 489_297, 444_547,
  395_875, 342_939, 285_365, 222_745, 154_639, 80_565,
]);

export const PIPS = 1_000_000;

/** The router's tax for a block `offset` blocks after the open; 0 outside the window (LaunchTaxRouter.taxPips). */
export function taxPipsAt(offset: bigint): number {
  if (offset < 0n || offset >= BigInt(LAUNCH_TAX_TABLE_PIPS.length)) return 0;
  return LAUNCH_TAX_TABLE_PIPS[Number(offset)] ?? 0;
}
