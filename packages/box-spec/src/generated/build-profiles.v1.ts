// GENERATED FILE, do not edit: packages/box-spec/scripts/generate.mjs writes it from packages/box-spec/build-profiles.v1.json
// (`pnpm box-spec:write`); `pnpm check:box-spec` (in `pnpm verify`) fails when stale. Twin of
// packages/contracts/src/box/build/<profile>/BoxBuildV1.sol.

/** The build profiles of core v1 (F78). F78 (DECISION-LOG, 2026-10-04): the build profiles of core v1. `mainnet` is the reviewed build and the default; `rehearsal` is a testnet build whose raise and fixed ETH amounts are 1/10, so a curve fills with about 0.43 SepETH instead of 4.25. */
export type BuildProfileName = 'mainnet' | 'rehearsal';

/** The values a build takes from its profile (BoxBuildV1.sol). */
export type BuildScaledName = 'RAISE' | 'BOOTSTRAP_ETH' | 'FEE_BATCH_MIN_ETH' | 'FEE_BATCH_TIP_MAX_ETH' | 'SWAP_STEP_MIN_Q' | 'DEPTH_CONVERT_MIN_Q' | 'PLATFORM_CAP_WEI' | 'CREATOR_FEE_CAP_PRESET_0' | 'CREATOR_FEE_CAP_PRESET_1' | 'CREATOR_FEE_CAP_PRESET_2' | 'CREATOR_FEE_CAP_PRESET_3' | 'CREATOR_FEE_CAP_PRESET_4';

export interface BuildProfile {
  readonly name: BuildProfileName;
  /** FOUNDRY_PROFILE that builds it (`default`: none set). */
  readonly foundryProfile: string;
  readonly rehearsal: boolean;
  /** Chain ids its contracts refuse in their constructors. */
  readonly refusedChainIds: readonly number[];
  readonly scaleNumerator: bigint;
  readonly scaleDenominator: bigint;
  readonly values: Readonly<Record<BuildScaledName, bigint>>;
}

export const BUILD_SCALED_NAMES: readonly BuildScaledName[] = ['RAISE', 'BOOTSTRAP_ETH', 'FEE_BATCH_MIN_ETH', 'FEE_BATCH_TIP_MAX_ETH', 'SWAP_STEP_MIN_Q', 'DEPTH_CONVERT_MIN_Q', 'PLATFORM_CAP_WEI', 'CREATOR_FEE_CAP_PRESET_0', 'CREATOR_FEE_CAP_PRESET_1', 'CREATOR_FEE_CAP_PRESET_2', 'CREATOR_FEE_CAP_PRESET_3', 'CREATOR_FEE_CAP_PRESET_4'];

/** The reviewed build: mainnet's box 0 and the full-size Sepolia rehearsal (the profile may still be deployed on Sepolia). */
export const BUILD_PROFILE_MAINNET: BuildProfile = {
  name: 'mainnet',
  foundryProfile: 'default',
  rehearsal: false,
  refusedChainIds: [],
  scaleNumerator: 1n,
  scaleDenominator: 1n,
  values: {
    RAISE: 4206980085000000000n,
    BOOTSTRAP_ETH: 1500000000000000n,
    FEE_BATCH_MIN_ETH: 5000000000000000n,
    FEE_BATCH_TIP_MAX_ETH: 500000000000000n,
    SWAP_STEP_MIN_Q: 5000000000000000n,
    DEPTH_CONVERT_MIN_Q: 5000000000000000n,
    PLATFORM_CAP_WEI: 32000000000000000000n,
    CREATOR_FEE_CAP_PRESET_0: 1000000000000000000n,
    CREATOR_FEE_CAP_PRESET_1: 4000000000000000000n,
    CREATOR_FEE_CAP_PRESET_2: 8000000000000000000n,
    CREATOR_FEE_CAP_PRESET_3: 16000000000000000000n,
    CREATOR_FEE_CAP_PRESET_4: 32000000000000000000n,
  },
};

/** F78: testnets only. The raise and the six fixed ETH amounts at 1/10 (and the creator-fee cap's presets, version 2 only); every other value as mainnet's. Its factory, planner and implementations refuse chain id 1 in their constructors (RehearsalBuildRefusesChain), and script/DeployCoreV1.s.sol refuses it on mainnet. */
export const BUILD_PROFILE_REHEARSAL: BuildProfile = {
  name: 'rehearsal',
  foundryProfile: 'rehearsal',
  rehearsal: true,
  refusedChainIds: [1],
  scaleNumerator: 1n,
  scaleDenominator: 10n,
  values: {
    RAISE: 420698008500000000n,
    BOOTSTRAP_ETH: 150000000000000n,
    FEE_BATCH_MIN_ETH: 500000000000000n,
    FEE_BATCH_TIP_MAX_ETH: 50000000000000n,
    SWAP_STEP_MIN_Q: 500000000000000n,
    DEPTH_CONVERT_MIN_Q: 500000000000000n,
    PLATFORM_CAP_WEI: 3200000000000000000n,
    CREATOR_FEE_CAP_PRESET_0: 100000000000000000n,
    CREATOR_FEE_CAP_PRESET_1: 400000000000000000n,
    CREATOR_FEE_CAP_PRESET_2: 800000000000000000n,
    CREATOR_FEE_CAP_PRESET_3: 1600000000000000000n,
    CREATOR_FEE_CAP_PRESET_4: 3200000000000000000n,
  },
};

export const BUILD_PROFILES: Readonly<Record<BuildProfileName, BuildProfile>> = {
  mainnet: BUILD_PROFILE_MAINNET,
  rehearsal: BUILD_PROFILE_REHEARSAL,
};
