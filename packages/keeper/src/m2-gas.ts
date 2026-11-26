/** FINAL2-GAS remeasures independent liquid/claims caps at 1.25M/2.5M after shared BURN_GAS changes.
 * NFT_RETURN_GAS=800k + 200k reserve.
 * These transaction floors preserve optional-call activation (including EIP-150 and 20k overhead).
 * M2-31's measured transfer/notice thresholds are NOT settlement/payout estimates.
 * The sum of both burn caps, EIP-150, two 220k reserves and outer work still fits 5M.
 * Stipend tests retain 5M burn and 2M return on both EVMs; FINAL-ACCESS-G01 pins recovery.
 * Pending estimates plus normal headroom may exceed every floor. */
export const M2_GAS = {
  holderSettle: 3_000_000n, // sixteen notice/holder pairs, including cold credit writes
  holderResidue: 350_000n,
  shopBurn: 5_000_000n, // both 1.25M/2.5M burns + EIP-150/reserve and exhaustion continuation
  shopReturn: 2_000_000n, // one isolated NFT; exceeds the 1,032,698 inner admission floor plus outer work
} as const;
