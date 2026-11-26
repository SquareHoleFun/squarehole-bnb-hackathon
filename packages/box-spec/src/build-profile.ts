/**
 * Build profiles (F78): a version context as a given build of core v1 checks it. The rehearsal build's raise is 1/10 of
 * mainnet's, so its contexts list the scaled raise where mainnet's list the reviewed one (BoxSpecV1.sol reads the raise
 * preset from BoxBuildV1.RAISE; the generated CONTEXT_V1 / CONTEXT_V2 here are the mainnet build's).
 *
 * It maps the raise only: add-on 5's creator-fee-cap presets stay mainnet's (OFFERED_AMOUNTS, the twin's
 * checkCreatorFeeCap), while the rehearsal build's BoxSpecV1 reads its own 1/10 presets
 * (BoxBuildV1.CREATOR_FEE_CAP_PRESET_0 to _4), so on that build the twin and validate() disagree on add-on 5. Version 2
 * only (factory v1 creates box 0 under version 1), testnet only; the presets follow the build when version 2's creation
 * page goes to Sepolia (box 0's own review W3-U9-2, FQ-35, F147).
 */
import type { VersionContext } from './generated/box-spec.v1';
import { BUILD_PROFILE_MAINNET, type BuildProfile } from './generated/build-profiles.v1';

const NATIVE_ETH = '0x0000000000000000000000000000000000000000';

/** `ctx` as `profile`'s build checks it: each native-ETH raise preset equal to mainnet's raise becomes the profile's. */
export function contextForBuild(ctx: VersionContext, profile: BuildProfile): VersionContext {
  const from = BUILD_PROFILE_MAINNET.values.RAISE;
  const to = profile.values.RAISE;
  return {
    ...ctx,
    qList: ctx.qList.map((q) =>
      q.token.toLowerCase() === NATIVE_ETH ? { ...q, raisePresets: q.raisePresets.map((p) => (p === from ? to : p)) } : q,
    ),
  };
}

/** `wei` (a mainnet amount) at `profile`'s scale; exact for every value the profiles scale (the generator checks it). */
export function scaleForBuild(wei: bigint, profile: BuildProfile): bigint {
  return (wei * profile.scaleNumerator) / profile.scaleDenominator;
}
