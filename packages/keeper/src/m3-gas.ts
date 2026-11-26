/** Operating floors for bounded maintenance, plus pending estimates and normal headroom.
 * Real-part probes in M3Calls.t.sol cover both EVMs. M3-60 owns full production worst-case calibration.
 * Seed loading/return revert atomically; these are transaction limits, not optional callback stipends. */
export const M3_GAS = {
  itemSync: 3_000_000n,
  itemResidue: 350_000n,
  pileLoadSeed: 1_000_000n,
  pileReturnSeed: 500_000n,
} as const;
