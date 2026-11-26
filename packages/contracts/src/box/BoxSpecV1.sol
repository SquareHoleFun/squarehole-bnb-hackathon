// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// GENERATED FILE, do not edit: packages/box-spec/scripts/generate.mjs writes it from packages/box-spec/box-spec.v1.json
// and packages/box-spec/add-ons.v1.json (`pnpm box-spec:write`); `pnpm check:box-spec` (in `pnpm verify`) fails when stale.

// The build profile (F78; packages/box-spec/build-profiles.v1.json): the raise and the fixed ETH amounts. foundry.toml maps
// `sh-box-build/` to src/box/build/mainnet/ (default) or src/box/build/rehearsal/ (FOUNDRY_PROFILE=rehearsal).
import {BoxBuildV1} from "sh-box-build/BoxBuildV1.sol";

/// @title BoxSpecV1
/// @notice The BoxSpec wire format (launch pipeline v1 § 1, slice S1): the struct, its fixed values, `validate()` and
/// `specHash()`. The TypeScript twin is packages/box-spec/src/generated/box-spec.v1.ts; both run the shared vectors
/// test/vectors/box-spec/box-spec-v1.json (BC-001). Nothing on chain calls it yet: the factory is slice S7.
/// @dev Every enum is a uint8 on the wire (0 is never a member), so a bad value decodes and is refused with a reason.
/// `validate()` returns the first failing (reason, field) in the source order: fields, then each add-on, then rules.
library BoxSpecV1 {
    // ------------------------------------------------------------------------------------------- fixed values
    /// @dev this file (S1)
    uint16 internal constant SPEC_FORMAT_VERSION = 1;
    /// @dev V FitLaunchShape.sol:43 (1e27 raw T per box)
    uint256 internal constant ISSUANCE = 1_000_000_000_000_000_000_000_000_000;
    /// @dev box-factory.md § 2.5 'The curve (now, P)': 80% of T on a curve rising about 14.7 times; the layout centres it at the price where 80% of T buys the raise
    uint256 internal constant CURVE_SHARE_TARGET = 800_000_000_000_000_000_000_000_000;
    /// @dev V FitLaunchShape.sol:58
    int24 internal constant TICK_SPACING = 60;
    /// @dev plan § 1: span 26,880 ticks (k = 1.0001^26,880 ~ 14.70) = 204,060 - 177,180 (V FitLaunchShape.sol:46-47)
    int24 internal constant CURVE_SPAN_TICKS = 26_880;
    /// @dev V FitLaunchShape.sol:93
    int24 internal constant MIN_USABLE_TICK = -887_220;
    /// @dev V FitLaunchShape.sol:94
    int24 internal constant MAX_USABLE_TICK = 887_220;
    /// @dev V FitLaunchShape.sol:57 (static 1%)
    uint24 internal constant LP_FEE = 10_000;
    /// @dev V FitLaunchShape.sol:101 (layout b': 99% of the curve's Q in the bid)
    uint256 internal constant BID_SHARE_PERCENT = 99;
    /// @dev V FitPoolHook.sol:151-156 (0x2AE0)
    uint160 internal constant HOOK_FLAGS = 10_976;
    /// @dev V FitPoolHook.sol:233-234 (0x91: Uniswap's hook policy treats it differently, ADR-0006 context 3); a mined hook address must not start with it
    uint8 internal constant HOOK_FORBIDDEN_ADDRESS_PREFIX = 145;
    /// @dev F80 (open-at-clock-time.md § 2.4): the launch window's steps, one per entry of the tax table (V FitLaunchShape.sol:63; LaunchTaxRouter.sol:92, where a step is a block)
    uint256 internal constant WINDOW_STEPS = 32;
    /// @dev F80 (open-at-clock-time.md § 2.4): one tax step lasts 12 seconds, one Ethereum slot; step = (block.timestamp - openAt) / 12, rounded down
    uint256 internal constant TAX_STEP_SECONDS = 12;
    /// @dev F80: WINDOW_STEPS x TAX_STEP_SECONDS, 6.4 minutes from openAt (v2: 32 blocks)
    uint256 internal constant WINDOW_SECONDS = 384;
    /// @dev V LaunchTaxRouter.sol:33-37, :221 (93.1974% in the window's first step, v2's first block; pips, 10^6 = 100%)
    uint24 internal constant LAUNCH_TAX_PIPS_BLOCK_0 = 931_974;
    /// @dev V LaunchTaxRouter.sol:33-37, :252 (8.0565% in the window's last step, v2's last block; 0 afterwards)
    uint24 internal constant LAUNCH_TAX_PIPS_BLOCK_31 = 80_565;
    /// @dev keccak256(abi.encode(LaunchTaxRouter.taxTable())), the 32 entries at V LaunchTaxRouter.sol:219-254 (the hash it says is published with the launch, :218); the same table for every box, as k = 1.0001^CURVE_SPAN_TICKS is fixed
    bytes32 internal constant LAUNCH_TAX_TABLE_HASH = 0x92df36308343b3602e90e5f33e532c39e82e06395bea65656c29f0d2d77dffcc;
    /// @dev F80 (open-at-clock-time.md § 2.1): 2026-09-01 00:00:00 UTC; a non-zero openAt below it is a unit mistake (a block count or a delay typed into the field), refused OUT_OF_RANGE
    uint32 internal constant MIN_OPEN_AT = 1_788_220_800;
    /// @dev F80 (open-at-clock-time.md § 2.1): 14 days, the old 100,800-block maximum (V FitLaunchShape.sol:68) at 12 s; checked by the factory against the creation block's time (OpenAtTooFar), not by the pure validate()
    uint256 internal constant MAX_OPEN_AHEAD_SECONDS = 1_209_600;
    /// @dev V FitLaunchShape.sol:55 (0.0015 ETH)
    /// Build profile (F78): 1_500_000_000_000_000 in the mainnet build, scaled in a rehearsal build (BoxBuildV1.BOOTSTRAP_ETH).
    uint256 internal constant BOOTSTRAP_ETH = BoxBuildV1.BOOTSTRAP_ETH;
    /// @dev V MisfitsGenesis.sol:174 (F23 C3)
    uint256 internal constant DRAW_FEE_BPS = 100;
    /// @dev V MisfitsGenesis.sol:175 (F23 C3)
    uint256 internal constant PICK_FEE_BPS = 2500;
    /// @dev V MisfitsGenesis.sol:176 (F23 C3)
    uint256 internal constant RETURN_FEE_BPS = 500;
    /// @dev fee shares in fifteenths, remainders carried: V BuybackBurner.sol:191 (box 0); F68 (3) (other boxes: 10/15, 3/15, 2/15)
    uint256 internal constant FEE_SHARE_DENOMINATOR = 15;
    /// @dev F68 (3); plan § 3.6: other boxes' reward side, 10/15 of each fee stream to the creator's stream actions, or to creatorFeeRecipient with a creator kind (F70: chosen per side, paid in T or Q). Both sides V BoxReceiver.sol `_split` (core v1: sellers' fees split three ways too); S5.M1: BUYBACK_BURN_T's and CREATOR_IN_T's share, and CREATOR_IN_Q's, go to the swap module's ledgers (`_rewardQ`, `_split`), held until the settlement
    uint256 internal constant FEE_SHARE_Q_STREAM = 10;
    /// @dev F64, F68 (3); plan § 3.6: other boxes' 3/15 to FIT buy-and-burn (through fundBudget()). Q side V BoxReceiver.sol `_split`; T side V `_split`: it waits in the receiver (fitWaitingT). Founder question 9 answered by R F75 W4: sold for Q after graduation in small capped steps, the Q buying and burning FIT; S5.M1 hands it to the box's swap module after the settlement (V BoxReceiver.sol `pullForModule`), whose sells are S5.M2
    uint256 internal constant FEE_SHARE_FIT = 3;
    /// @dev F64, F68 (3), F72 (B), F77: every box's 2/15 of both sides, box 0's included (F77: one constant means every box's 2/15), goes into the box's own pool depth by pair and lock: held in the receiver until graduation (depthHeld, BC-109, BC-143), then the hook's claims, which deepen() adds as one full-range position at DEPTH_PAIR_SALT once both sides reach DEPTH_MIN_ADD_BPS_OF_RAISE (V BoxReceiver.sol `_split`, `_creditDepth`, `_settleGraduation`; BoxHookExtension `_planDeepen`). launch-pipeline-v1.md § 6 question 5 answered by F72 (B). A Q-only inflow buys its T in small capped steps through deepen()'s depth conversions (R F76; S5.M5, BoxHookExtension `_planConvert`; DEPTH_CONVERT_SHARE_BPS, DEPTH_CONVERT_MIN_Q) and pairs once both sides reach the minimum. Box 0: FEE_SHARE_DEPTH + BOX0_FEE_SHARE_FIT + BOX0_FEE_SHARE_PLATFORM = 15 (buyers' side) and FEE_SHARE_DEPTH + BOX0_FEE_SHARE_T_BURN = 15 (sellers' side). Other boxes never pay the platform (BC-015, BC-109). Replaces FEE_SHARE_PLATFORM (plan § 3.6's 2/15 to the platform)
    uint256 internal constant FEE_SHARE_DEPTH = 2;
    /// @dev R F77 (2026-10-03, 'the Misfits like all the others'): box 0's buyers' fees (Q) give 11/15 to FIT buy-and-burn through FIT's executor (held until graduation, BC-020), next to 2/15 into its own pool (FEE_SHARE_DEPTH) and 2/15 to the platform (BOX0_FEE_SHARE_PLATFORM); V BoxReceiver.sol `_split`. Was 13/15 (F23 C3; V BuybackBurner.sol:140, :190-191, the deployed v2 executor, which keeps it)
    uint256 internal constant BOX0_FEE_SHARE_FIT = 11;
    /// @dev V BuybackBurner.sol:140, :190-191 (box 0: 2/15 to the treasury; F23 C3), capped from S5 at PLATFORM_CAP_WEI per PLATFORM_EPOCH_SECONDS (F62, F64; V BoxReceiver.sol `_capPlatform`): today's v2 executor pays it uncapped. The platform's only income (F64, F77): buyers' side only, never the sellers' side, the sniper tax or another box's fees
    uint256 internal constant BOX0_FEE_SHARE_PLATFORM = 2;
    /// @dev R F77: box 0's sellers' fees (T = FIT) give 13/15 to be burned (T_STREAM_BURN_T; a burn the vault's floor refuses waits, BC-016), or after graduation to the per-item stream (T_STREAM_PER_ITEM_STREAM, S8), and 2/15 into its own pool (FEE_SHARE_DEPTH); exact fifteenths with the remainder carried, as every box's (V BoxReceiver.sol `_split`; BC-139). Was all of the T side
    uint256 internal constant BOX0_FEE_SHARE_T_BURN = 13;
    /// @dev F62, F64: box 0's capped receiver keeps at most 32 ETH per epoch for the platform from box 0's 2/15 and its royalties (F65); the rest goes into box 0's own pool depth. Set in ETH, no price feed (F61 PS1). The Misfits' launch-window (sniper) tax is not platform income: it goes into box 0's own pool after graduation like every box's (F77 supersedes F68 (1b); BC-140), so it is neither inside nor outside this cap. Cases BC-106, BC-107, BC-141
    /// Build profile (F78): 32_000_000_000_000_000_000 in the mainnet build, scaled in a rehearsal build (BoxBuildV1.PLATFORM_CAP_WEI).
    uint256 internal constant PLATFORM_CAP_WEI = BoxBuildV1.PLATFORM_CAP_WEI;
    /// @dev F62 (32 ETH per 30 days): epoch = floor((now - graduation) / 30 days), no carry-over; box 0's 2/15 held before graduation counts in epoch 0 (dynamic-pool-share.md § 1.1; BC-106)
    uint32 internal constant PLATFORM_EPOCH_SECONDS = 2_592_000;
    /// @dev plan § 3.6 (D2): collect() refuses batches below 0.005 ETH or the listed equivalent (S12 for other Q), except at graduation or failure; re-sized from measured gas (BC-017)
    /// Build profile (F78): 5_000_000_000_000_000 in the mainnet build, scaled in a rehearsal build (BoxBuildV1.FEE_BATCH_MIN_ETH).
    uint256 internal constant FEE_BATCH_MIN_ETH = BoxBuildV1.FEE_BATCH_MIN_ETH;
    /// @dev plan § 3.6 (D2): collect() pays its caller min(10% of the batch, FEE_BATCH_TIP_MAX_ETH)
    uint256 internal constant FEE_BATCH_TIP_BPS = 1000;
    /// @dev plan § 3.6 (D2): the tip's cap, 0.0005 ETH
    /// Build profile (F78): 500_000_000_000_000 in the mainnet build, scaled in a rehearsal build (BoxBuildV1.FEE_BATCH_TIP_MAX_ETH).
    uint256 internal constant FEE_BATCH_TIP_MAX_ETH = BoxBuildV1.FEE_BATCH_TIP_MAX_ETH;
    /// @dev plan § 3.4 (D6): the graduation caller's reserve is topped up to 0.1% of R (0.0042069 ETH for box 0); BC-027. Built (V BoxCoordinator.sol:345-346, BoxHookBase.sol:185-187). R F75 W2: 'graduation reward stays 0.1% of the raise; our bot covers graduation when gas is high' (founder question 7: it pays this graduate() up to about 6.5 gwei today and 2.3 gwei after Glamsterdam, our keeper above that); the near-full-curve close-and-sell-back (about 0.002 ETH net, question 8) is accepted
    uint256 internal constant GRADUATION_REWARD_CAP_BPS = 10;
    /// @dev plan § 3.6 (P8): FIT buy-and-burn batches open once the budget reaches 0.05% of FIT's market cap at its 1-hour average; BC-041
    uint256 internal constant FIT_BURN_BATCH_MCAP_BPS = 5;
    /// @dev V FitBuybackBurner.sol:41 (REVIEWED_TWAP_WINDOW)
    uint32 internal constant EXECUTOR_TWAP_WINDOW_SECONDS = 3600;
    /// @dev V FitBuybackBurner.sol:42 (REVIEWED_MAX_IMPACT_TICKS)
    int24 internal constant EXECUTOR_MAX_IMPACT_TICKS = 49;
    /// @dev V FitBuybackBurner.sol:43 (REVIEWED_TWAP_BAND_TICKS)
    int24 internal constant EXECUTOR_TWAP_BAND_TICKS = 99;
    /// @dev V FitBuybackBurner.sol:44 (REVIEWED_MAX_OBSERVATION_STEP)
    int24 internal constant EXECUTOR_MAX_OBSERVATION_STEP = 100;
    /// @dev V FitBuybackBurner.sol:45 (REVIEWED_MAX_CHUNKS_PER_BLOCK)
    uint8 internal constant EXECUTOR_MAX_CHUNKS_PER_BLOCK = 1;
    /// @dev V FitBuybackBurner.sol:46 (REVIEWED_MIN_SQRT_PRICE_X96 = TickMath.MIN_SQRT_PRICE + 1); the pool fee and spacing are LP_FEE and TICK_SPACING (:39-40)
    uint160 internal constant EXECUTOR_MIN_SQRT_PRICE_X96 = 4_295_128_740;
    /// @dev docs/design/swap-module-v1.md § 4.6, § 10 (P, economic: the founder's; S5.M4 measured it and proposes to keep it, docs/evidence/SH-misfits-line.md § S5.M4): a swap module step whose budget, valued in Q at the reference tick, is below 0.005 ETH (= FEE_BATCH_MIN_ETH) waits (Stop.BelowStepMin), so tiny steps cannot farm tips; at it a steady step's 5% tip covers its gas up to 0.55 gwei under Glamsterdam (0.81 today), a full step's capped tip up to 1.11 gwei (1.62); S12: the listed equivalent. Used by BoxSwapModule (S5.M2, `_plan`; a sell's T valued by BoxSwapBounds.tInQ)
    /// Build profile (F78): 5_000_000_000_000_000 in the mainnet build, scaled in a rehearsal build (BoxBuildV1.SWAP_STEP_MIN_Q).
    uint256 internal constant SWAP_STEP_MIN_Q = BoxBuildV1.SWAP_STEP_MIN_Q;
    /// @dev docs/design/swap-module-v1.md § 4.6, § 10 (P): a step's caller gets min(5% of the step's Q, FEE_BATCH_TIP_MAX_ETH), paid in Q from the step itself, last (as DEPTH_TIP_BPS); used by BoxSwapBounds.tipOf (S5.M2: of a buy's input, reserved before sizing it, and of a sell's output); a full 49-tick step at graduation's depth spends about 0.0100 ETH, so its tip is at the cap already (SH-S5-swap § M2); S5.M4 measured it against every keeper path and proposes to keep it (economic: the founder's; docs/evidence/SH-misfits-line.md § S5.M4)
    uint256 internal constant SWAP_STEP_TIP_BPS = 500;
    /// @dev docs/design/swap-module-v1.md § 4.4, § 10 (P): one step per box per block, all actions together (EXECUTOR_MAX_CHUNKS_PER_BLOCK's rule); the knob for slower W4 sells (R F75 W4: small capped steps); used by BoxSwapBounds.stepDue (S5.M2)
    uint256 internal constant SWAP_STEP_COOLDOWN_BLOCKS = 1;
    /// @dev R F76 ('swapping half of it into T in small capped steps, then pairing'); docs/design/swap-module-v1.md § 8, § 10 (P for the bps form): a depth conversion inside deepen() spends at most half the unpaired Q, the 49-tick limit (EXECUTOR_MAX_IMPACT_TICKS) caps it further; every box, box 0 included since F77. Built in S5.M5 (BoxHookExtension `_planConvert`: x = min(DEPTH_CONVERT_SHARE_BPS of (Q budget - T value at spot), the Q budget less the tip), as exact input to BoxSwapBounds' buy limit; SH-S5-swap § M5)
    uint256 internal constant DEPTH_CONVERT_SHARE_BPS = 5000;
    /// @dev docs/design/swap-module-v1.md § 8 rule 4, § 10 (P): a depth conversion alone waits below 0.005 ETH (= SWAP_STEP_MIN_Q), so it pays its gas and tip; a conversion followed by a pair in the same unlock has no separate minimum. Built in S5.M5 (BoxHookExtension `_planConvert`; DeepenSkip.ConvertBelowMin): below the minimum a conversion runs only when the pair is expected to follow (the minimum output at the limit, valued at spot, brings the T side to MIN_ADD with the Q side still at it). S5 review: the minimum is checked on what the swap can spend, the smaller of its ceiling and the room to its limit (BoxSwapBounds.buyInput), so a sliver of room left by a push to the band's edge or the box's own buy-back is a skip that starts no cooldown
    /// Build profile (F78): 5_000_000_000_000_000 in the mainnet build, scaled in a rehearsal build (BoxBuildV1.DEPTH_CONVERT_MIN_Q).
    uint256 internal constant DEPTH_CONVERT_MIN_Q = BoxBuildV1.DEPTH_CONVERT_MIN_Q;
    /// @dev plan § 1 (firstId fixed by the version); V MisfitsGenesis.sol:172
    uint256 internal constant FIRST_ID = 1;
    /// @dev BC-008 (factory-built N from 10)
    uint32 internal constant MIN_N = 10;
    /// @dev BC-008; box-factory § 2.6
    uint32 internal constant MAX_N = 10_000;
    /// @dev plan § 1
    uint256 internal constant MAX_TOKEN_NAME_BYTES = 32;
    /// @dev plan § 1
    uint256 internal constant MAX_SYMBOL_BYTES = 11;
    /// @dev plan § 1
    uint256 internal constant MAX_TEXT_BYTES = 1024;
    /// @dev plan § 1 (the placeholders add-on's hidden picture)
    uint256 internal constant MAX_SVG_BYTES = 4096;
    /// @dev V MisfitsCollection.sol:122 (EIP-170 less the STOP prefix)
    uint256 internal constant MAX_METADATA_TABLE_BYTES = 24_575;
    /// @dev V BoxMetadataTable.sol:22 (MAX_TRAIT_TYPES: 16 types × one byte = traitsPacked's 128 bits); validate() refuses a table with more (METADATA_TABLE_MALFORMED, core item 9)
    uint256 internal constant MAX_TRAIT_TYPES = 16;
    /// @dev P (S1): a bound on the list, so validate() stays cheap
    uint256 internal constant MAX_ADD_ONS = 8;
    /// @dev DECISION-LOG F44 (box 0's marketplaceOwner; the platform's fixed Safe)
    address internal constant PLATFORM_SAFE_MAINNET = 0xdCE82e76456434d0f550b492Ff212A862221e6c5;
    /// @dev V BoxHookBase.sol:59 (BoxHook.DEEPEN_COOLDOWN_BLOCKS): blocks between two depth adds, the first counted from the migration (core v1)
    uint256 internal constant DEPTH_COOLDOWN_BLOCKS = 300;
    /// @dev V BoxHookBase.sol:61 (BoxHook.MAX_DEVIATION_TICKS): deepen() refuses while the spot is further than this from the 1-hour average
    int24 internal constant DEPTH_MAX_DEVIATION_TICKS = 99;
    /// @dev V BoxHookBase.sol:67 (BoxHook.ADD_CAP_PERCENT): one add is at most this share of its base, the Q the core positions' liquidity spans over [t_ref, t_ref + DEPTH_CAP_BAND_TICKS] as if the price stood at t_ref
    uint256 internal constant DEPTH_ADD_CAP_PERCENT = 10;
    /// @dev V BoxHookBase.sol:69 (_BAND): the band above t_ref that DEPTH_ADD_CAP_PERCENT's base spans
    int24 internal constant DEPTH_CAP_BAND_TICKS = 953;
    /// @dev V BoxHookBase.sol:71 (_MIN_ADD_BPS): an add waits until its budget reaches 0.5% of the raise (both sides for pair and lock, F72 (B))
    uint256 internal constant DEPTH_MIN_ADD_BPS_OF_RAISE = 50;
    /// @dev V BoxHookBase.sol:74-75 (BoxHook.DEEPEN_TIP_BPS): deepen()'s caller gets 5% of the Q the call spent (the add's, and since S5.M5 a conversion's input too: one tip a call, reserved from the Q side first), capped at FEE_BATCH_TIP_MAX_ETH
    uint256 internal constant DEPTH_TIP_BPS = 500;
    /// @dev V BoxHookBase.sol:82 (_SALT_PAIR): pair and lock's full-range position (F72 (B)), every box's since F77 (box 0 included); the curve is salt 0, L7 salt 1; salt 2 (the removed rungs', F77) is never used and not renumbered
    uint256 internal constant DEPTH_PAIR_SALT = 3;
    /// @dev V BoxReceiver.sol `STREAM_NOTIFY_GAS`: the gas the per-item stream's onStreamFunds gets, capped and fail-safe (as FitPoolHook.sol:159-166). S8 measured BoxItemStream.onStreamFunds with its burn of the items-inside share at 99,555 gas today and 124,880 under Glamsterdam from cold, the least forwarded gas with which it succeeds (BoxItemStreamGas.t.sol; SH-S8-stream § 5); 100,000 (S5) did not fit after Glamsterdam. Kept at 200,000 by F87's review (SH-box0-stream-gas § The notice): 1.60x after Glamsterdam; a failed notice only delays the burn of the items-inside share, while the receiver's settlement inside the graduation poke checks that the whole cap is left (each 50,000 more takes about 51,600 of POKE_GAS's room); 250,000 would need POKE_GAS raised with it (founder question)
    uint256 internal constant STREAM_NOTIFY_GAS = 200_000;
    /// @dev F95 R19M (2026-10-06, desk round 19: 'Raise to 2,600,000 (2x)'; F90 R16I's 1,600,000 and S6's 1,000,000 before): V BoxCoordinator.sol:104, with the caller's floor POKE_GAS + POKE_GAS / 63 + 10,000 = 2,651,269 (:120): every graduation poke is capped; every poke is fail-safe, including the stream; F126 / M28 records its baseline before pokes for a lossless delayed retry (BC-098). Measured on box 0 with its stream, each poke alone from cold (Box0StreamCeiling.t.sol; SH-box0-stream-gas § POKE_GAS): under Glamsterdam the receiver's settlement with its notice needs 874,760 and the stream's poke running it 913,836 when a fee batch ran before the close (2.97x, 2.85x), and 1,237,499 and 1,288,181 when the settlement's batch is the box's first (seven slots written from zero: 2.10x, 2.02x; 1.30x and 1.24x at 1,600,000); the tickets' word request 147,292, FIT's executor's sample 138,074, the stream's start 102,555; today at most 515,229 (5.05x). graduate()'s least call gas from cold: 3,598,433-3,762,467 today, 5,425,027-6,410,090 under Glamsterdam (one gas less: GasTooLow); with all four pokes exhausting their budgets graduation succeeds (F126), using at most 11,041,016 execution gas including intrinsic after Amsterdam; its least successful transaction is 13,031,931, under EIP-7825's 16,777,216. Before (S6, S5.M1): a creator box's onGraduation with its first batch final 654,047 under Glamsterdam (3.98x now). Whether other boxes' price sampler and launch router sweep join the pokes is founder question 10 (built: neither)
    uint256 internal constant POKE_GAS = 2_600_000;
    /// @dev V BackedSourcePins.sol:24-25: box 0's one randomness source, BoxBackedSource (F143: drand first through the pinned DrandSource, DRAND_SOURCE; the RANDAO backup fixed at creation, started by an on-chain rule anyone can trigger BACKUP_AFTER_SECONDS after an unposted round's time, one target BACKUP_TARGET_BLOCKS ahead, no Safe or other power; amends F61 R4's drand only, no Chainlink backup), which factory v1 pins on chains 1 and 11155111, the same address on both (the deterministic deployer, salt keccak256('squarehole.box.v1.BoxBackedSource')). Not deployed yet: anyone may send the deterministic deployment (DeployCoreV1 sends it when absent). graduate() does not re-check its code (a failed re-check would freeze a closed box, D1): the factory pins it (S7) and the instance checks re-check it (BC-101). Core v2 boxes stay drand-only (DRAND_SOURCE)
    address internal constant RANDOMNESS_SOURCE = 0x4FE27aE2810DAdA5F2f0f425F6623FdbE6A321fb;
    /// @dev V BackedSourcePins.sol:26-27: RANDOMNESS_SOURCE's runtime code hash on chains 1 and 11155111 (BackedSourcePins.isPinned; F143)
    bytes32 internal constant RANDOMNESS_SOURCE_CODE_HASH = 0x7b3be4b9531713d98f065160d3c2dd2f517a0d5203672d8cd3df590d82f2ffa3;
    /// @dev V DrandSourcePins.sol:28-29: the one drand quicknet source every box shares (rounds are posted here; BoxBackedSource.DRAND names it, and core v2 boxes read it directly), pinned on chains 1 and 11155111, the same address on both (the deterministic deployer, salt keccak256('squarehole.box.v1.DrandSource')); factory v1 checks it is there with its pinned code (BC-101, F143)
    address internal constant DRAND_SOURCE = 0xbeEcE13fBdd67D0A696cB7cfD28103Ed37ba79A6;
    /// @dev V DrandSourcePins.sol:30-31: DRAND_SOURCE's runtime code hash on chains 1 and 11155111 (DrandSourcePins.isPinned)
    bytes32 internal constant DRAND_SOURCE_CODE_HASH = 0xb835f0713da5f533832670cd4fa7ba4cc94b93203025f9412d87c9b575a54218;
    /// @dev V BoxBackedSource.sol (BACKUP_AFTER, 5 days): a quicknet round still unposted this long after its time may fall back to the RANDAO backup, started by anyone (F143 (2): 5 days, not 3), until BACKUP_LATEST_START_SECONDS
    uint256 internal constant BACKUP_AFTER_SECONDS = 432_000;
    /// @dev V BoxBackedSource.sol (LATEST_START, 5 days 18 hours; the security review of sh-box0-backup-source, F1): the last moment after a round's time at which its backup may start; with the target BACKUP_TARGET_BLOCKS ahead and the fix inside EIP-2935's 8,191 blocks even the latest start's last word lands about 6.92 days after the request, inside DRAND_SILENCE_SECONDS: the cutoff keeps the whole proof window plus at least 1 h 50 min 21 s of margin at 12-second blocks (test/box/backup/BackupTimeline.t.sol); a later start could still be fixed early, but it would use up that margin and eventually push part of the proof window past the consumers' deadline
    uint256 internal constant BACKUP_LATEST_START_SECONDS = 496_800;
    /// @dev V BoxBackedSource.sol (RECENT_BLOCKS): the header a start proves (the format the fix relies on) may be one of the last 8 blocks', so a start included a few blocks late still lands (the security review, F3)
    uint256 internal constant BACKUP_RECENT_BLOCKS = 8;
    /// @dev V BoxBackedSource.sol (TARGET_BLOCKS): the backup's target block is this many blocks after its start (about 51 minutes, 8 epochs: past the beacon chain's proposer lookahead); one target per round, never a second (F143; the review of the design study)
    uint256 internal constant BACKUP_TARGET_BLOCKS = 256;
    /// @dev V DrandSource.sol:68 (MARGIN): a word counts only from a round at least this long after the request
    uint256 internal constant DRAND_MARGIN_SECONDS = 12;
    /// @dev V DrandSource.sol:70 (SILENCE, 7 days) = the placeholders add-on's SILENCE_DAYS (BoxTickets.sol:57): 7 silent days mean terminal mode
    uint256 internal constant DRAND_SILENCE_SECONDS = 604_800;
    /// @dev V DrandWords.sol:49 (BOUNTY_GAS): a round's posting bounty, BOUNTY_GAS × the block's base fee (about 0.0003 ETH at 0.5 gwei). R F75 W3 ('the draw pays the drand round's posting'): BoxTickets.draw requires it (DrandWords.payRound after its requests; BountyTooLow(pot + sent, needed)): the first draw of a round tops the round's pot up to the target, and the rest of the ETH sent goes back to the drawer (review of sh-f75, P; into the pot if the drawer refuses ETH), so later draws of that round get all they sent back; the pot pays whoever posts the round, usually the drawer's own page. The graduation word's request needs none (founder question 5, P)
    uint256 internal constant DRAND_BOUNTY_GAS = 600_000;

    // ------------------------------------------------------------------------------------------- enums (uint8)
    uint8 internal constant BOX_TYPE_NEW_COLLECTION = 1;
    uint8 internal constant BOX_TYPE_EXISTING = 2;
    uint8 internal constant BOX_TYPE_TOKEN_ONLY = 3;
    uint8 internal constant LAYOUT_CURVE_V1 = 1;
    uint8 internal constant GRAD_LAYOUT_B_PRIME = 1;
    uint8 internal constant GRAD_LAYOUT_ASK_FULL_BID_SENTINEL = 2;
    uint8 internal constant LAUNCH_FORMAT_CURVE = 1;
    uint8 internal constant Q_STREAM_BUYBACK_BURN_T = 1;
    uint8 internal constant Q_STREAM_ALL_TO_FIT = 2;
    uint8 internal constant Q_STREAM_BURN_Q = 3;
    uint8 internal constant Q_STREAM_PAY_HOLDERS_Q = 4;
    uint8 internal constant Q_STREAM_TO_CREATOR = 5;
    uint8 internal constant Q_STREAM_CREATOR_IN_T = 6;
    uint8 internal constant Q_STREAM_HOLDERS_IN_T = 7;
    uint8 internal constant T_STREAM_BURN_T = 1;
    uint8 internal constant T_STREAM_PAY_HOLDERS_T = 2;
    uint8 internal constant T_STREAM_SELL_FOR_Q = 3;
    uint8 internal constant T_STREAM_PER_ITEM_STREAM = 4;
    uint8 internal constant T_STREAM_TO_CREATOR = 5;
    uint8 internal constant T_STREAM_CREATOR_IN_Q = 6;
    uint8 internal constant T_STREAM_HOLDERS_IN_Q = 7;
    uint8 internal constant ART_MODE_OPEN = 1;
    uint8 internal constant ART_MODE_HIDDEN = 2;
    uint8 internal constant Q_CLASS_NATIVE_ETH = 1;
    uint8 internal constant Q_CLASS_ERC20 = 2;
    uint8 internal constant Q_CLASS_FIT = 3;
    uint8 internal constant Q_CLASS_BOX_T = 4;
    uint8 internal constant ROYALTY_DESTINATION_FEE_HANDLING = 1;
    uint8 internal constant ROYALTY_DESTINATION_CREATOR = 2;
    uint8 internal constant ROYALTY_DESTINATION_POOL_DEPTH = 3;
    uint8 internal constant CAP_EXCESS_HOLDERS = 1;
    uint8 internal constant CAP_EXCESS_BURN = 2;
    uint8 internal constant CAP_EXCESS_POOL_DEPTH = 3;

    // ------------------------------------------------------------------------------------------- string rules
    uint8 internal constant RULE_JSON_TEXT = 1;
    uint8 internal constant RULE_SVG = 2;
    uint8 internal constant RULE_URL = 3;

    // ------------------------------------------------------------------------------------------- reasons
    uint16 internal constant REASON_OK = 0;
    uint16 internal constant REASON_UNSUPPORTED_VERSION = 1;
    uint16 internal constant REASON_NOT_A_MEMBER = 2;
    uint16 internal constant REASON_NOT_OFFERED = 3;
    uint16 internal constant REASON_OUT_OF_RANGE = 4;
    uint16 internal constant REASON_LENGTH_OUT_OF_RANGE = 5;
    uint16 internal constant REASON_BAD_CHARACTER = 6;
    uint16 internal constant REASON_ZERO_VALUE = 7;
    uint16 internal constant REASON_MUST_BE_ZERO = 8;
    uint16 internal constant REASON_Q_NOT_LISTED = 9;
    uint16 internal constant REASON_RAISE_NOT_A_PRESET = 10;
    uint16 internal constant REASON_MENU_RULE = 11;
    uint16 internal constant REASON_DEADLINE_RULE = 12;
    uint16 internal constant REASON_TOO_MANY_ADD_ONS = 13;
    uint16 internal constant REASON_ADD_ON_ORDER = 14;
    uint16 internal constant REASON_ADD_ON_UNKNOWN = 15;
    uint16 internal constant REASON_ADD_ON_NOT_AVAILABLE = 16;
    uint16 internal constant REASON_ADD_ON_PARAMS_MALFORMED = 17;
    uint16 internal constant REASON_ADD_ON_REQUIRED = 18;
    uint16 internal constant REASON_ADD_ON_CONFLICT = 19;
    uint16 internal constant REASON_METADATA_TABLE_MALFORMED = 20;

    // ------------------------------------------------------------------------------------------- field ids
    uint16 internal constant FIELD_VERSION = 1;
    uint16 internal constant FIELD_BOX_TYPE = 2;
    uint16 internal constant FIELD_TOKEN_NAME = 3;
    uint16 internal constant FIELD_TOKEN_SYMBOL = 4;
    uint16 internal constant FIELD_COLLECTION_NAME = 5;
    uint16 internal constant FIELD_COLLECTION_SYMBOL = 6;
    uint16 internal constant FIELD_DESCRIPTION = 7;
    uint16 internal constant FIELD_N = 8;
    uint16 internal constant FIELD_FIRST_ID = 9;
    uint16 internal constant FIELD_Q = 10;
    uint16 internal constant FIELD_RAISE = 11;
    uint16 internal constant FIELD_LAYOUT = 12;
    uint16 internal constant FIELD_GRAD_LAYOUT = 13;
    uint16 internal constant FIELD_LAUNCH_FORMAT = 14;
    uint16 internal constant FIELD_OPEN_AT = 15;
    uint16 internal constant FIELD_DEADLINE_DAYS = 16;
    uint16 internal constant FIELD_Q_STREAM = 17;
    uint16 internal constant FIELD_T_STREAM = 18;
    uint16 internal constant FIELD_ART_MODE = 19;
    uint16 internal constant FIELD_REVEAL_ROOT = 20;
    uint16 internal constant FIELD_METADATA_TABLE = 21;
    uint16 internal constant FIELD_GENERATOR_HASH = 22;
    uint16 internal constant FIELD_COVER_SHA256 = 23;
    uint16 internal constant FIELD_REVEAL_LIST_ID = 24;
    uint16 internal constant FIELD_MARKETPLACE_OWNER = 25;
    uint16 internal constant FIELD_CREATOR_FEE_RECIPIENT = 26;
    uint16 internal constant FIELD_CREATOR_BUY = 27;
    uint16 internal constant FIELD_COLLECTION_COVER_SHA256 = 28;
    uint16 internal constant FIELD_ADD_ONS = 29;
    uint16 internal constant FIELD_ADD_ON_PLACEHOLDERS = 100;
    uint16 internal constant FIELD_ADD_ON_PLACEHOLDERS_PLACEHOLDER_NAME = 101;
    uint16 internal constant FIELD_ADD_ON_PLACEHOLDERS_PLACEHOLDER_SYMBOL = 102;
    uint16 internal constant FIELD_ADD_ON_PLACEHOLDERS_PLACEHOLDER_DESCRIPTION = 103;
    uint16 internal constant FIELD_ADD_ON_PLACEHOLDERS_HIDDEN_DESCRIPTION = 104;
    uint16 internal constant FIELD_ADD_ON_PLACEHOLDERS_HIDDEN_SVG = 105;
    uint16 internal constant FIELD_ADD_ON_PER_ITEM_STREAM = 200;
    uint16 internal constant FIELD_ADD_ON_EDITION_SPECIALS = 300;
    uint16 internal constant FIELD_ADD_ON_EDITION_SPECIALS_LABEL = 301;
    uint16 internal constant FIELD_ADD_ON_EDITION_SPECIALS_COUNT = 302;
    uint16 internal constant FIELD_ADD_ON_ROYALTIES = 400;
    uint16 internal constant FIELD_ADD_ON_ROYALTIES_BPS = 401;
    uint16 internal constant FIELD_ADD_ON_ROYALTIES_DESTINATION = 402;
    uint16 internal constant FIELD_ADD_ON_CREATOR_FEE_CAP = 500;
    uint16 internal constant FIELD_ADD_ON_CREATOR_FEE_CAP_CAP_PER_EPOCH = 501;
    uint16 internal constant FIELD_ADD_ON_CREATOR_FEE_CAP_EXCESS = 502;
    uint16 internal constant FIELD_ADD_ON_COLLECTION_METADATA = 600;
    uint16 internal constant FIELD_ADD_ON_COLLECTION_METADATA_BANNER_SHA256 = 601;
    uint16 internal constant FIELD_ADD_ON_COLLECTION_METADATA_TEASER_SHA256S = 602;
    uint16 internal constant FIELD_ADD_ON_COLLECTION_METADATA_EXTERNAL_LINK = 603;

    // ------------------------------------------------------------------------------------------- add-ons
    uint16 internal constant ADD_ON_PLACEHOLDERS = 1;
    uint256 internal constant ADD_ON_PLACEHOLDERS_SILENCE_DAYS = 7;
    uint256 internal constant ADD_ON_PLACEHOLDERS_SILENCE_UNREQUESTED_DAYS = 30;
    uint256 internal constant ADD_ON_PLACEHOLDERS_REVEAL_GRACE_DAYS = 30;
    uint256 internal constant ADD_ON_PLACEHOLDERS_TAKE_DELAY_DAYS = 3;
    uint256 internal constant ADD_ON_PLACEHOLDERS_RETURN_GRACE_DAYS = 30;
    uint16 internal constant ADD_ON_PER_ITEM_STREAM = 2;
    uint256 internal constant ADD_ON_PER_ITEM_STREAM_OBSERVER_GAS = 460_000;
    uint16 internal constant ADD_ON_EDITION_SPECIALS = 3;
    uint16 internal constant ADD_ON_ROYALTIES = 4;
    uint256 internal constant ADD_ON_ROYALTIES_BPS_DENOMINATOR = 10_000;
    uint16 internal constant ADD_ON_CREATOR_FEE_CAP = 5;
    uint256 internal constant ADD_ON_CREATOR_FEE_CAP_EPOCH_SECONDS = 2_592_000;
    uint16 internal constant ADD_ON_COLLECTION_METADATA = 6;

    // ------------------------------------------------------------------------------------------- types
    /// @notice One add-on: its catalog id and abi.encode(<its parameter tuple>), canonical (add-ons.v1.json).
    struct AddOn {
        uint16 id;
        bytes params;
    }

    struct BoxSpec {
        uint16 version;
        uint8 boxType;
        string tokenName;
        string tokenSymbol;
        string collectionName;
        string collectionSymbol;
        string description;
        uint32 n;
        uint256 firstId;
        address q;
        uint256 raise;
        uint8 layout;
        uint8 gradLayout;
        uint8 launchFormat;
        uint32 openAt;
        uint16 deadlineDays;
        uint8 qStream;
        uint8 tStream;
        uint8 artMode;
        bytes32 revealRoot;
        bytes metadataTable;
        bytes32 generatorHash;
        bytes32 coverSha256;
        bytes32 revealListId;
        address marketplaceOwner;
        address creatorFeeRecipient;
        uint256 creatorBuy;
        bytes32 collectionCoverSha256;
        AddOn[] addOns;
    }

    /// @notice One curated Q: the version`s list is passed to `validate()` (q must be listed, raise one of its presets).
    struct QAsset {
        address token;
        uint8 decimals;
        uint8 qClass;
        uint256[] raisePresets;
    }

    /// @notice What a version, not the creator, chooses, passed to `validate()` beside the spec: the curated Q list
    /// and the graduated layout(s) the version allows (a `gradLayout` it does not list is NOT_OFFERED).
    struct VersionContext {
        QAsset[] qList;
        uint8[] gradLayouts;
    }

    // ------------------------------------------------------------------------------------------- API
    /// @notice keccak256 of the ABI encoding of the whole spec (the registry`s spec hash).
    function specHash(BoxSpec memory s) internal pure returns (bytes32) {
        return keccak256(abi.encode(s));
    }

    /// @notice (REASON_OK, 0) for a valid spec, else the first failing check`s reason and field id. `ctx` is the
    /// version`s context (`contextV1()`, `contextV2()`).
    function validate(BoxSpec memory s, VersionContext memory ctx) internal pure returns (uint16 reason, uint16 field) {
        (reason, field) = _checkFields(s, ctx);
        if (reason != REASON_OK) return (reason, field);
        (reason, field) = _checkAddOns(s);
        if (reason != REASON_OK) return (reason, field);
        return _checkRules(s, ctx);
    }

    /// @notice Version context `v1`: its Q list and graduated layout(s).
    function contextV1() internal pure returns (VersionContext memory ctx) {
        ctx.qList = qListV1();
        ctx.gradLayouts = new uint8[](1);
        ctx.gradLayouts[0] = GRAD_LAYOUT_ASK_FULL_BID_SENTINEL;
    }

    /// @notice Version context `v2`: its Q list and graduated layout(s).
    function contextV2() internal pure returns (VersionContext memory ctx) {
        ctx.qList = qListV2();
        ctx.gradLayouts = new uint8[](1);
        ctx.gradLayouts[0] = GRAD_LAYOUT_ASK_FULL_BID_SENTINEL;
    }

    /// @notice The curated Q list of context `v1`: Version 1 builds only box 0 (plan § 3.1): one Q, native ETH, with box 0's raise. FIT cannot be on it yet: FIT is box 0's T.
    function qListV1() internal pure returns (QAsset[] memory list) {
        list = new QAsset[](1);
        uint256[] memory presets0 = new uint256[](1);
        presets0[0] = BoxBuildV1.RAISE;
        list[0] = QAsset({token: address(0), decimals: 18, qClass: Q_CLASS_NATIVE_ETH, raisePresets: presets0});
    }

    /// @notice The curated Q list of context `v2`: F74 U5: native ETH with the one raise every box has, 4.206980085 ETH (box 0's R; the presets 1, 4.2 and 10 ETH of box-factory.md § 4.7 are gone); FIT, listed box T and curated ERC-20s join with S12, each with its 'ETH equivalent' raise (rule open; USDY is pushed for the first public version, F61 TB1; counsel decides its listing).
    function qListV2() internal pure returns (QAsset[] memory list) {
        list = new QAsset[](1);
        uint256[] memory presets0 = new uint256[](1);
        presets0[0] = BoxBuildV1.RAISE;
        list[0] = QAsset({token: address(0), decimals: 18, qClass: Q_CLASS_NATIVE_ETH, raisePresets: presets0});
    }

    // ------------------------------------------------------------------------------------------- fields
    function _checkFields(BoxSpec memory s, VersionContext memory ctx) private pure returns (uint16, uint16) {
        uint16 r;
        // 1 version
        if (!(s.version == 1 || s.version == 2)) return (REASON_UNSUPPORTED_VERSION, FIELD_VERSION);
        // 2 boxType
        if (!(s.boxType == BOX_TYPE_NEW_COLLECTION || s.boxType == BOX_TYPE_EXISTING || s.boxType == BOX_TYPE_TOKEN_ONLY)) return (REASON_NOT_A_MEMBER, FIELD_BOX_TYPE);
        if (!(s.boxType == BOX_TYPE_NEW_COLLECTION || s.boxType == BOX_TYPE_TOKEN_ONLY)) return (REASON_NOT_OFFERED, FIELD_BOX_TYPE);
        // 3 tokenName
        r = _checkString(bytes(s.tokenName), 1, MAX_TOKEN_NAME_BYTES, RULE_JSON_TEXT);
        if (r != REASON_OK) return (r, FIELD_TOKEN_NAME);
        // 4 tokenSymbol
        r = _checkString(bytes(s.tokenSymbol), 1, MAX_SYMBOL_BYTES, RULE_JSON_TEXT);
        if (r != REASON_OK) return (r, FIELD_TOKEN_SYMBOL);
        // 5 collectionName
        if (s.boxType == BOX_TYPE_TOKEN_ONLY) {
            if (bytes(s.collectionName).length != 0) return (REASON_MUST_BE_ZERO, FIELD_COLLECTION_NAME);
        } else {
            r = _checkString(bytes(s.collectionName), 1, MAX_TOKEN_NAME_BYTES, RULE_JSON_TEXT);
            if (r != REASON_OK) return (r, FIELD_COLLECTION_NAME);
        }
        // 6 collectionSymbol
        if (s.boxType == BOX_TYPE_TOKEN_ONLY) {
            if (bytes(s.collectionSymbol).length != 0) return (REASON_MUST_BE_ZERO, FIELD_COLLECTION_SYMBOL);
        } else {
            r = _checkString(bytes(s.collectionSymbol), 1, MAX_SYMBOL_BYTES, RULE_JSON_TEXT);
            if (r != REASON_OK) return (r, FIELD_COLLECTION_SYMBOL);
        }
        // 7 description
        r = _checkString(bytes(s.description), 0, MAX_TEXT_BYTES, RULE_JSON_TEXT);
        if (r != REASON_OK) return (r, FIELD_DESCRIPTION);
        // 8 n
        if (s.boxType == BOX_TYPE_TOKEN_ONLY) {
            if (s.n != 0) return (REASON_MUST_BE_ZERO, FIELD_N);
        } else {
            if (s.n < MIN_N || s.n > MAX_N) return (REASON_OUT_OF_RANGE, FIELD_N);
        }
        // 9 firstId
        if (s.firstId < FIRST_ID || s.firstId > FIRST_ID) return (REASON_OUT_OF_RANGE, FIELD_FIRST_ID);
        // 10 q
        if (!_isListed(s.q, ctx.qList)) return (REASON_Q_NOT_LISTED, FIELD_Q);
        // 11 raise
        if (!_isPreset(s.q, s.raise, ctx.qList)) return (REASON_RAISE_NOT_A_PRESET, FIELD_RAISE);
        // 12 layout
        if (!(s.layout == LAYOUT_CURVE_V1)) return (REASON_NOT_A_MEMBER, FIELD_LAYOUT);
        // 13 gradLayout
        if (!(s.gradLayout == GRAD_LAYOUT_B_PRIME || s.gradLayout == GRAD_LAYOUT_ASK_FULL_BID_SENTINEL)) return (REASON_NOT_A_MEMBER, FIELD_GRAD_LAYOUT);
        if (!(s.gradLayout == GRAD_LAYOUT_ASK_FULL_BID_SENTINEL)) return (REASON_NOT_OFFERED, FIELD_GRAD_LAYOUT);
        if (!_inList(s.gradLayout, ctx.gradLayouts)) return (REASON_NOT_OFFERED, FIELD_GRAD_LAYOUT);
        // 14 launchFormat
        if (!(s.launchFormat == LAUNCH_FORMAT_CURVE)) return (REASON_NOT_A_MEMBER, FIELD_LAUNCH_FORMAT);
        // 15 openAt
        if (s.openAt != 0 && (s.openAt < MIN_OPEN_AT)) return (REASON_OUT_OF_RANGE, FIELD_OPEN_AT);
        // 16 deadlineDays
        if (!(s.deadlineDays == 0 || s.deadlineDays == 30 || s.deadlineDays == 60 || s.deadlineDays == 90 || s.deadlineDays == 180)) return (REASON_NOT_A_MEMBER, FIELD_DEADLINE_DAYS);
        // 17 qStream
        if (!(s.qStream == Q_STREAM_BUYBACK_BURN_T || s.qStream == Q_STREAM_ALL_TO_FIT || s.qStream == Q_STREAM_BURN_Q || s.qStream == Q_STREAM_PAY_HOLDERS_Q || s.qStream == Q_STREAM_TO_CREATOR || s.qStream == Q_STREAM_CREATOR_IN_T || s.qStream == Q_STREAM_HOLDERS_IN_T)) return (REASON_NOT_A_MEMBER, FIELD_Q_STREAM);
        if (!(s.qStream == Q_STREAM_BUYBACK_BURN_T || s.qStream == Q_STREAM_ALL_TO_FIT || s.qStream == Q_STREAM_BURN_Q || s.qStream == Q_STREAM_TO_CREATOR || s.qStream == Q_STREAM_CREATOR_IN_T)) return (REASON_NOT_OFFERED, FIELD_Q_STREAM);
        // 18 tStream
        if (!(s.tStream == T_STREAM_BURN_T || s.tStream == T_STREAM_PAY_HOLDERS_T || s.tStream == T_STREAM_SELL_FOR_Q || s.tStream == T_STREAM_PER_ITEM_STREAM || s.tStream == T_STREAM_TO_CREATOR || s.tStream == T_STREAM_CREATOR_IN_Q || s.tStream == T_STREAM_HOLDERS_IN_Q)) return (REASON_NOT_A_MEMBER, FIELD_T_STREAM);
        if (!(s.tStream == T_STREAM_BURN_T || s.tStream == T_STREAM_SELL_FOR_Q || s.tStream == T_STREAM_PER_ITEM_STREAM || s.tStream == T_STREAM_TO_CREATOR || s.tStream == T_STREAM_CREATOR_IN_Q)) return (REASON_NOT_OFFERED, FIELD_T_STREAM);
        // 19 artMode
        if (s.boxType == BOX_TYPE_TOKEN_ONLY) {
            if (s.artMode != 0) return (REASON_MUST_BE_ZERO, FIELD_ART_MODE);
        } else {
            if (!(s.artMode == ART_MODE_OPEN || s.artMode == ART_MODE_HIDDEN)) return (REASON_NOT_A_MEMBER, FIELD_ART_MODE);
        }
        // 20 revealRoot
        if (s.boxType == BOX_TYPE_TOKEN_ONLY) {
            if (s.revealRoot != bytes32(0)) return (REASON_MUST_BE_ZERO, FIELD_REVEAL_ROOT);
        } else {
            if (s.revealRoot == bytes32(0)) return (REASON_ZERO_VALUE, FIELD_REVEAL_ROOT);
        }
        // 21 metadataTable
        if (s.boxType == BOX_TYPE_TOKEN_ONLY) {
            if (s.metadataTable.length != 0) return (REASON_MUST_BE_ZERO, FIELD_METADATA_TABLE);
        } else {
            if (s.metadataTable.length < 1 || s.metadataTable.length > MAX_METADATA_TABLE_BYTES) return (REASON_LENGTH_OUT_OF_RANGE, FIELD_METADATA_TABLE);
            if (!_tableV1(s.metadataTable)) return (REASON_METADATA_TABLE_MALFORMED, FIELD_METADATA_TABLE);
        }
        // 22 generatorHash
        if (s.boxType == BOX_TYPE_TOKEN_ONLY) {
            if (s.generatorHash != bytes32(0)) return (REASON_MUST_BE_ZERO, FIELD_GENERATOR_HASH);
        }
        // 23 coverSha256
        if (s.coverSha256 == bytes32(0)) return (REASON_ZERO_VALUE, FIELD_COVER_SHA256);
        // 24 revealListId
        if (s.boxType == BOX_TYPE_TOKEN_ONLY) {
            if (s.revealListId != bytes32(0)) return (REASON_MUST_BE_ZERO, FIELD_REVEAL_LIST_ID);
        }
        // 25 marketplaceOwner
        if (s.boxType == BOX_TYPE_TOKEN_ONLY) {
            if (s.marketplaceOwner != address(0)) return (REASON_MUST_BE_ZERO, FIELD_MARKETPLACE_OWNER);
        } else {
            if (s.marketplaceOwner == address(0)) return (REASON_ZERO_VALUE, FIELD_MARKETPLACE_OWNER);
        }
        // 28 collectionCoverSha256
        if (s.boxType == BOX_TYPE_TOKEN_ONLY) {
            if (s.collectionCoverSha256 != bytes32(0)) return (REASON_MUST_BE_ZERO, FIELD_COLLECTION_COVER_SHA256);
        } else {
            if (s.collectionCoverSha256 == bytes32(0)) return (REASON_ZERO_VALUE, FIELD_COLLECTION_COVER_SHA256);
        }
        return (REASON_OK, 0);
    }

    // ------------------------------------------------------------------------------------------- add-ons
    function _checkAddOns(BoxSpec memory s) private pure returns (uint16, uint16) {
        uint256 count = s.addOns.length;
        if (count > MAX_ADD_ONS) return (REASON_TOO_MANY_ADD_ONS, FIELD_ADD_ONS);
        for (uint256 i; i < count; ++i) {
            uint16 id = s.addOns[i].id;
            if (i != 0) {
                uint16 previous = s.addOns[i - 1].id;
                if (id < previous || (id == previous && !_repeatable(id))) return (REASON_ADD_ON_ORDER, FIELD_ADD_ONS);
            }
            (uint16 r, uint16 f) = _checkAddOn(s, id, s.addOns[i].params);
            if (r != REASON_OK) return (r, f);
        }
        return (REASON_OK, 0);
    }

    function _repeatable(uint16 id) private pure returns (bool) {
        return id == ADD_ON_EDITION_SPECIALS;
    }

    function _checkAddOn(BoxSpec memory s, uint16 id, bytes memory p) private pure returns (uint16, uint16) {
        if (id == ADD_ON_PLACEHOLDERS) return _checkPlaceholders(s, p);
        if (id == ADD_ON_PER_ITEM_STREAM) return _checkPerItemStream(s, p);
        if (id == ADD_ON_EDITION_SPECIALS) return _checkEditionSpecials(s, p);
        if (id == ADD_ON_ROYALTIES) return _checkRoyalties(s, p);
        if (id == ADD_ON_CREATOR_FEE_CAP) return _checkCreatorFeeCap(s, p);
        if (id == ADD_ON_COLLECTION_METADATA) return _checkCollectionMetadata(s, p);
        return (REASON_ADD_ON_UNKNOWN, FIELD_ADD_ONS);
    }

    /// @dev Add-on 1 `placeholders`: Placeholders: tickets during the curve, hidden art revealed by draws.
    function _checkPlaceholders(BoxSpec memory s, bytes memory p) private pure returns (uint16, uint16) {
        if (!(s.version == 1 || s.version == 2)) return (REASON_ADD_ON_NOT_AVAILABLE, FIELD_ADD_ON_PLACEHOLDERS);
        if (!(s.boxType == BOX_TYPE_NEW_COLLECTION)) return (REASON_ADD_ON_CONFLICT, FIELD_ADD_ON_PLACEHOLDERS);
        uint8[] memory kinds = new uint8[](5);
        kinds[0] = _K_STRING;
        kinds[1] = _K_STRING;
        kinds[2] = _K_STRING;
        kinds[3] = _K_STRING;
        kinds[4] = _K_STRING;
        (bool ok, uint256[] memory w) = _canonical(p, kinds);
        if (!ok) return (REASON_ADD_ON_PARAMS_MALFORMED, FIELD_ADD_ON_PLACEHOLDERS);
        uint16 r;
        r = _checkStringAt(p, w[0], 1, 32, RULE_JSON_TEXT);
        if (r != REASON_OK) return (r, FIELD_ADD_ON_PLACEHOLDERS_PLACEHOLDER_NAME);
        r = _checkStringAt(p, w[1], 1, 11, RULE_JSON_TEXT);
        if (r != REASON_OK) return (r, FIELD_ADD_ON_PLACEHOLDERS_PLACEHOLDER_SYMBOL);
        r = _checkStringAt(p, w[2], 0, 1024, RULE_JSON_TEXT);
        if (r != REASON_OK) return (r, FIELD_ADD_ON_PLACEHOLDERS_PLACEHOLDER_DESCRIPTION);
        r = _checkStringAt(p, w[3], 0, 1024, RULE_JSON_TEXT);
        if (r != REASON_OK) return (r, FIELD_ADD_ON_PLACEHOLDERS_HIDDEN_DESCRIPTION);
        r = _checkStringAt(p, w[4], 1, 4096, RULE_SVG);
        if (r != REASON_OK) return (r, FIELD_ADD_ON_PLACEHOLDERS_HIDDEN_SVG);
        if (!(s.artMode == ART_MODE_HIDDEN)) return (REASON_ADD_ON_CONFLICT, FIELD_ADD_ON_PLACEHOLDERS);
        return (REASON_OK, 0);
    }

    /// @dev Add-on 2 `per-item-stream`: Per-item stream: the T-side reward share streams to each item.
    function _checkPerItemStream(BoxSpec memory s, bytes memory p) private pure returns (uint16, uint16) {
        if (!(s.version == 1)) return (REASON_ADD_ON_NOT_AVAILABLE, FIELD_ADD_ON_PER_ITEM_STREAM);
        if (!(s.boxType == BOX_TYPE_NEW_COLLECTION)) return (REASON_ADD_ON_CONFLICT, FIELD_ADD_ON_PER_ITEM_STREAM);
        if (p.length != 0) return (REASON_ADD_ON_PARAMS_MALFORMED, FIELD_ADD_ON_PER_ITEM_STREAM);
        if (!(s.tStream == T_STREAM_PER_ITEM_STREAM)) return (REASON_ADD_ON_CONFLICT, FIELD_ADD_ON_PER_ITEM_STREAM);
        return (REASON_OK, 0);
    }

    /// @dev Add-on 3 `edition-specials`: Edition specials: named series of special items, shown as counts.
    function _checkEditionSpecials(BoxSpec memory s, bytes memory p) private pure returns (uint16, uint16) {
        if (!(s.version == 1 || s.version == 2)) return (REASON_ADD_ON_NOT_AVAILABLE, FIELD_ADD_ON_EDITION_SPECIALS);
        if (!(s.boxType == BOX_TYPE_NEW_COLLECTION)) return (REASON_ADD_ON_CONFLICT, FIELD_ADD_ON_EDITION_SPECIALS);
        uint8[] memory kinds = new uint8[](2);
        kinds[0] = _K_STRING;
        kinds[1] = _K_UINT32;
        (bool ok, uint256[] memory w) = _canonical(p, kinds);
        if (!ok) return (REASON_ADD_ON_PARAMS_MALFORMED, FIELD_ADD_ON_EDITION_SPECIALS);
        uint16 r;
        r = _checkStringAt(p, w[0], 1, 32, RULE_JSON_TEXT);
        if (r != REASON_OK) return (r, FIELD_ADD_ON_EDITION_SPECIALS_LABEL);
        if (w[1] < 1 || w[1] > uint256(s.n)) return (REASON_OUT_OF_RANGE, FIELD_ADD_ON_EDITION_SPECIALS_COUNT);
        return (REASON_OK, 0);
    }

    /// @dev Add-on 4 `royalties`: Royalties: an unenforced ERC-2981 rate and where the royalty goes.
    function _checkRoyalties(BoxSpec memory s, bytes memory p) private pure returns (uint16, uint16) {
        if (!(s.version == 1 || s.version == 2)) return (REASON_ADD_ON_NOT_AVAILABLE, FIELD_ADD_ON_ROYALTIES);
        if (!(s.boxType == BOX_TYPE_NEW_COLLECTION)) return (REASON_ADD_ON_CONFLICT, FIELD_ADD_ON_ROYALTIES);
        uint8[] memory kinds = new uint8[](2);
        kinds[0] = _K_UINT16;
        kinds[1] = _K_UINT8;
        (bool ok, uint256[] memory w) = _canonical(p, kinds);
        if (!ok) return (REASON_ADD_ON_PARAMS_MALFORMED, FIELD_ADD_ON_ROYALTIES);
        if (!(w[0] == 0 || w[0] == 100 || w[0] == 250 || w[0] == 500)) return (REASON_NOT_A_MEMBER, FIELD_ADD_ON_ROYALTIES_BPS);
        if (!(w[1] == ROYALTY_DESTINATION_FEE_HANDLING || w[1] == ROYALTY_DESTINATION_CREATOR || w[1] == ROYALTY_DESTINATION_POOL_DEPTH)) return (REASON_NOT_A_MEMBER, FIELD_ADD_ON_ROYALTIES_DESTINATION);
        if (!((s.version != 1 || w[1] != ROYALTY_DESTINATION_CREATOR))) return (REASON_ADD_ON_CONFLICT, FIELD_ADD_ON_ROYALTIES);
        return (REASON_OK, 0);
    }

    /// @dev Add-on 5 `creator-fee-cap`: Creator-fee cap: at most a fixed amount per 30 days to the creator.
    function _checkCreatorFeeCap(BoxSpec memory s, bytes memory p) private pure returns (uint16, uint16) {
        if (!(s.version == 2)) return (REASON_ADD_ON_NOT_AVAILABLE, FIELD_ADD_ON_CREATOR_FEE_CAP);
        if (!(s.boxType == BOX_TYPE_NEW_COLLECTION || s.boxType == BOX_TYPE_TOKEN_ONLY)) return (REASON_ADD_ON_CONFLICT, FIELD_ADD_ON_CREATOR_FEE_CAP);
        uint8[] memory kinds = new uint8[](2);
        kinds[0] = _K_UINT256;
        kinds[1] = _K_UINT8;
        (bool ok, uint256[] memory w) = _canonical(p, kinds);
        if (!ok) return (REASON_ADD_ON_PARAMS_MALFORMED, FIELD_ADD_ON_CREATOR_FEE_CAP);
        if (!(BoxBuildV1.CREATOR_FEE_CAP_PRESET_0 == w[0] || BoxBuildV1.CREATOR_FEE_CAP_PRESET_1 == w[0] || BoxBuildV1.CREATOR_FEE_CAP_PRESET_2 == w[0] || BoxBuildV1.CREATOR_FEE_CAP_PRESET_3 == w[0] || BoxBuildV1.CREATOR_FEE_CAP_PRESET_4 == w[0])) return (REASON_NOT_A_MEMBER, FIELD_ADD_ON_CREATOR_FEE_CAP_CAP_PER_EPOCH);
        if (!(w[1] == CAP_EXCESS_HOLDERS || w[1] == CAP_EXCESS_BURN || w[1] == CAP_EXCESS_POOL_DEPTH)) return (REASON_NOT_A_MEMBER, FIELD_ADD_ON_CREATOR_FEE_CAP_EXCESS);
        if (!(w[1] == CAP_EXCESS_BURN || w[1] == CAP_EXCESS_POOL_DEPTH)) return (REASON_NOT_OFFERED, FIELD_ADD_ON_CREATOR_FEE_CAP_EXCESS);
        if (!(((s.qStream == Q_STREAM_TO_CREATOR || s.qStream == Q_STREAM_CREATOR_IN_T) || (s.tStream == T_STREAM_TO_CREATOR || s.tStream == T_STREAM_CREATOR_IN_Q)))) return (REASON_ADD_ON_CONFLICT, FIELD_ADD_ON_CREATOR_FEE_CAP);
        if (!((s.q == address(0)))) return (REASON_ADD_ON_CONFLICT, FIELD_ADD_ON_CREATOR_FEE_CAP);
        return (REASON_OK, 0);
    }

    /// @dev Add-on 6 `collection-metadata`: Collection page: banner, teasers and link (contractURI, ERC-7572).
    function _checkCollectionMetadata(BoxSpec memory s, bytes memory p) private pure returns (uint16, uint16) {
        if (!(s.version == 1 || s.version == 2)) return (REASON_ADD_ON_NOT_AVAILABLE, FIELD_ADD_ON_COLLECTION_METADATA);
        if (!(s.boxType == BOX_TYPE_NEW_COLLECTION)) return (REASON_ADD_ON_CONFLICT, FIELD_ADD_ON_COLLECTION_METADATA);
        uint8[] memory kinds = new uint8[](3);
        kinds[0] = _K_BYTES32;
        kinds[1] = _K_BYTES32_ARRAY;
        kinds[2] = _K_STRING;
        (bool ok, uint256[] memory w) = _canonical(p, kinds);
        if (!ok) return (REASON_ADD_ON_PARAMS_MALFORMED, FIELD_ADD_ON_COLLECTION_METADATA);
        uint16 r;
        if (_word(p, w[1]) > 4) return (REASON_LENGTH_OUT_OF_RANGE, FIELD_ADD_ON_COLLECTION_METADATA_TEASER_SHA256S);
        if (!_nonZeroItems(p, w[1])) return (REASON_ZERO_VALUE, FIELD_ADD_ON_COLLECTION_METADATA_TEASER_SHA256S);
        r = _checkStringAt(p, w[2], 0, 128, RULE_URL);
        if (r != REASON_OK) return (r, FIELD_ADD_ON_COLLECTION_METADATA_EXTERNAL_LINK);
        return (REASON_OK, 0);
    }

    // ------------------------------------------------------------------------------------------- rules
    function _checkRules(BoxSpec memory s, VersionContext memory ctx) private pure returns (uint16, uint16) {
        // a token-only box is version 2 (P (F70): version 1 builds only box 0 (plan § 3.1); 'Nothing' is a choice for other people's boxes)
        if (s.boxType == BOX_TYPE_TOKEN_ONLY && !(s.version == 2)) {
            return (REASON_NOT_OFFERED, FIELD_BOX_TYPE);
        }
        // version 1 has no deadline (F44 F4; plan § 1 (NONE only in box 0's spec); BC-064)
        if (s.version == 1 && !(s.deadlineDays == 0)) {
            return (REASON_DEADLINE_RULE, FIELD_DEADLINE_DAYS);
        }
        // version 2 needs a deadline (F44 P6; BC-045)
        if (s.version == 2 && !((s.deadlineDays == 30 || s.deadlineDays == 60 || s.deadlineDays == 90 || s.deadlineDays == 180))) {
            return (REASON_DEADLINE_RULE, FIELD_DEADLINE_DAYS);
        }
        // BURN_Q only for a Q with a real burn (BP-13; BC-014; box-factory § 2.3)
        if (s.qStream == Q_STREAM_BURN_Q && !((_qClassOf(s.q, ctx.qList) == Q_CLASS_FIT || _qClassOf(s.q, ctx.qList) == Q_CLASS_BOX_T))) {
            return (REASON_MENU_RULE, FIELD_Q_STREAM);
        }
        // SELL_FOR_Q never with BUYBACK_BURN_T (BP-13; box-factory § 2.3)
        if (s.tStream == T_STREAM_SELL_FOR_Q && !(s.qStream != Q_STREAM_BUYBACK_BURN_T)) {
            return (REASON_MENU_RULE, FIELD_T_STREAM);
        }
        // open art publishes its reveal list (plan § 1 and § 3.1; BC-052)
        if (s.artMode == ART_MODE_OPEN && !(!(s.revealListId == bytes32(0)))) {
            return (REASON_ZERO_VALUE, FIELD_REVEAL_LIST_ID);
        }
        // hidden art keeps its reveal list private (P (S1): a published list would reveal hidden art at creation)
        if (s.artMode == ART_MODE_HIDDEN && !((s.revealListId == bytes32(0)))) {
            return (REASON_MUST_BE_ZERO, FIELD_REVEAL_LIST_ID);
        }
        // hidden art needs the placeholders add-on (F55: hidden art revealed by draws is the placeholders add-on; its picture, texts and safety net come with it)
        if (s.artMode == ART_MODE_HIDDEN && !(_hasAddOn(s, ADD_ON_PLACEHOLDERS))) {
            return (REASON_ADD_ON_REQUIRED, FIELD_ART_MODE);
        }
        // the per-item stream action needs its add-on (plan § 1 (PER_ITEM_STREAM); BC-014; BC-065)
        if (s.tStream == T_STREAM_PER_ITEM_STREAM && !(_hasAddOn(s, ADD_ON_PER_ITEM_STREAM))) {
            return (REASON_ADD_ON_REQUIRED, FIELD_T_STREAM);
        }
        // the creator option on the buyers' side is for other people's boxes (F68 (3) ('for other people's boxes'); F77: box 0's split is 11/15 FIT, 2/15 its own pool, 2/15 platform (capped); F70: per fee side. Replaces 'the creator takes the whole reward side or none of it' (F68 (3), P), which F70 supersedes)
        if ((s.qStream == Q_STREAM_TO_CREATOR || s.qStream == Q_STREAM_CREATOR_IN_T) && !(s.version == 2)) {
            return (REASON_MENU_RULE, FIELD_Q_STREAM);
        }
        // the creator option on the sellers' side is for other people's boxes (F68 (3); F70: per fee side)
        if ((s.tStream == T_STREAM_TO_CREATOR || s.tStream == T_STREAM_CREATOR_IN_Q) && !(s.version == 2)) {
            return (REASON_MENU_RULE, FIELD_T_STREAM);
        }
        // the creator option names its recipient (F68 (3); F70: a creator kind on either side; F72 (3) and core v1: royalties to CREATOR are paid to the same payee (add-on 4 has no recipient; V BoxReceiverExtension.sol `initialize`))
        if (((s.qStream == Q_STREAM_TO_CREATOR || s.qStream == Q_STREAM_CREATOR_IN_T) || (s.tStream == T_STREAM_TO_CREATOR || s.tStream == T_STREAM_CREATOR_IN_Q) || _addOnWordIs(s, ADD_ON_ROYALTIES, 1, ROYALTY_DESTINATION_CREATOR)) && !(!(s.creatorFeeRecipient == address(0)))) {
            return (REASON_ZERO_VALUE, FIELD_CREATOR_FEE_RECIPIENT);
        }
        // no fee recipient without the creator option (P (fee-model pass): one spec, one meaning; a recipient nobody is paid would only mislead the box page)
        if (!(((s.qStream == Q_STREAM_TO_CREATOR || s.qStream == Q_STREAM_CREATOR_IN_T) || (s.tStream == T_STREAM_TO_CREATOR || s.tStream == T_STREAM_CREATOR_IN_Q) || _addOnWordIs(s, ADD_ON_ROYALTIES, 1, ROYALTY_DESTINATION_CREATOR))) && !((s.creatorFeeRecipient == address(0)))) {
            return (REASON_MUST_BE_ZERO, FIELD_CREATOR_FEE_RECIPIENT);
        }
        // box 0 has no creator buy (F61 O2 allows a creator buy before the open for other people's boxes only; box 0 (version 1) has none)
        if (s.version == 1 && !((s.creatorBuy == 0))) {
            return (REASON_MUST_BE_ZERO, FIELD_CREATOR_BUY);
        }
        // the creator buy cannot fill the curve (P (fee-model pass): a buy of the raise would close the curve before it opens (D1); after the 1% LP fee anything below the raise leaves part of the curve open. No other cap (F61 O2, F66 X6))
        if (!(s.creatorBuy == 0) && !(s.creatorBuy < s.raise)) {
            return (REASON_OUT_OF_RANGE, FIELD_CREATOR_BUY);
        }
        return (REASON_OK, 0);
    }

    // ------------------------------------------------------------------------------------------- helpers
    uint8 private constant _K_UINT8 = 1;
    uint8 private constant _K_UINT16 = 2;
    uint8 private constant _K_UINT32 = 3;
    uint8 private constant _K_UINT64 = 4;
    uint8 private constant _K_UINT128 = 5;
    uint8 private constant _K_UINT256 = 6;
    uint8 private constant _K_BOOL = 7;
    uint8 private constant _K_ADDRESS = 8;
    uint8 private constant _K_BYTES32 = 9;
    uint8 private constant _K_STRING = 10;
    uint8 private constant _K_BYTES32_ARRAY = 11;

    /// @dev Bytes rule JSON_TEXT allows: 0x20-0x21, 0x23-0x5b, 0x5d-0x7e.
    uint256 private constant _MASK_JSON_TEXT = 0x000000000000000000000000000000007fffffffeffffffffffffffb00000000;
    /// @dev Bytes rule SVG allows: 0x20-0x7e.
    uint256 private constant _MASK_SVG = 0x000000000000000000000000000000007fffffffffffffffffffffff00000000;
    /// @dev Bytes rule URL allows: 0x21, 0x23-0x3b, 0x3d, 0x3f-0x5b, 0x5d, 0x5f, 0x61-0x7a, 0x7e.
    uint256 private constant _MASK_URL = 0x0000000000000000000000000000000047fffffeafffffffaffffffa00000000;

    function _mask(uint8 rule) private pure returns (uint256) {
        if (rule == RULE_JSON_TEXT) return _MASK_JSON_TEXT;
        if (rule == RULE_SVG) return _MASK_SVG;
        if (rule == RULE_URL) return _MASK_URL;
        return 0;
    }

    function _needsPrefix(uint8 rule) private pure returns (bool) {
        return rule == RULE_URL;
    }

    /// @dev The prefix a non-empty string of the rule must start with (none: empty).
    function _prefix(uint8 rule) private pure returns (bytes memory) {
        if (rule == RULE_URL) return "https://";
        return "";
    }

    function _checkString(bytes memory b, uint256 minBytes, uint256 maxBytes, uint8 rule) private pure returns (uint16) {
        uint256 len = b.length;
        if (len < minBytes || len > maxBytes) return REASON_LENGTH_OUT_OF_RANGE;
        if (!_allBytesAllowed(b, 0, len, _mask(rule))) return REASON_BAD_CHARACTER;
        return _hasPrefix(b, 0, len, rule) ? REASON_OK : REASON_BAD_CHARACTER;
    }

    /// @dev A string inside canonical params: its length word at `offset`, its bytes right after.
    function _checkStringAt(bytes memory p, uint256 offset, uint256 minBytes, uint256 maxBytes, uint8 rule)
        private
        pure
        returns (uint16)
    {
        uint256 len = _word(p, offset);
        if (len < minBytes || len > maxBytes) return REASON_LENGTH_OUT_OF_RANGE;
        if (!_allBytesAllowed(p, offset + 32, len, _mask(rule))) return REASON_BAD_CHARACTER;
        return _hasPrefix(p, offset + 32, len, rule) ? REASON_OK : REASON_BAD_CHARACTER;
    }

    /// @dev True when the rule needs no prefix, the string is empty, or b[start, start + len) starts with the rule's
    /// prefix (the caller checked that the range lies inside `b`).
    function _hasPrefix(bytes memory b, uint256 start, uint256 len, uint8 rule) private pure returns (bool) {
        if (len == 0 || !_needsPrefix(rule)) return true;
        bytes memory prefix = _prefix(rule);
        if (len < prefix.length) return false;
        for (uint256 j; j < prefix.length; ++j) {
            if (b[start + j] != prefix[j]) return false;
        }
        return true;
    }

    /// @dev A canonical bytes32[] in params: its length word at `offset` (checked by `_canonical`), its items after.
    function _nonZeroItems(bytes memory p, uint256 offset) private pure returns (bool) {
        uint256 count = _word(p, offset);
        for (uint256 j; j < count; ++j) {
            if (_word(p, offset + 32 + 32 * j) == 0) return false;
        }
        return true;
    }

    /// @dev True when every byte of b[start, start + len) has its bit set in `mask`. The callers checked that the
    /// range lies inside `b` (a string's own length, or canonical params). Each byte is read as the low byte of the
    /// word ending at it, so every read stays inside `b`'s allocation (its length word and data).
    function _allBytesAllowed(bytes memory b, uint256 start, uint256 len, uint256 mask) private pure returns (bool ok) {
        ok = true;
        assembly ("memory-safe") {
            let p := add(add(b, 0x20), start)
            let end := add(p, len)
            for {} lt(p, end) { p := add(p, 1) } {
                if iszero(and(shr(and(mload(sub(p, 31)), 0xff), mask), 1)) {
                    ok := 0
                    break
                }
            }
        }
    }

    /// @dev Format v1 of the metadata table, BoxMetadataTable.validate's rules (core item 9): version byte 1, a uint16
    /// big-endian description length and the description, at most MAX_TRAIT_TYPES types, then per type a name of at
    /// least one byte, a value count of at least one and each value of at least one byte, every text JSON_TEXT, and
    /// nothing after the last value. Never reverts: every offset is compared with the table's length before a read.
    function _tableV1(bytes memory t) private pure returns (bool) {
        uint256 len = t.length;
        if (len < 3 || uint8(t[0]) != 1) return false;
        uint256 mask = _mask(RULE_JSON_TEXT);
        uint256 c = 3 + ((uint256(uint8(t[1])) << 8) | uint256(uint8(t[2])));
        if (c >= len || !_allBytesAllowed(t, 3, c - 3, mask)) return false;
        uint256 types = uint8(t[c++]);
        if (types > MAX_TRAIT_TYPES) return false;
        bool ok;
        for (uint256 i; i < types; ++i) {
            (ok, c) = _tableText(t, c, mask);
            if (!ok || c >= len) return false;
            uint256 values = uint8(t[c++]);
            if (values == 0) return false;
            for (uint256 v; v < values; ++v) {
                (ok, c) = _tableText(t, c, mask);
                if (!ok) return false;
            }
        }
        return c == len;
    }

    /// @dev One text of the table at `c`: a length byte of at least 1, then that many JSON_TEXT bytes inside `t`.
    /// Returns whether it holds and the offset after it.
    function _tableText(bytes memory t, uint256 c, uint256 mask) private pure returns (bool, uint256) {
        if (c >= t.length) return (false, c);
        uint256 n = uint8(t[c]);
        uint256 end = c + 1 + n;
        if (n == 0 || end > t.length || !_allBytesAllowed(t, c + 1, n, mask)) return (false, c);
        return (true, end);
    }

    /// @dev `ok` when `p` is exactly the canonical abi.encode of a tuple of `kinds` (strings and bytes32[] the only
    /// dynamic types): head words in order, each dynamic part's offset the next free position, zero padding, no
    /// trailing bytes, every static value inside its type. `w` holds the static values and, for a dynamic part, the
    /// offset of its length word. Never reverts: every length is compared with `p.length` before any arithmetic on it.
    /// Each early return leaves `ok` false.
    function _canonical(bytes memory p, uint8[] memory kinds) private pure returns (bool ok, uint256[] memory w) {
        uint256 k = kinds.length;
        w = new uint256[](k);
        uint256 size = p.length;
        uint256 cursor = k * 32;
        if (size < cursor) return (ok, w);
        for (uint256 i; i < k; ++i) {
            uint256 v = _word(p, i * 32);
            if (kinds[i] == _K_STRING) {
                if (v != cursor || size - cursor < 32) return (ok, w);
                uint256 len = _word(p, cursor);
                if (len > size) return (ok, w);
                uint256 padded = (len + 31) & ~uint256(31);
                if (size - cursor - 32 < padded) return (ok, w);
                uint256 end = cursor + 32 + padded;
                for (uint256 j = cursor + 32 + len; j < end; ++j) {
                    if (p[j] != 0) return (ok, w);
                }
                w[i] = cursor;
                cursor = end;
            } else if (kinds[i] == _K_BYTES32_ARRAY) {
                if (v != cursor || size - cursor < 32) return (ok, w);
                uint256 count = _word(p, cursor);
                if (count > (size - cursor - 32) / 32) return (ok, w);
                w[i] = cursor;
                cursor = cursor + 32 + 32 * count;
            } else {
                if (!_fits(kinds[i], v)) return (ok, w);
                w[i] = v;
            }
        }
        ok = cursor == size;
    }

    function _fits(uint8 kind, uint256 v) private pure returns (bool) {
        if (kind == _K_UINT256 || kind == _K_BYTES32) return true;
        if (kind == _K_BOOL) return v <= 1;
        if (kind == _K_ADDRESS) return v >> 160 == 0;
        // _K_UINT8 ... _K_UINT128: 8, 16, 32, 64 or 128 bits.
        return v >> (uint256(8) << (kind - 1)) == 0;
    }

    function _word(bytes memory p, uint256 offset) private pure returns (uint256 v) {
        assembly ("memory-safe") {
            v := mload(add(add(p, 0x20), offset))
        }
    }

    function _hasAddOn(BoxSpec memory s, uint16 id) private pure returns (bool) {
        for (uint256 i; i < s.addOns.length; ++i) {
            if (s.addOns[i].id == id) return true;
        }
        return false;
    }

    /// @dev True when an entry of add-on `id` holds `value` in head word `index` of its params. Only rules call it, and
    /// rules run after every add-on passed its own checks, so each entry's params hold at least its head words.
    function _addOnWordIs(BoxSpec memory s, uint16 id, uint256 index, uint256 value) private pure returns (bool) {
        for (uint256 i; i < s.addOns.length; ++i) {
            if (s.addOns[i].id == id && _word(s.addOns[i].params, 32 * index) == value) return true;
        }
        return false;
    }

    function _inList(uint8 v, uint8[] memory list) private pure returns (bool) {
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == v) return true;
        }
        return false;
    }

    function _isListed(address q, QAsset[] memory qList) private pure returns (bool) {
        for (uint256 i; i < qList.length; ++i) {
            if (qList[i].token == q) return true;
        }
        return false;
    }

    /// @dev The first listed entry for `q` decides (as in `_qClassOf`).
    function _isPreset(address q, uint256 raise, QAsset[] memory qList) private pure returns (bool) {
        for (uint256 i; i < qList.length; ++i) {
            if (qList[i].token != q) continue;
            uint256[] memory presets = qList[i].raisePresets;
            for (uint256 j; j < presets.length; ++j) {
                if (presets[j] == raise) return true;
            }
            return false;
        }
        return false;
    }

    function _qClassOf(address q, QAsset[] memory qList) private pure returns (uint8) {
        for (uint256 i; i < qList.length; ++i) {
            if (qList[i].token == q) return qList[i].qClass;
        }
        return 0;
    }
}
