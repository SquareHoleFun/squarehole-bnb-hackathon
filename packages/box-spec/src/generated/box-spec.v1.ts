// GENERATED FILE, do not edit: packages/box-spec/scripts/generate.mjs writes it from packages/box-spec/box-spec.v1.json
// and packages/box-spec/add-ons.v1.json (`pnpm box-spec:write`); `pnpm check:box-spec` (in `pnpm verify`) fails when stale.
// The Solidity twin is packages/contracts/src/box/BoxSpecV1.sol; both run the shared vectors (BC-001).
import { decodeAbiParameters, encodeAbiParameters, hexToBytes, keccak256, stringToHex, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { canonicalParams, checkString, checkStringAt, hexLength, isZeroHex, nonZeroItems, ParamKind, readWordAt, sameAddress, tableV1, type Verdict, word } from '../runtime';

// ------------------------------------------------------------------------------------------------ fixed values
/** this file (S1) */
export const SPEC_FORMAT_VERSION = 1;
/** V FitLaunchShape.sol:43 (1e27 raw T per box) */
export const ISSUANCE = 1000000000000000000000000000n;
/** box-factory.md § 2.5 'The curve (now, P)': 80% of T on a curve rising about 14.7 times; the layout centres it at the price where 80% of T buys the raise */
export const CURVE_SHARE_TARGET = 800000000000000000000000000n;
/** V FitLaunchShape.sol:58 */
export const TICK_SPACING = 60;
/** plan § 1: span 26,880 ticks (k = 1.0001^26,880 ~ 14.70) = 204,060 - 177,180 (V FitLaunchShape.sol:46-47) */
export const CURVE_SPAN_TICKS = 26880;
/** V FitLaunchShape.sol:93 */
export const MIN_USABLE_TICK = -887220;
/** V FitLaunchShape.sol:94 */
export const MAX_USABLE_TICK = 887220;
/** V FitLaunchShape.sol:57 (static 1%) */
export const LP_FEE = 10000;
/** V FitLaunchShape.sol:101 (layout b': 99% of the curve's Q in the bid) */
export const BID_SHARE_PERCENT = 99n;
/** V FitPoolHook.sol:151-156 (0x2AE0) */
export const HOOK_FLAGS = 10976n;
/** V FitPoolHook.sol:233-234 (0x91: Uniswap's hook policy treats it differently, ADR-0006 context 3); a mined hook address must not start with it */
export const HOOK_FORBIDDEN_ADDRESS_PREFIX = 145;
/** F80 (open-at-clock-time.md § 2.4): the launch window's steps, one per entry of the tax table (V FitLaunchShape.sol:63; LaunchTaxRouter.sol:92, where a step is a block) */
export const WINDOW_STEPS = 32n;
/** F80 (open-at-clock-time.md § 2.4): one tax step lasts 12 seconds, one Ethereum slot; step = (block.timestamp - openAt) / 12, rounded down */
export const TAX_STEP_SECONDS = 12n;
/** F80: WINDOW_STEPS x TAX_STEP_SECONDS, 6.4 minutes from openAt (v2: 32 blocks) */
export const WINDOW_SECONDS = 384n;
/** V LaunchTaxRouter.sol:33-37, :221 (93.1974% in the window's first step, v2's first block; pips, 10^6 = 100%) */
export const LAUNCH_TAX_PIPS_BLOCK_0 = 931974;
/** V LaunchTaxRouter.sol:33-37, :252 (8.0565% in the window's last step, v2's last block; 0 afterwards) */
export const LAUNCH_TAX_PIPS_BLOCK_31 = 80565;
/** keccak256(abi.encode(LaunchTaxRouter.taxTable())), the 32 entries at V LaunchTaxRouter.sol:219-254 (the hash it says is published with the launch, :218); the same table for every box, as k = 1.0001^CURVE_SPAN_TICKS is fixed */
export const LAUNCH_TAX_TABLE_HASH: Hex = '0x92df36308343b3602e90e5f33e532c39e82e06395bea65656c29f0d2d77dffcc';
/** F80 (open-at-clock-time.md § 2.1): 2026-09-01 00:00:00 UTC; a non-zero openAt below it is a unit mistake (a block count or a delay typed into the field), refused OUT_OF_RANGE */
export const MIN_OPEN_AT = 1788220800;
/** F80 (open-at-clock-time.md § 2.1): 14 days, the old 100,800-block maximum (V FitLaunchShape.sol:68) at 12 s; checked by the factory against the creation block's time (OpenAtTooFar), not by the pure validate() */
export const MAX_OPEN_AHEAD_SECONDS = 1209600n;
/** V FitLaunchShape.sol:55 (0.0015 ETH) */
export const BOOTSTRAP_ETH = 1500000000000000n;
/** V MisfitsGenesis.sol:174 (F23 C3) */
export const DRAW_FEE_BPS = 100n;
/** V MisfitsGenesis.sol:175 (F23 C3) */
export const PICK_FEE_BPS = 2500n;
/** V MisfitsGenesis.sol:176 (F23 C3) */
export const RETURN_FEE_BPS = 500n;
/** fee shares in fifteenths, remainders carried: V BuybackBurner.sol:191 (box 0); F68 (3) (other boxes: 10/15, 3/15, 2/15) */
export const FEE_SHARE_DENOMINATOR = 15n;
/** F68 (3); plan § 3.6: other boxes' reward side, 10/15 of each fee stream to the creator's stream actions, or to creatorFeeRecipient with a creator kind (F70: chosen per side, paid in T or Q). Both sides V BoxReceiver.sol `_split` (core v1: sellers' fees split three ways too); S5.M1: BUYBACK_BURN_T's and CREATOR_IN_T's share, and CREATOR_IN_Q's, go to the swap module's ledgers (`_rewardQ`, `_split`), held until the settlement */
export const FEE_SHARE_Q_STREAM = 10n;
/** F64, F68 (3); plan § 3.6: other boxes' 3/15 to FIT buy-and-burn (through fundBudget()). Q side V BoxReceiver.sol `_split`; T side V `_split`: it waits in the receiver (fitWaitingT). Founder question 9 answered by R F75 W4: sold for Q after graduation in small capped steps, the Q buying and burning FIT; S5.M1 hands it to the box's swap module after the settlement (V BoxReceiver.sol `pullForModule`), whose sells are S5.M2 */
export const FEE_SHARE_FIT = 3n;
/** F64, F68 (3), F72 (B), F77: every box's 2/15 of both sides, box 0's included (F77: one constant means every box's 2/15), goes into the box's own pool depth by pair and lock: held in the receiver until graduation (depthHeld, BC-109, BC-143), then the hook's claims, which deepen() adds as one full-range position at DEPTH_PAIR_SALT once both sides reach DEPTH_MIN_ADD_BPS_OF_RAISE (V BoxReceiver.sol `_split`, `_creditDepth`, `_settleGraduation`; BoxHookExtension `_planDeepen`). launch-pipeline-v1.md § 6 question 5 answered by F72 (B). A Q-only inflow buys its T in small capped steps through deepen()'s depth conversions (R F76; S5.M5, BoxHookExtension `_planConvert`; DEPTH_CONVERT_SHARE_BPS, DEPTH_CONVERT_MIN_Q) and pairs once both sides reach the minimum. Box 0: FEE_SHARE_DEPTH + BOX0_FEE_SHARE_FIT + BOX0_FEE_SHARE_PLATFORM = 15 (buyers' side) and FEE_SHARE_DEPTH + BOX0_FEE_SHARE_T_BURN = 15 (sellers' side). Other boxes never pay the platform (BC-015, BC-109). Replaces FEE_SHARE_PLATFORM (plan § 3.6's 2/15 to the platform) */
export const FEE_SHARE_DEPTH = 2n;
/** R F77 (2026-10-03, 'the Misfits like all the others'): box 0's buyers' fees (Q) give 11/15 to FIT buy-and-burn through FIT's executor (held until graduation, BC-020), next to 2/15 into its own pool (FEE_SHARE_DEPTH) and 2/15 to the platform (BOX0_FEE_SHARE_PLATFORM); V BoxReceiver.sol `_split`. Was 13/15 (F23 C3; V BuybackBurner.sol:140, :190-191, the deployed v2 executor, which keeps it) */
export const BOX0_FEE_SHARE_FIT = 11n;
/** V BuybackBurner.sol:140, :190-191 (box 0: 2/15 to the treasury; F23 C3), capped from S5 at PLATFORM_CAP_WEI per PLATFORM_EPOCH_SECONDS (F62, F64; V BoxReceiver.sol `_capPlatform`): today's v2 executor pays it uncapped. The platform's only income (F64, F77): buyers' side only, never the sellers' side, the sniper tax or another box's fees */
export const BOX0_FEE_SHARE_PLATFORM = 2n;
/** R F77: box 0's sellers' fees (T = FIT) give 13/15 to be burned (T_STREAM_BURN_T; a burn the vault's floor refuses waits, BC-016), or after graduation to the per-item stream (T_STREAM_PER_ITEM_STREAM, S8), and 2/15 into its own pool (FEE_SHARE_DEPTH); exact fifteenths with the remainder carried, as every box's (V BoxReceiver.sol `_split`; BC-139). Was all of the T side */
export const BOX0_FEE_SHARE_T_BURN = 13n;
/** F62, F64: box 0's capped receiver keeps at most 32 ETH per epoch for the platform from box 0's 2/15 and its royalties (F65); the rest goes into box 0's own pool depth. Set in ETH, no price feed (F61 PS1). The Misfits' launch-window (sniper) tax is not platform income: it goes into box 0's own pool after graduation like every box's (F77 supersedes F68 (1b); BC-140), so it is neither inside nor outside this cap. Cases BC-106, BC-107, BC-141 */
export const PLATFORM_CAP_WEI = 32000000000000000000n;
/** F62 (32 ETH per 30 days): epoch = floor((now - graduation) / 30 days), no carry-over; box 0's 2/15 held before graduation counts in epoch 0 (dynamic-pool-share.md § 1.1; BC-106) */
export const PLATFORM_EPOCH_SECONDS = 2592000;
/** plan § 3.6 (D2): collect() refuses batches below 0.005 ETH or the listed equivalent (S12 for other Q), except at graduation or failure; re-sized from measured gas (BC-017) */
export const FEE_BATCH_MIN_ETH = 5000000000000000n;
/** plan § 3.6 (D2): collect() pays its caller min(10% of the batch, FEE_BATCH_TIP_MAX_ETH) */
export const FEE_BATCH_TIP_BPS = 1000n;
/** plan § 3.6 (D2): the tip's cap, 0.0005 ETH */
export const FEE_BATCH_TIP_MAX_ETH = 500000000000000n;
/** plan § 3.4 (D6): the graduation caller's reserve is topped up to 0.1% of R (0.0042069 ETH for box 0); BC-027. Built (V BoxCoordinator.sol:345-346, BoxHookBase.sol:185-187). R F75 W2: 'graduation reward stays 0.1% of the raise; our bot covers graduation when gas is high' (founder question 7: it pays this graduate() up to about 6.5 gwei today and 2.3 gwei after Glamsterdam, our keeper above that); the near-full-curve close-and-sell-back (about 0.002 ETH net, question 8) is accepted */
export const GRADUATION_REWARD_CAP_BPS = 10n;
/** plan § 3.6 (P8): FIT buy-and-burn batches open once the budget reaches 0.05% of FIT's market cap at its 1-hour average; BC-041 */
export const FIT_BURN_BATCH_MCAP_BPS = 5n;
/** V FitBuybackBurner.sol:41 (REVIEWED_TWAP_WINDOW) */
export const EXECUTOR_TWAP_WINDOW_SECONDS = 3600;
/** V FitBuybackBurner.sol:42 (REVIEWED_MAX_IMPACT_TICKS) */
export const EXECUTOR_MAX_IMPACT_TICKS = 49;
/** V FitBuybackBurner.sol:43 (REVIEWED_TWAP_BAND_TICKS) */
export const EXECUTOR_TWAP_BAND_TICKS = 99;
/** V FitBuybackBurner.sol:44 (REVIEWED_MAX_OBSERVATION_STEP) */
export const EXECUTOR_MAX_OBSERVATION_STEP = 100;
/** V FitBuybackBurner.sol:45 (REVIEWED_MAX_CHUNKS_PER_BLOCK) */
export const EXECUTOR_MAX_CHUNKS_PER_BLOCK = 1;
/** V FitBuybackBurner.sol:46 (REVIEWED_MIN_SQRT_PRICE_X96 = TickMath.MIN_SQRT_PRICE + 1); the pool fee and spacing are LP_FEE and TICK_SPACING (:39-40) */
export const EXECUTOR_MIN_SQRT_PRICE_X96 = 4295128740n;
/** docs/design/swap-module-v1.md § 4.6, § 10 (P, economic: the founder's; S5.M4 measured it and proposes to keep it, docs/evidence/SH-misfits-line.md § S5.M4): a swap module step whose budget, valued in Q at the reference tick, is below 0.005 ETH (= FEE_BATCH_MIN_ETH) waits (Stop.BelowStepMin), so tiny steps cannot farm tips; at it a steady step's 5% tip covers its gas up to 0.55 gwei under Glamsterdam (0.81 today), a full step's capped tip up to 1.11 gwei (1.62); S12: the listed equivalent. Used by BoxSwapModule (S5.M2, `_plan`; a sell's T valued by BoxSwapBounds.tInQ) */
export const SWAP_STEP_MIN_Q = 5000000000000000n;
/** docs/design/swap-module-v1.md § 4.6, § 10 (P): a step's caller gets min(5% of the step's Q, FEE_BATCH_TIP_MAX_ETH), paid in Q from the step itself, last (as DEPTH_TIP_BPS); used by BoxSwapBounds.tipOf (S5.M2: of a buy's input, reserved before sizing it, and of a sell's output); a full 49-tick step at graduation's depth spends about 0.0100 ETH, so its tip is at the cap already (SH-S5-swap § M2); S5.M4 measured it against every keeper path and proposes to keep it (economic: the founder's; docs/evidence/SH-misfits-line.md § S5.M4) */
export const SWAP_STEP_TIP_BPS = 500n;
/** docs/design/swap-module-v1.md § 4.4, § 10 (P): one step per box per block, all actions together (EXECUTOR_MAX_CHUNKS_PER_BLOCK's rule); the knob for slower W4 sells (R F75 W4: small capped steps); used by BoxSwapBounds.stepDue (S5.M2) */
export const SWAP_STEP_COOLDOWN_BLOCKS = 1n;
/** R F76 ('swapping half of it into T in small capped steps, then pairing'); docs/design/swap-module-v1.md § 8, § 10 (P for the bps form): a depth conversion inside deepen() spends at most half the unpaired Q, the 49-tick limit (EXECUTOR_MAX_IMPACT_TICKS) caps it further; every box, box 0 included since F77. Built in S5.M5 (BoxHookExtension `_planConvert`: x = min(DEPTH_CONVERT_SHARE_BPS of (Q budget - T value at spot), the Q budget less the tip), as exact input to BoxSwapBounds' buy limit; SH-S5-swap § M5) */
export const DEPTH_CONVERT_SHARE_BPS = 5000n;
/** docs/design/swap-module-v1.md § 8 rule 4, § 10 (P): a depth conversion alone waits below 0.005 ETH (= SWAP_STEP_MIN_Q), so it pays its gas and tip; a conversion followed by a pair in the same unlock has no separate minimum. Built in S5.M5 (BoxHookExtension `_planConvert`; DeepenSkip.ConvertBelowMin): below the minimum a conversion runs only when the pair is expected to follow (the minimum output at the limit, valued at spot, brings the T side to MIN_ADD with the Q side still at it). S5 review: the minimum is checked on what the swap can spend, the smaller of its ceiling and the room to its limit (BoxSwapBounds.buyInput), so a sliver of room left by a push to the band's edge or the box's own buy-back is a skip that starts no cooldown */
export const DEPTH_CONVERT_MIN_Q = 5000000000000000n;
/** plan § 1 (firstId fixed by the version); V MisfitsGenesis.sol:172 */
export const FIRST_ID = 1n;
/** BC-008 (factory-built N from 10) */
export const MIN_N = 10;
/** BC-008; box-factory § 2.6 */
export const MAX_N = 10000;
/** plan § 1 */
export const MAX_TOKEN_NAME_BYTES = 32n;
/** plan § 1 */
export const MAX_SYMBOL_BYTES = 11n;
/** plan § 1 */
export const MAX_TEXT_BYTES = 1024n;
/** plan § 1 (the placeholders add-on's hidden picture) */
export const MAX_SVG_BYTES = 4096n;
/** V MisfitsCollection.sol:122 (EIP-170 less the STOP prefix) */
export const MAX_METADATA_TABLE_BYTES = 24575n;
/** V BoxMetadataTable.sol:22 (MAX_TRAIT_TYPES: 16 types × one byte = traitsPacked's 128 bits); validate() refuses a table with more (METADATA_TABLE_MALFORMED, core item 9) */
export const MAX_TRAIT_TYPES = 16n;
/** P (S1): a bound on the list, so validate() stays cheap */
export const MAX_ADD_ONS = 8n;
/** DECISION-LOG F44 (box 0's marketplaceOwner; the platform's fixed Safe) */
export const PLATFORM_SAFE_MAINNET: Address = '0xdCE82e76456434d0f550b492Ff212A862221e6c5';
/** V BoxHookBase.sol:59 (BoxHook.DEEPEN_COOLDOWN_BLOCKS): blocks between two depth adds, the first counted from the migration (core v1) */
export const DEPTH_COOLDOWN_BLOCKS = 300n;
/** V BoxHookBase.sol:61 (BoxHook.MAX_DEVIATION_TICKS): deepen() refuses while the spot is further than this from the 1-hour average */
export const DEPTH_MAX_DEVIATION_TICKS = 99;
/** V BoxHookBase.sol:67 (BoxHook.ADD_CAP_PERCENT): one add is at most this share of its base, the Q the core positions' liquidity spans over [t_ref, t_ref + DEPTH_CAP_BAND_TICKS] as if the price stood at t_ref */
export const DEPTH_ADD_CAP_PERCENT = 10n;
/** V BoxHookBase.sol:69 (_BAND): the band above t_ref that DEPTH_ADD_CAP_PERCENT's base spans */
export const DEPTH_CAP_BAND_TICKS = 953;
/** V BoxHookBase.sol:71 (_MIN_ADD_BPS): an add waits until its budget reaches 0.5% of the raise (both sides for pair and lock, F72 (B)) */
export const DEPTH_MIN_ADD_BPS_OF_RAISE = 50n;
/** V BoxHookBase.sol:74-75 (BoxHook.DEEPEN_TIP_BPS): deepen()'s caller gets 5% of the Q the call spent (the add's, and since S5.M5 a conversion's input too: one tip a call, reserved from the Q side first), capped at FEE_BATCH_TIP_MAX_ETH */
export const DEPTH_TIP_BPS = 500n;
/** V BoxHookBase.sol:82 (_SALT_PAIR): pair and lock's full-range position (F72 (B)), every box's since F77 (box 0 included); the curve is salt 0, L7 salt 1; salt 2 (the removed rungs', F77) is never used and not renumbered */
export const DEPTH_PAIR_SALT = 3n;
/** V BoxReceiver.sol `STREAM_NOTIFY_GAS`: the gas the per-item stream's onStreamFunds gets, capped and fail-safe (as FitPoolHook.sol:159-166). S8 measured BoxItemStream.onStreamFunds with its burn of the items-inside share at 99,555 gas today and 124,880 under Glamsterdam from cold, the least forwarded gas with which it succeeds (BoxItemStreamGas.t.sol; SH-S8-stream § 5); 100,000 (S5) did not fit after Glamsterdam. Kept at 200,000 by F87's review (SH-box0-stream-gas § The notice): 1.60x after Glamsterdam; a failed notice only delays the burn of the items-inside share, while the receiver's settlement inside the graduation poke checks that the whole cap is left (each 50,000 more takes about 51,600 of POKE_GAS's room); 250,000 would need POKE_GAS raised with it (founder question) */
export const STREAM_NOTIFY_GAS = 200000n;
/** F95 R19M (2026-10-06, desk round 19: 'Raise to 2,600,000 (2x)'; F90 R16I's 1,600,000 and S6's 1,000,000 before): V BoxCoordinator.sol:104, with the caller's floor POKE_GAS + POKE_GAS / 63 + 10,000 = 2,651,269 (:120): every graduation poke is capped; every poke is fail-safe, including the stream; F126 / M28 records its baseline before pokes for a lossless delayed retry (BC-098). Measured on box 0 with its stream, each poke alone from cold (Box0StreamCeiling.t.sol; SH-box0-stream-gas § POKE_GAS): under Glamsterdam the receiver's settlement with its notice needs 874,760 and the stream's poke running it 913,836 when a fee batch ran before the close (2.97x, 2.85x), and 1,237,499 and 1,288,181 when the settlement's batch is the box's first (seven slots written from zero: 2.10x, 2.02x; 1.30x and 1.24x at 1,600,000); the tickets' word request 147,292, FIT's executor's sample 138,074, the stream's start 102,555; today at most 515,229 (5.05x). graduate()'s least call gas from cold: 3,598,433-3,762,467 today, 5,425,027-6,410,090 under Glamsterdam (one gas less: GasTooLow); with all four pokes exhausting their budgets graduation succeeds (F126), using at most 11,041,016 execution gas including intrinsic after Amsterdam; its least successful transaction is 13,031,931, under EIP-7825's 16,777,216. Before (S6, S5.M1): a creator box's onGraduation with its first batch final 654,047 under Glamsterdam (3.98x now). Whether other boxes' price sampler and launch router sweep join the pokes is founder question 10 (built: neither) */
export const POKE_GAS = 2600000n;
/** V BackedSourcePins.sol:24-25: box 0's one randomness source, BoxBackedSource (F143: drand first through the pinned DrandSource, DRAND_SOURCE; the RANDAO backup fixed at creation, started by an on-chain rule anyone can trigger BACKUP_AFTER_SECONDS after an unposted round's time, one target BACKUP_TARGET_BLOCKS ahead, no Safe or other power; amends F61 R4's drand only, no Chainlink backup), which factory v1 pins on chains 1 and 11155111, the same address on both (the deterministic deployer, salt keccak256('squarehole.box.v1.BoxBackedSource')). Not deployed yet: anyone may send the deterministic deployment (DeployCoreV1 sends it when absent). graduate() does not re-check its code (a failed re-check would freeze a closed box, D1): the factory pins it (S7) and the instance checks re-check it (BC-101). Core v2 boxes stay drand-only (DRAND_SOURCE) */
export const RANDOMNESS_SOURCE: Address = '0x4FE27aE2810DAdA5F2f0f425F6623FdbE6A321fb';
/** V BackedSourcePins.sol:26-27: RANDOMNESS_SOURCE's runtime code hash on chains 1 and 11155111 (BackedSourcePins.isPinned; F143) */
export const RANDOMNESS_SOURCE_CODE_HASH: Hex = '0x7b3be4b9531713d98f065160d3c2dd2f517a0d5203672d8cd3df590d82f2ffa3';
/** V DrandSourcePins.sol:28-29: the one drand quicknet source every box shares (rounds are posted here; BoxBackedSource.DRAND names it, and core v2 boxes read it directly), pinned on chains 1 and 11155111, the same address on both (the deterministic deployer, salt keccak256('squarehole.box.v1.DrandSource')); factory v1 checks it is there with its pinned code (BC-101, F143) */
export const DRAND_SOURCE: Address = '0xbeEcE13fBdd67D0A696cB7cfD28103Ed37ba79A6';
/** V DrandSourcePins.sol:30-31: DRAND_SOURCE's runtime code hash on chains 1 and 11155111 (DrandSourcePins.isPinned) */
export const DRAND_SOURCE_CODE_HASH: Hex = '0xb835f0713da5f533832670cd4fa7ba4cc94b93203025f9412d87c9b575a54218';
/** V BoxBackedSource.sol (BACKUP_AFTER, 5 days): a quicknet round still unposted this long after its time may fall back to the RANDAO backup, started by anyone (F143 (2): 5 days, not 3), until BACKUP_LATEST_START_SECONDS */
export const BACKUP_AFTER_SECONDS = 432000n;
/** V BoxBackedSource.sol (LATEST_START, 5 days 18 hours; the security review of sh-box0-backup-source, F1): the last moment after a round's time at which its backup may start; with the target BACKUP_TARGET_BLOCKS ahead and the fix inside EIP-2935's 8,191 blocks even the latest start's last word lands about 6.92 days after the request, inside DRAND_SILENCE_SECONDS: the cutoff keeps the whole proof window plus at least 1 h 50 min 21 s of margin at 12-second blocks (test/box/backup/BackupTimeline.t.sol); a later start could still be fixed early, but it would use up that margin and eventually push part of the proof window past the consumers' deadline */
export const BACKUP_LATEST_START_SECONDS = 496800n;
/** V BoxBackedSource.sol (RECENT_BLOCKS): the header a start proves (the format the fix relies on) may be one of the last 8 blocks', so a start included a few blocks late still lands (the security review, F3) */
export const BACKUP_RECENT_BLOCKS = 8n;
/** V BoxBackedSource.sol (TARGET_BLOCKS): the backup's target block is this many blocks after its start (about 51 minutes, 8 epochs: past the beacon chain's proposer lookahead); one target per round, never a second (F143; the review of the design study) */
export const BACKUP_TARGET_BLOCKS = 256n;
/** V DrandSource.sol:68 (MARGIN): a word counts only from a round at least this long after the request */
export const DRAND_MARGIN_SECONDS = 12n;
/** V DrandSource.sol:70 (SILENCE, 7 days) = the placeholders add-on's SILENCE_DAYS (BoxTickets.sol:57): 7 silent days mean terminal mode */
export const DRAND_SILENCE_SECONDS = 604800n;
/** V DrandWords.sol:49 (BOUNTY_GAS): a round's posting bounty, BOUNTY_GAS × the block's base fee (about 0.0003 ETH at 0.5 gwei). R F75 W3 ('the draw pays the drand round's posting'): BoxTickets.draw requires it (DrandWords.payRound after its requests; BountyTooLow(pot + sent, needed)): the first draw of a round tops the round's pot up to the target, and the rest of the ETH sent goes back to the drawer (review of sh-f75, P; into the pot if the drawer refuses ETH), so later draws of that round get all they sent back; the pot pays whoever posts the round, usually the drawer's own page. The graduation word's request needs none (founder question 5, P) */
export const DRAND_BOUNTY_GAS = 600000n;

// ------------------------------------------------------------------------------------------------ enums (uint8)
export const BoxType = { NEW_COLLECTION: 1, EXISTING: 2, TOKEN_ONLY: 3 } as const;
export const Layout = { CURVE_V1: 1 } as const;
export const GradLayout = { B_PRIME: 1, ASK_FULL_BID_SENTINEL: 2 } as const;
export const LaunchFormat = { CURVE: 1 } as const;
export const QStream = { BUYBACK_BURN_T: 1, ALL_TO_FIT: 2, BURN_Q: 3, PAY_HOLDERS_Q: 4, TO_CREATOR: 5, CREATOR_IN_T: 6, HOLDERS_IN_T: 7 } as const;
export const TStream = { BURN_T: 1, PAY_HOLDERS_T: 2, SELL_FOR_Q: 3, PER_ITEM_STREAM: 4, TO_CREATOR: 5, CREATOR_IN_Q: 6, HOLDERS_IN_Q: 7 } as const;
export const ArtMode = { OPEN: 1, HIDDEN: 2 } as const;
export const QClass = { NATIVE_ETH: 1, ERC20: 2, FIT: 3, BOX_T: 4 } as const;
export const RoyaltyDestination = { FEE_HANDLING: 1, CREATOR: 2, POOL_DEPTH: 3 } as const;
export const CapExcess = { HOLDERS: 1, BURN: 2, POOL_DEPTH: 3 } as const;

export const StringRule = { JSON_TEXT: 1, SVG: 2, URL: 3 } as const;
/** Allowed byte ranges (inclusive) per string rule. */
export const RULE_RANGES = {
  JSON_TEXT: [[32, 33], [35, 91], [93, 126]],
  SVG: [[32, 126]],
  URL: [[33, 33], [35, 59], [61, 61], [63, 91], [93, 93], [95, 95], [97, 122], [126, 126]],
} as const satisfies Readonly<Record<string, readonly (readonly [number, number])[]>>;
/** The prefix a non-empty string of the rule must start with, as bytes (none: empty). */
export const RULE_PREFIXES = {
  JSON_TEXT: [],
  SVG: [],
  URL: [104, 116, 116, 112, 115, 58, 47, 47],
} as const satisfies Readonly<Record<string, readonly number[]>>;

export const Reason = {
  OK: 0,
  UNSUPPORTED_VERSION: 1,
  NOT_A_MEMBER: 2,
  NOT_OFFERED: 3,
  OUT_OF_RANGE: 4,
  LENGTH_OUT_OF_RANGE: 5,
  BAD_CHARACTER: 6,
  ZERO_VALUE: 7,
  MUST_BE_ZERO: 8,
  Q_NOT_LISTED: 9,
  RAISE_NOT_A_PRESET: 10,
  MENU_RULE: 11,
  DEADLINE_RULE: 12,
  TOO_MANY_ADD_ONS: 13,
  ADD_ON_ORDER: 14,
  ADD_ON_UNKNOWN: 15,
  ADD_ON_NOT_AVAILABLE: 16,
  ADD_ON_PARAMS_MALFORMED: 17,
  ADD_ON_REQUIRED: 18,
  ADD_ON_CONFLICT: 19,
  METADATA_TABLE_MALFORMED: 20,
} as const;
export const REASON_NAMES: Readonly<Record<number, string>> = Object.fromEntries(Object.entries(Reason).map(([k, v]) => [v, k]));

export const Field = {
  version: 1,
  boxType: 2,
  tokenName: 3,
  tokenSymbol: 4,
  collectionName: 5,
  collectionSymbol: 6,
  description: 7,
  n: 8,
  firstId: 9,
  q: 10,
  raise: 11,
  layout: 12,
  gradLayout: 13,
  launchFormat: 14,
  openAt: 15,
  deadlineDays: 16,
  qStream: 17,
  tStream: 18,
  artMode: 19,
  revealRoot: 20,
  metadataTable: 21,
  generatorHash: 22,
  coverSha256: 23,
  revealListId: 24,
  marketplaceOwner: 25,
  creatorFeeRecipient: 26,
  creatorBuy: 27,
  collectionCoverSha256: 28,
  addOns: 29,
  'addOns.placeholders': 100,
  'addOns.placeholders.placeholderName': 101,
  'addOns.placeholders.placeholderSymbol': 102,
  'addOns.placeholders.placeholderDescription': 103,
  'addOns.placeholders.hiddenDescription': 104,
  'addOns.placeholders.hiddenSvg': 105,
  'addOns.per-item-stream': 200,
  'addOns.edition-specials': 300,
  'addOns.edition-specials.label': 301,
  'addOns.edition-specials.count': 302,
  'addOns.royalties': 400,
  'addOns.royalties.bps': 401,
  'addOns.royalties.destination': 402,
  'addOns.creator-fee-cap': 500,
  'addOns.creator-fee-cap.capPerEpoch': 501,
  'addOns.creator-fee-cap.excess': 502,
  'addOns.collection-metadata': 600,
  'addOns.collection-metadata.bannerSha256': 601,
  'addOns.collection-metadata.teaserSha256s': 602,
  'addOns.collection-metadata.externalLink': 603,
} as const;
export const FIELD_NAMES: Readonly<Record<number, string>> = Object.fromEntries(Object.entries(Field).map(([k, v]) => [v, k]));

export const AddOnId = { Placeholders: 1, PerItemStream: 2, EditionSpecials: 3, Royalties: 4, CreatorFeeCap: 5, CollectionMetadata: 6 } as const;
export const ADD_ON_KEYS: Readonly<Record<number, string>> = { 1: 'placeholders', 2: 'per-item-stream', 3: 'edition-specials', 4: 'royalties', 5: 'creator-fee-cap', 6: 'collection-metadata' };
export const ADD_ON_PLACEHOLDERS_SILENCE_DAYS = 7n;
export const ADD_ON_PLACEHOLDERS_SILENCE_UNREQUESTED_DAYS = 30n;
export const ADD_ON_PLACEHOLDERS_REVEAL_GRACE_DAYS = 30n;
export const ADD_ON_PLACEHOLDERS_TAKE_DELAY_DAYS = 3n;
export const ADD_ON_PLACEHOLDERS_RETURN_GRACE_DAYS = 30n;
export const ADD_ON_PER_ITEM_STREAM_OBSERVER_GAS = 460000n;
export const ADD_ON_ROYALTIES_BPS_DENOMINATOR = 10000n;
export const ADD_ON_CREATOR_FEE_CAP_EPOCH_SECONDS = 2592000n;

// ------------------------------------------------------------------------------------------------ menus (data for forms)
export type FeeKind = 'CREATOR' | 'HOLDERS' | 'BURN' | 'STREAM';
/** An enum member with its fee-kind metadata (F70): what a payout does. validate() does not read it. */
export interface EnumMemberInfo {
  readonly name: string;
  readonly value: number;
  readonly kind: FeeKind;
  readonly paidIn: 'Q' | 'T';
  readonly buys: boolean;
  readonly sells: boolean;
  /** F74 U1: the networks where a creator may choose it (mainnet: what validate() offers; Sepolia: what core v1 builds). */
  readonly offeredOn: readonly Network[];
  /** The note the page shows beside it where it is offered early ("pending legal review"), else null. */
  readonly pending: string | null;
}
/** The fee-kind enums (QStream, TStream), member by member, in value order. */
export const ENUM_MEMBERS: Readonly<Record<string, readonly EnumMemberInfo[]>> = {
  QStream: [
    { name: 'BUYBACK_BURN_T', value: 1, kind: 'BURN', paidIn: 'T', buys: true, sells: false, offeredOn: ['demo', 'sepolia', 'mainnet'], pending: null },
    { name: 'ALL_TO_FIT', value: 2, kind: 'BURN', paidIn: 'Q', buys: false, sells: false, offeredOn: ['demo', 'sepolia', 'mainnet'], pending: null },
    { name: 'BURN_Q', value: 3, kind: 'BURN', paidIn: 'Q', buys: false, sells: false, offeredOn: ['demo', 'mainnet'], pending: null },
    { name: 'PAY_HOLDERS_Q', value: 4, kind: 'HOLDERS', paidIn: 'Q', buys: false, sells: false, offeredOn: ['demo'], pending: 'pending legal review' },
    { name: 'TO_CREATOR', value: 5, kind: 'CREATOR', paidIn: 'Q', buys: false, sells: false, offeredOn: ['demo', 'sepolia', 'mainnet'], pending: null },
    { name: 'CREATOR_IN_T', value: 6, kind: 'CREATOR', paidIn: 'T', buys: true, sells: false, offeredOn: ['demo', 'mainnet'], pending: null },
    { name: 'HOLDERS_IN_T', value: 7, kind: 'HOLDERS', paidIn: 'T', buys: true, sells: false, offeredOn: ['demo'], pending: 'pending legal review' },
  ],
  TStream: [
    { name: 'BURN_T', value: 1, kind: 'BURN', paidIn: 'T', buys: false, sells: false, offeredOn: ['demo', 'sepolia', 'mainnet'], pending: null },
    { name: 'PAY_HOLDERS_T', value: 2, kind: 'HOLDERS', paidIn: 'T', buys: false, sells: false, offeredOn: ['demo'], pending: 'pending legal review' },
    { name: 'SELL_FOR_Q', value: 3, kind: 'BURN', paidIn: 'Q', buys: false, sells: true, offeredOn: ['demo', 'mainnet'], pending: null },
    { name: 'PER_ITEM_STREAM', value: 4, kind: 'STREAM', paidIn: 'T', buys: false, sells: false, offeredOn: ['demo', 'sepolia', 'mainnet'], pending: null },
    { name: 'TO_CREATOR', value: 5, kind: 'CREATOR', paidIn: 'T', buys: false, sells: false, offeredOn: ['demo', 'sepolia', 'mainnet'], pending: null },
    { name: 'CREATOR_IN_Q', value: 6, kind: 'CREATOR', paidIn: 'Q', buys: false, sells: true, offeredOn: ['demo', 'mainnet'], pending: null },
    { name: 'HOLDERS_IN_Q', value: 7, kind: 'HOLDERS', paidIn: 'Q', buys: false, sells: true, offeredOn: ['demo'], pending: 'pending legal review' },
  ],
};
/** What each enum field and menu parameter offers creators on the strictest network (mainnet), which is what validate() and Solidity accept (values, in the source order). */
export const OFFERED: Readonly<Record<string, readonly number[]>> = {
  boxType: [1, 3],
  layout: [1],
  gradLayout: [2],
  launchFormat: [1],
  qStream: [1, 2, 3, 5, 6],
  tStream: [1, 3, 4, 5, 6],
  artMode: [1, 2],
  'addOns.royalties.bps': [0, 100, 250, 500],
  'addOns.royalties.destination': [1, 2, 3],
  'addOns.creator-fee-cap.excess': [2, 3],
};
/** Amount menus (F74 U2), in Q raw units: bigint, never a JS number. */
export const OFFERED_AMOUNTS: Readonly<Record<string, readonly bigint[]>> = {
  'addOns.creator-fee-cap.capPerEpoch': [1000000000000000000n, 4000000000000000000n, 8000000000000000000n, 16000000000000000000n, 32000000000000000000n],
};
/** F74 U1: where a creator may choose a value. `mainnet` is validate()'s own lists (the default); the Demo also offers holder payouts early with a pending note; Sepolia leaves out what core v1 does not build (NOT_BUILT). A local chain runs the same contracts as Sepolia. */
export type Network = 'demo' | 'sepolia' | 'mainnet';
export const NETWORKS: readonly Network[] = ['demo', 'sepolia', 'mainnet'];
export const STRICTEST_NETWORK: Network = 'mainnet';
/** OFFERED per network: the same keys, each list widened by the members offered early there (offeredOn) and narrowed by those not built there (notBuiltOn). */
export const OFFERED_ON: Readonly<Record<Network, Readonly<Record<string, readonly number[]>>>> = {
  demo: {
    boxType: [1, 3],
    layout: [1],
    gradLayout: [2],
    launchFormat: [1],
    qStream: [1, 2, 3, 4, 5, 6, 7],
    tStream: [1, 2, 3, 4, 5, 6, 7],
    artMode: [1, 2],
    'addOns.royalties.bps': [0, 100, 250, 500],
    'addOns.royalties.destination': [1, 2, 3],
    'addOns.creator-fee-cap.excess': [1, 2, 3],
  },
  sepolia: {
    boxType: [1, 3],
    layout: [1],
    gradLayout: [2],
    launchFormat: [1],
    qStream: [1, 2, 5],
    tStream: [1, 4, 5],
    artMode: [1, 2],
    'addOns.royalties.bps': [0, 100, 250, 500],
    'addOns.royalties.destination': [1, 2, 3],
    'addOns.creator-fee-cap.excess': [2, 3],
  },
  mainnet: {
    boxType: [1, 3],
    layout: [1],
    gradLayout: [2],
    launchFormat: [1],
    qStream: [1, 2, 3, 5, 6],
    tStream: [1, 3, 4, 5, 6],
    artMode: [1, 2],
    'addOns.royalties.bps': [0, 100, 250, 500],
    'addOns.royalties.destination': [1, 2, 3],
    'addOns.creator-fee-cap.excess': [2, 3],
  },
};
/** The note shown beside a member offered early (F74 U1: 'pending legal review'), by enum and member name. */
export const PENDING: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  QStream: { PAY_HOLDERS_Q: 'pending legal review', HOLDERS_IN_T: 'pending legal review' },
  TStream: { PAY_HOLDERS_T: 'pending legal review', HOLDERS_IN_Q: 'pending legal review' },
  CapExcess: { HOLDERS: 'pending legal review' },
};
/** Why a member validate() offers is left out on Sepolia (core v1 does not build it there: the receiver reverts ActionNotBuilt), by enum and member name. */
export const NOT_BUILT: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  QStream: { BURN_Q: 'needs a Q with a real burn (S12)', CREATOR_IN_T: 'needs the swap module' },
  TStream: { SELL_FOR_Q: 'needs the swap module', CREATOR_IN_Q: 'needs the swap module' },
};

// ------------------------------------------------------------------------------------------------ types
export interface AddOnV1 {
  readonly id: number;
  /** abi.encode(<the add-on`s parameter tuple>), canonical (add-ons.v1.json). */
  readonly params: Hex;
}

/**
 * The BoxSpec in wire form, field for field the Solidity struct `BoxSpecV1.BoxSpec`, with its strings as JS strings
 * (UTF-8 on the wire). For specs this code builds; to check bytes from elsewhere use `validateEncodedBoxSpecV1`.
 */
export interface BoxSpecV1 {
  readonly version: number;
  readonly boxType: number;
  readonly tokenName: string;
  readonly tokenSymbol: string;
  readonly collectionName: string;
  readonly collectionSymbol: string;
  readonly description: string;
  readonly n: number;
  readonly firstId: bigint;
  readonly q: Address;
  readonly raise: bigint;
  readonly layout: number;
  readonly gradLayout: number;
  readonly launchFormat: number;
  readonly openAt: number;
  readonly deadlineDays: number;
  readonly qStream: number;
  readonly tStream: number;
  readonly artMode: number;
  readonly revealRoot: Hex;
  readonly metadataTable: Hex;
  readonly generatorHash: Hex;
  readonly coverSha256: Hex;
  readonly revealListId: Hex;
  readonly marketplaceOwner: Address;
  readonly creatorFeeRecipient: Address;
  readonly creatorBuy: bigint;
  readonly collectionCoverSha256: Hex;
  readonly addOns: readonly AddOnV1[];
}

/**
 * The same struct with every string field as its raw bytes (hex), exactly as Solidity sees them: the form
 * `validateBoxSpecV1Bytes` checks. The ABI encoding of a string and of the same bytes is identical.
 */
export interface BoxSpecV1Bytes {
  readonly version: number;
  readonly boxType: number;
  readonly tokenName: Hex;
  readonly tokenSymbol: Hex;
  readonly collectionName: Hex;
  readonly collectionSymbol: Hex;
  readonly description: Hex;
  readonly n: number;
  readonly firstId: bigint;
  readonly q: Address;
  readonly raise: bigint;
  readonly layout: number;
  readonly gradLayout: number;
  readonly launchFormat: number;
  readonly openAt: number;
  readonly deadlineDays: number;
  readonly qStream: number;
  readonly tStream: number;
  readonly artMode: number;
  readonly revealRoot: Hex;
  readonly metadataTable: Hex;
  readonly generatorHash: Hex;
  readonly coverSha256: Hex;
  readonly revealListId: Hex;
  readonly marketplaceOwner: Address;
  readonly creatorFeeRecipient: Address;
  readonly creatorBuy: bigint;
  readonly collectionCoverSha256: Hex;
  readonly addOns: readonly AddOnV1[];
}

export interface QAsset {
  readonly token: Address;
  readonly decimals: number;
  readonly qClass: number;
  readonly raisePresets: readonly bigint[];
}

/** What a version, not the creator, chooses (Solidity `BoxSpecV1.VersionContext`): passed to validate() with the spec. */
export interface VersionContext {
  readonly qList: readonly QAsset[];
  /** GradLayout values the version allows; a spec naming another one is NOT_OFFERED. */
  readonly gradLayouts: readonly number[];
}

export interface PlaceholdersParams {
  readonly placeholderName: string;
  readonly placeholderSymbol: string;
  readonly placeholderDescription: string;
  readonly hiddenDescription: string;
  readonly hiddenSvg: string;
}
export type PerItemStreamParams = Record<string, never>;
export interface EditionSpecialsParams {
  readonly label: string;
  readonly count: number;
}
export interface RoyaltiesParams {
  readonly bps: number;
  readonly destination: number;
}
export interface CreatorFeeCapParams {
  readonly capPerEpoch: bigint;
  readonly excess: number;
}
export interface CollectionMetadataParams {
  readonly bannerSha256: Hex;
  readonly teaserSha256s: readonly Hex[];
  readonly externalLink: string;
}

// ------------------------------------------------------------------------------------------------ ABI
export const BOX_SPEC_V1_ABI = {
  type: 'tuple',
  components: [
    { name: 'version', type: 'uint16' },
    { name: 'boxType', type: 'uint8' },
    { name: 'tokenName', type: 'string' },
    { name: 'tokenSymbol', type: 'string' },
    { name: 'collectionName', type: 'string' },
    { name: 'collectionSymbol', type: 'string' },
    { name: 'description', type: 'string' },
    { name: 'n', type: 'uint32' },
    { name: 'firstId', type: 'uint256' },
    { name: 'q', type: 'address' },
    { name: 'raise', type: 'uint256' },
    { name: 'layout', type: 'uint8' },
    { name: 'gradLayout', type: 'uint8' },
    { name: 'launchFormat', type: 'uint8' },
    { name: 'openAt', type: 'uint32' },
    { name: 'deadlineDays', type: 'uint16' },
    { name: 'qStream', type: 'uint8' },
    { name: 'tStream', type: 'uint8' },
    { name: 'artMode', type: 'uint8' },
    { name: 'revealRoot', type: 'bytes32' },
    { name: 'metadataTable', type: 'bytes' },
    { name: 'generatorHash', type: 'bytes32' },
    { name: 'coverSha256', type: 'bytes32' },
    { name: 'revealListId', type: 'bytes32' },
    { name: 'marketplaceOwner', type: 'address' },
    { name: 'creatorFeeRecipient', type: 'address' },
    { name: 'creatorBuy', type: 'uint256' },
    { name: 'collectionCoverSha256', type: 'bytes32' },
    { name: 'addOns', type: 'tuple[]', components: [{ name: 'id', type: 'uint16' }, { name: 'params', type: 'bytes' }] },
  ],
} as const;

/** BOX_SPEC_V1_ABI with every `string` as `bytes`: the same wire encoding, decoded without UTF-8 decoding. */
export const BOX_SPEC_V1_BYTES_ABI = {
  type: 'tuple',
  components: [
    { name: 'version', type: 'uint16' },
    { name: 'boxType', type: 'uint8' },
    { name: 'tokenName', type: 'bytes' },
    { name: 'tokenSymbol', type: 'bytes' },
    { name: 'collectionName', type: 'bytes' },
    { name: 'collectionSymbol', type: 'bytes' },
    { name: 'description', type: 'bytes' },
    { name: 'n', type: 'uint32' },
    { name: 'firstId', type: 'uint256' },
    { name: 'q', type: 'address' },
    { name: 'raise', type: 'uint256' },
    { name: 'layout', type: 'uint8' },
    { name: 'gradLayout', type: 'uint8' },
    { name: 'launchFormat', type: 'uint8' },
    { name: 'openAt', type: 'uint32' },
    { name: 'deadlineDays', type: 'uint16' },
    { name: 'qStream', type: 'uint8' },
    { name: 'tStream', type: 'uint8' },
    { name: 'artMode', type: 'uint8' },
    { name: 'revealRoot', type: 'bytes32' },
    { name: 'metadataTable', type: 'bytes' },
    { name: 'generatorHash', type: 'bytes32' },
    { name: 'coverSha256', type: 'bytes32' },
    { name: 'revealListId', type: 'bytes32' },
    { name: 'marketplaceOwner', type: 'address' },
    { name: 'creatorFeeRecipient', type: 'address' },
    { name: 'creatorBuy', type: 'uint256' },
    { name: 'collectionCoverSha256', type: 'bytes32' },
    { name: 'addOns', type: 'tuple[]', components: [{ name: 'id', type: 'uint16' }, { name: 'params', type: 'bytes' }] },
  ],
} as const;

export const Q_LIST_ABI = {
  type: 'tuple[]',
  components: [
    { name: 'token', type: 'address' },
    { name: 'decimals', type: 'uint8' },
    { name: 'qClass', type: 'uint8' },
    { name: 'raisePresets', type: 'uint256[]' },
  ],
} as const;

export const VERSION_CONTEXT_ABI = {
  type: 'tuple',
  components: [
    { name: 'qList', type: 'tuple[]', components: Q_LIST_ABI.components },
    { name: 'gradLayouts', type: 'uint8[]' },
  ],
} as const;

export const ADD_ON_PARAMS_ABI = {
  1: [{ name: 'placeholderName', type: 'string' }, { name: 'placeholderSymbol', type: 'string' }, { name: 'placeholderDescription', type: 'string' }, { name: 'hiddenDescription', type: 'string' }, { name: 'hiddenSvg', type: 'string' }],
  2: [],
  3: [{ name: 'label', type: 'string' }, { name: 'count', type: 'uint32' }],
  4: [{ name: 'bps', type: 'uint16' }, { name: 'destination', type: 'uint8' }],
  5: [{ name: 'capPerEpoch', type: 'uint256' }, { name: 'excess', type: 'uint8' }],
  6: [{ name: 'bannerSha256', type: 'bytes32' }, { name: 'teaserSha256s', type: 'bytes32[]' }, { name: 'externalLink', type: 'string' }],
} as const;

export function encodeBoxSpecV1(spec: BoxSpecV1): Hex {
  return encodeAbiParameters([BOX_SPEC_V1_ABI], [spec]);
}

export function decodeBoxSpecV1(encoded: Hex): BoxSpecV1 {
  return decodeAbiParameters([BOX_SPEC_V1_ABI], encoded)[0];
}

/** keccak256(abi.encode(spec)): the same bytes as Solidity`s `BoxSpecV1.specHash`. */
export function specHash(spec: BoxSpecV1): Hex {
  return keccak256(encodeBoxSpecV1(spec));
}

/** The bytes form of a spec built here: each string as its UTF-8 bytes, as viem encodes it. */
export function toBoxSpecV1Bytes(spec: BoxSpecV1): BoxSpecV1Bytes {
  return { ...spec, tokenName: stringToHex(spec.tokenName), tokenSymbol: stringToHex(spec.tokenSymbol), collectionName: stringToHex(spec.collectionName), collectionSymbol: stringToHex(spec.collectionSymbol), description: stringToHex(spec.description) };
}

export function encodeBoxSpecV1Bytes(spec: BoxSpecV1Bytes): Hex {
  return encodeAbiParameters([BOX_SPEC_V1_BYTES_ABI], [spec]);
}

/**
 * Decodes ABI bytes with every string kept as its raw bytes (no UTF-8 decoding, no BOM stripping, no U+FFFD), and
 * throws unless they are exactly the canonical encoding of what they decode to: viem keeps an address word`s low 20
 * bytes and reads a uintN word whole where Solidity`s `abi.decode` reverts (box 0`s own review W3-U9-1, F147).
 */
export function decodeBoxSpecV1Bytes(encoded: Hex): BoxSpecV1Bytes {
  const spec = decodeAbiParameters([BOX_SPEC_V1_BYTES_ABI], encoded)[0];
  if (canonicalOrNull(spec) !== encoded.toLowerCase()) throw new Error('BoxSpecV1 bytes are not canonical ABI (abi.encode of the decoded spec differs)');
  return spec;
}

/** encodeBoxSpecV1Bytes(spec), or null where a decoded value does not fit its type (viem refuses to encode it). */
function canonicalOrNull(spec: BoxSpecV1Bytes): Hex | null {
  try {
    return encodeBoxSpecV1Bytes(spec);
  } catch {
    return null;
  }
}

/**
 * Solidity`s verdict on ABI bytes from anywhere (an event, a calldata copy, another tool): decodes them without UTF-8
 * decoding and checks the raw bytes, as `BoxSpecV1.validate(abi.decode(encoded), ctx)` does. Throws on bytes that
 * are not canonical ABI: every encoding `abi.decode` reverts on (bytes that are not a BoxSpec) and the others it
 * would decode (trailing bytes, a dirty pad, moved dynamic data), so it gives Solidity`s verdict or throws.
 */
export function validateEncodedBoxSpecV1(encoded: Hex, ctx: VersionContext, network: Network = STRICTEST_NETWORK): Verdict {
  return validateBoxSpecV1Bytes(decodeBoxSpecV1Bytes(encoded), ctx, network);
}

/**
 * Solidity`s `specHash(abi.decode(encoded))` for canonical ABI bytes (the chain`s own: the `BoxSpec` log carries
 * abi.encode(spec)), which is keccak256(encoded). Never decodes strings; throws on bytes that are not canonical
 * (decodeBoxSpecV1Bytes), so it never returns the hash of other bytes than those given.
 */
export function specHashOfEncoded(encoded: Hex): Hex {
  return keccak256(encodeBoxSpecV1Bytes(decodeBoxSpecV1Bytes(encoded)));
}

export function decodeQList(encoded: Hex): readonly QAsset[] {
  return decodeAbiParameters([Q_LIST_ABI], encoded)[0];
}

export function encodeVersionContext(ctx: VersionContext): Hex {
  return encodeAbiParameters([VERSION_CONTEXT_ABI], [ctx]);
}

export function decodeVersionContext(encoded: Hex): VersionContext {
  return decodeAbiParameters([VERSION_CONTEXT_ABI], encoded)[0];
}

export function encodePlaceholdersParams(params: PlaceholdersParams): Hex {
  return encodeAbiParameters(ADD_ON_PARAMS_ABI[1], [params.placeholderName, params.placeholderSymbol, params.placeholderDescription, params.hiddenDescription, params.hiddenSvg]);
}

export function decodePlaceholdersParams(params: Hex): PlaceholdersParams {
  const [placeholderName, placeholderSymbol, placeholderDescription, hiddenDescription, hiddenSvg] = decodeAbiParameters(ADD_ON_PARAMS_ABI[1], params);
  return { placeholderName, placeholderSymbol, placeholderDescription, hiddenDescription, hiddenSvg };
}

export function encodePerItemStreamParams(): Hex {
  return '0x';
}

export function decodePerItemStreamParams(params: Hex): PerItemStreamParams {
  if (params !== '0x') throw new Error('per-item-stream takes no parameters');
  return {};
}

export function encodeEditionSpecialsParams(params: EditionSpecialsParams): Hex {
  return encodeAbiParameters(ADD_ON_PARAMS_ABI[3], [params.label, params.count]);
}

export function decodeEditionSpecialsParams(params: Hex): EditionSpecialsParams {
  const [label, count] = decodeAbiParameters(ADD_ON_PARAMS_ABI[3], params);
  return { label, count };
}

export function encodeRoyaltiesParams(params: RoyaltiesParams): Hex {
  return encodeAbiParameters(ADD_ON_PARAMS_ABI[4], [params.bps, params.destination]);
}

export function decodeRoyaltiesParams(params: Hex): RoyaltiesParams {
  const [bps, destination] = decodeAbiParameters(ADD_ON_PARAMS_ABI[4], params);
  return { bps, destination };
}

export function encodeCreatorFeeCapParams(params: CreatorFeeCapParams): Hex {
  return encodeAbiParameters(ADD_ON_PARAMS_ABI[5], [params.capPerEpoch, params.excess]);
}

export function decodeCreatorFeeCapParams(params: Hex): CreatorFeeCapParams {
  const [capPerEpoch, excess] = decodeAbiParameters(ADD_ON_PARAMS_ABI[5], params);
  return { capPerEpoch, excess };
}

export function encodeCollectionMetadataParams(params: CollectionMetadataParams): Hex {
  return encodeAbiParameters(ADD_ON_PARAMS_ABI[6], [params.bannerSha256, params.teaserSha256s, params.externalLink]);
}

export function decodeCollectionMetadataParams(params: Hex): CollectionMetadataParams {
  const [bannerSha256, teaserSha256s, externalLink] = decodeAbiParameters(ADD_ON_PARAMS_ABI[6], params);
  return { bannerSha256, teaserSha256s, externalLink };
}

/** Version 1 builds only box 0 (plan § 3.1): one Q, native ETH, with box 0's raise. FIT cannot be on it yet: FIT is box 0's T. */
export const Q_LIST_V1: readonly QAsset[] = [
  { token: '0x0000000000000000000000000000000000000000', decimals: 18, qClass: QClass.NATIVE_ETH, raisePresets: [4206980085000000000n] },
];

/** Version context `v1`: its Q list and graduated layout(s). */
export const CONTEXT_V1: VersionContext = {
  qList: Q_LIST_V1,
  gradLayouts: [GradLayout.ASK_FULL_BID_SENTINEL],
};

/** F74 U5: native ETH with the one raise every box has, 4.206980085 ETH (box 0's R; the presets 1, 4.2 and 10 ETH of box-factory.md § 4.7 are gone); FIT, listed box T and curated ERC-20s join with S12, each with its 'ETH equivalent' raise (rule open; USDY is pushed for the first public version, F61 TB1; counsel decides its listing). */
export const Q_LIST_V2: readonly QAsset[] = [
  { token: '0x0000000000000000000000000000000000000000', decimals: 18, qClass: QClass.NATIVE_ETH, raisePresets: [4206980085000000000n] },
];

/** Version context `v2`: its Q list and graduated layout(s). */
export const CONTEXT_V2: VersionContext = {
  qList: Q_LIST_V2,
  gradLayouts: [GradLayout.ASK_FULL_BID_SENTINEL],
};

// ------------------------------------------------------------------------------------------------ validate
const OK: Verdict = { reason: Reason.OK, field: 0 };
const verdict = (reason: number, field: number): Verdict => ({ reason, field });

/**
 * (Reason.OK, 0) for a valid spec built here, else the first failing check`s reason and field id, as Solidity returns
 * them for its encoding. Its strings are checked as the UTF-8 bytes they encode to. `network` (F74 U1) widens what
 * is offered where a value is offered early (Demo: holder payouts); the default, mainnet, is Solidity`s check exactly.
 */
export function validateBoxSpecV1(s: BoxSpecV1, ctx: VersionContext, network: Network = STRICTEST_NETWORK): Verdict {
  return validateBoxSpecV1Bytes(toBoxSpecV1Bytes(s), ctx, network);
}

/** The validator itself, on raw string bytes: Solidity`s `BoxSpecV1.validate` check for check (on mainnet, the default). */
export function validateBoxSpecV1Bytes(s: BoxSpecV1Bytes, ctx: VersionContext, network: Network = STRICTEST_NETWORK): Verdict {
  const fields = checkFields(s, ctx, network);
  if (fields.reason !== Reason.OK) return fields;
  const addOns = checkAddOns(s, network);
  if (addOns.reason !== Reason.OK) return addOns;
  return checkRules(s, ctx);
}

function checkFields(s: BoxSpecV1Bytes, ctx: VersionContext, network: Network): Verdict {
  let r: number;
  // 1 version
  if (!(s.version === 1 || s.version === 2)) return verdict(Reason.UNSUPPORTED_VERSION, Field.version);
  // 2 boxType
  if (!(s.boxType === BoxType.NEW_COLLECTION || s.boxType === BoxType.EXISTING || s.boxType === BoxType.TOKEN_ONLY)) return verdict(Reason.NOT_A_MEMBER, Field.boxType);
  if (!(s.boxType === BoxType.NEW_COLLECTION || s.boxType === BoxType.TOKEN_ONLY)) return verdict(Reason.NOT_OFFERED, Field.boxType);
  // 3 tokenName
  r = checkString(hexToBytes(s.tokenName), 1, Number(MAX_TOKEN_NAME_BYTES), RULE_RANGES.JSON_TEXT, RULE_PREFIXES.JSON_TEXT);
  if (r !== Reason.OK) return verdict(r, Field.tokenName);
  // 4 tokenSymbol
  r = checkString(hexToBytes(s.tokenSymbol), 1, Number(MAX_SYMBOL_BYTES), RULE_RANGES.JSON_TEXT, RULE_PREFIXES.JSON_TEXT);
  if (r !== Reason.OK) return verdict(r, Field.tokenSymbol);
  // 5 collectionName
  if (s.boxType === BoxType.TOKEN_ONLY) {
    if (hexLength(s.collectionName) !== 0) return verdict(Reason.MUST_BE_ZERO, Field.collectionName);
  } else {
    r = checkString(hexToBytes(s.collectionName), 1, Number(MAX_TOKEN_NAME_BYTES), RULE_RANGES.JSON_TEXT, RULE_PREFIXES.JSON_TEXT);
    if (r !== Reason.OK) return verdict(r, Field.collectionName);
  }
  // 6 collectionSymbol
  if (s.boxType === BoxType.TOKEN_ONLY) {
    if (hexLength(s.collectionSymbol) !== 0) return verdict(Reason.MUST_BE_ZERO, Field.collectionSymbol);
  } else {
    r = checkString(hexToBytes(s.collectionSymbol), 1, Number(MAX_SYMBOL_BYTES), RULE_RANGES.JSON_TEXT, RULE_PREFIXES.JSON_TEXT);
    if (r !== Reason.OK) return verdict(r, Field.collectionSymbol);
  }
  // 7 description
  r = checkString(hexToBytes(s.description), 0, Number(MAX_TEXT_BYTES), RULE_RANGES.JSON_TEXT, RULE_PREFIXES.JSON_TEXT);
  if (r !== Reason.OK) return verdict(r, Field.description);
  // 8 n
  if (s.boxType === BoxType.TOKEN_ONLY) {
    if (s.n !== 0) return verdict(Reason.MUST_BE_ZERO, Field.n);
  } else {
    if (s.n < Number(MIN_N) || s.n > Number(MAX_N)) return verdict(Reason.OUT_OF_RANGE, Field.n);
  }
  // 9 firstId
  if (s.firstId < FIRST_ID || s.firstId > FIRST_ID) return verdict(Reason.OUT_OF_RANGE, Field.firstId);
  // 10 q
  if (!isListed(s.q, ctx.qList)) return verdict(Reason.Q_NOT_LISTED, Field.q);
  // 11 raise
  if (!isPreset(s.q, s.raise, ctx.qList)) return verdict(Reason.RAISE_NOT_A_PRESET, Field.raise);
  // 12 layout
  if (!(s.layout === Layout.CURVE_V1)) return verdict(Reason.NOT_A_MEMBER, Field.layout);
  // 13 gradLayout
  if (!(s.gradLayout === GradLayout.B_PRIME || s.gradLayout === GradLayout.ASK_FULL_BID_SENTINEL)) return verdict(Reason.NOT_A_MEMBER, Field.gradLayout);
  if (!(s.gradLayout === GradLayout.ASK_FULL_BID_SENTINEL)) return verdict(Reason.NOT_OFFERED, Field.gradLayout);
  if (!ctx.gradLayouts.includes(s.gradLayout)) return verdict(Reason.NOT_OFFERED, Field.gradLayout);
  // 14 launchFormat
  if (!(s.launchFormat === LaunchFormat.CURVE)) return verdict(Reason.NOT_A_MEMBER, Field.launchFormat);
  // 15 openAt
  if (s.openAt !== 0 && (s.openAt < Number(MIN_OPEN_AT))) return verdict(Reason.OUT_OF_RANGE, Field.openAt);
  // 16 deadlineDays
  if (!(s.deadlineDays === 0 || s.deadlineDays === 30 || s.deadlineDays === 60 || s.deadlineDays === 90 || s.deadlineDays === 180)) return verdict(Reason.NOT_A_MEMBER, Field.deadlineDays);
  // 17 qStream
  if (!(s.qStream === QStream.BUYBACK_BURN_T || s.qStream === QStream.ALL_TO_FIT || s.qStream === QStream.BURN_Q || s.qStream === QStream.PAY_HOLDERS_Q || s.qStream === QStream.TO_CREATOR || s.qStream === QStream.CREATOR_IN_T || s.qStream === QStream.HOLDERS_IN_T)) return verdict(Reason.NOT_A_MEMBER, Field.qStream);
  if (!(OFFERED_ON[network].qStream ?? []).includes(s.qStream)) return verdict(Reason.NOT_OFFERED, Field.qStream);
  // 18 tStream
  if (!(s.tStream === TStream.BURN_T || s.tStream === TStream.PAY_HOLDERS_T || s.tStream === TStream.SELL_FOR_Q || s.tStream === TStream.PER_ITEM_STREAM || s.tStream === TStream.TO_CREATOR || s.tStream === TStream.CREATOR_IN_Q || s.tStream === TStream.HOLDERS_IN_Q)) return verdict(Reason.NOT_A_MEMBER, Field.tStream);
  if (!(OFFERED_ON[network].tStream ?? []).includes(s.tStream)) return verdict(Reason.NOT_OFFERED, Field.tStream);
  // 19 artMode
  if (s.boxType === BoxType.TOKEN_ONLY) {
    if (s.artMode !== 0) return verdict(Reason.MUST_BE_ZERO, Field.artMode);
  } else {
    if (!(s.artMode === ArtMode.OPEN || s.artMode === ArtMode.HIDDEN)) return verdict(Reason.NOT_A_MEMBER, Field.artMode);
  }
  // 20 revealRoot
  if (s.boxType === BoxType.TOKEN_ONLY) {
    if (!isZeroHex(s.revealRoot)) return verdict(Reason.MUST_BE_ZERO, Field.revealRoot);
  } else {
    if (isZeroHex(s.revealRoot)) return verdict(Reason.ZERO_VALUE, Field.revealRoot);
  }
  // 21 metadataTable
  if (s.boxType === BoxType.TOKEN_ONLY) {
    if (hexLength(s.metadataTable) !== 0) return verdict(Reason.MUST_BE_ZERO, Field.metadataTable);
  } else {
    if (hexLength(s.metadataTable) < 1 || hexLength(s.metadataTable) > Number(MAX_METADATA_TABLE_BYTES)) return verdict(Reason.LENGTH_OUT_OF_RANGE, Field.metadataTable);
    if (!tableV1(hexToBytes(s.metadataTable), Number(MAX_TRAIT_TYPES), RULE_RANGES.JSON_TEXT)) return verdict(Reason.METADATA_TABLE_MALFORMED, Field.metadataTable);
  }
  // 22 generatorHash
  if (s.boxType === BoxType.TOKEN_ONLY) {
    if (!isZeroHex(s.generatorHash)) return verdict(Reason.MUST_BE_ZERO, Field.generatorHash);
  }
  // 23 coverSha256
  if (isZeroHex(s.coverSha256)) return verdict(Reason.ZERO_VALUE, Field.coverSha256);
  // 24 revealListId
  if (s.boxType === BoxType.TOKEN_ONLY) {
    if (!isZeroHex(s.revealListId)) return verdict(Reason.MUST_BE_ZERO, Field.revealListId);
  }
  // 25 marketplaceOwner
  if (s.boxType === BoxType.TOKEN_ONLY) {
    if (!isZeroHex(s.marketplaceOwner)) return verdict(Reason.MUST_BE_ZERO, Field.marketplaceOwner);
  } else {
    if (isZeroHex(s.marketplaceOwner)) return verdict(Reason.ZERO_VALUE, Field.marketplaceOwner);
  }
  // 28 collectionCoverSha256
  if (s.boxType === BoxType.TOKEN_ONLY) {
    if (!isZeroHex(s.collectionCoverSha256)) return verdict(Reason.MUST_BE_ZERO, Field.collectionCoverSha256);
  } else {
    if (isZeroHex(s.collectionCoverSha256)) return verdict(Reason.ZERO_VALUE, Field.collectionCoverSha256);
  }
  return OK;
}

function checkAddOns(s: BoxSpecV1Bytes, network: Network): Verdict {
  if (s.addOns.length > Number(MAX_ADD_ONS)) return verdict(Reason.TOO_MANY_ADD_ONS, Field.addOns);
  let previous: number | undefined;
  for (const addOn of s.addOns) {
    const id = addOn.id;
    if (previous !== undefined && (id < previous || (id === previous && !repeatable(id)))) {
      return verdict(Reason.ADD_ON_ORDER, Field.addOns);
    }
    const result = checkAddOn(s, id, hexToBytes(addOn.params), network);
    if (result.reason !== Reason.OK) return result;
    previous = id;
  }
  return OK;
}

function repeatable(id: number): boolean {
  return id === AddOnId.EditionSpecials;
}

function checkAddOn(s: BoxSpecV1Bytes, id: number, p: Uint8Array, network: Network): Verdict {
  if (id === AddOnId.Placeholders) return checkPlaceholders(s, p);
  if (id === AddOnId.PerItemStream) return checkPerItemStream(s, p);
  if (id === AddOnId.EditionSpecials) return checkEditionSpecials(s, p);
  if (id === AddOnId.Royalties) return checkRoyalties(s, p);
  if (id === AddOnId.CreatorFeeCap) return checkCreatorFeeCap(s, p, network);
  if (id === AddOnId.CollectionMetadata) return checkCollectionMetadata(s, p);
  return verdict(Reason.ADD_ON_UNKNOWN, Field.addOns);
}

/** Add-on 1 `placeholders`: Placeholders: tickets during the curve, hidden art revealed by draws. */
function checkPlaceholders(s: BoxSpecV1Bytes, p: Uint8Array): Verdict {
  if (!(s.version === 1 || s.version === 2)) return verdict(Reason.ADD_ON_NOT_AVAILABLE, Field['addOns.placeholders']);
  if (!(s.boxType === BoxType.NEW_COLLECTION)) return verdict(Reason.ADD_ON_CONFLICT, Field['addOns.placeholders']);
  const w = canonicalParams(p, [ParamKind.STRING, ParamKind.STRING, ParamKind.STRING, ParamKind.STRING, ParamKind.STRING]);
  if (w === null) return verdict(Reason.ADD_ON_PARAMS_MALFORMED, Field['addOns.placeholders']);
  const r0 = checkStringAt(p, word(w, 0), 1, 32, RULE_RANGES.JSON_TEXT, RULE_PREFIXES.JSON_TEXT);
  if (r0 !== Reason.OK) return verdict(r0, Field['addOns.placeholders.placeholderName']);
  const r1 = checkStringAt(p, word(w, 1), 1, 11, RULE_RANGES.JSON_TEXT, RULE_PREFIXES.JSON_TEXT);
  if (r1 !== Reason.OK) return verdict(r1, Field['addOns.placeholders.placeholderSymbol']);
  const r2 = checkStringAt(p, word(w, 2), 0, 1024, RULE_RANGES.JSON_TEXT, RULE_PREFIXES.JSON_TEXT);
  if (r2 !== Reason.OK) return verdict(r2, Field['addOns.placeholders.placeholderDescription']);
  const r3 = checkStringAt(p, word(w, 3), 0, 1024, RULE_RANGES.JSON_TEXT, RULE_PREFIXES.JSON_TEXT);
  if (r3 !== Reason.OK) return verdict(r3, Field['addOns.placeholders.hiddenDescription']);
  const r4 = checkStringAt(p, word(w, 4), 1, 4096, RULE_RANGES.SVG, RULE_PREFIXES.SVG);
  if (r4 !== Reason.OK) return verdict(r4, Field['addOns.placeholders.hiddenSvg']);
  if (!(s.artMode === ArtMode.HIDDEN)) return verdict(Reason.ADD_ON_CONFLICT, Field['addOns.placeholders']);
  return OK;
}

/** Add-on 2 `per-item-stream`: Per-item stream: the T-side reward share streams to each item. */
function checkPerItemStream(s: BoxSpecV1Bytes, p: Uint8Array): Verdict {
  if (!(s.version === 1)) return verdict(Reason.ADD_ON_NOT_AVAILABLE, Field['addOns.per-item-stream']);
  if (!(s.boxType === BoxType.NEW_COLLECTION)) return verdict(Reason.ADD_ON_CONFLICT, Field['addOns.per-item-stream']);
  if (p.length !== 0) return verdict(Reason.ADD_ON_PARAMS_MALFORMED, Field['addOns.per-item-stream']);
  if (!(s.tStream === TStream.PER_ITEM_STREAM)) return verdict(Reason.ADD_ON_CONFLICT, Field['addOns.per-item-stream']);
  return OK;
}

/** Add-on 3 `edition-specials`: Edition specials: named series of special items, shown as counts. */
function checkEditionSpecials(s: BoxSpecV1Bytes, p: Uint8Array): Verdict {
  if (!(s.version === 1 || s.version === 2)) return verdict(Reason.ADD_ON_NOT_AVAILABLE, Field['addOns.edition-specials']);
  if (!(s.boxType === BoxType.NEW_COLLECTION)) return verdict(Reason.ADD_ON_CONFLICT, Field['addOns.edition-specials']);
  const w = canonicalParams(p, [ParamKind.STRING, ParamKind.UINT32]);
  if (w === null) return verdict(Reason.ADD_ON_PARAMS_MALFORMED, Field['addOns.edition-specials']);
  const r0 = checkStringAt(p, word(w, 0), 1, 32, RULE_RANGES.JSON_TEXT, RULE_PREFIXES.JSON_TEXT);
  if (r0 !== Reason.OK) return verdict(r0, Field['addOns.edition-specials.label']);
  if (word(w, 1) < 1n || word(w, 1) > BigInt(s.n)) return verdict(Reason.OUT_OF_RANGE, Field['addOns.edition-specials.count']);
  return OK;
}

/** Add-on 4 `royalties`: Royalties: an unenforced ERC-2981 rate and where the royalty goes. */
function checkRoyalties(s: BoxSpecV1Bytes, p: Uint8Array): Verdict {
  if (!(s.version === 1 || s.version === 2)) return verdict(Reason.ADD_ON_NOT_AVAILABLE, Field['addOns.royalties']);
  if (!(s.boxType === BoxType.NEW_COLLECTION)) return verdict(Reason.ADD_ON_CONFLICT, Field['addOns.royalties']);
  const w = canonicalParams(p, [ParamKind.UINT16, ParamKind.UINT8]);
  if (w === null) return verdict(Reason.ADD_ON_PARAMS_MALFORMED, Field['addOns.royalties']);
  if (!(word(w, 0) === 0n || word(w, 0) === 100n || word(w, 0) === 250n || word(w, 0) === 500n)) return verdict(Reason.NOT_A_MEMBER, Field['addOns.royalties.bps']);
  if (!(word(w, 1) === BigInt(RoyaltyDestination.FEE_HANDLING) || word(w, 1) === BigInt(RoyaltyDestination.CREATOR) || word(w, 1) === BigInt(RoyaltyDestination.POOL_DEPTH))) return verdict(Reason.NOT_A_MEMBER, Field['addOns.royalties.destination']);
  if (!((s.version !== 1 || word(w, 1) !== BigInt(RoyaltyDestination.CREATOR)))) return verdict(Reason.ADD_ON_CONFLICT, Field['addOns.royalties']);
  return OK;
}

/** Add-on 5 `creator-fee-cap`: Creator-fee cap: at most a fixed amount per 30 days to the creator. */
function checkCreatorFeeCap(s: BoxSpecV1Bytes, p: Uint8Array, network: Network): Verdict {
  if (!(s.version === 2)) return verdict(Reason.ADD_ON_NOT_AVAILABLE, Field['addOns.creator-fee-cap']);
  if (!(s.boxType === BoxType.NEW_COLLECTION || s.boxType === BoxType.TOKEN_ONLY)) return verdict(Reason.ADD_ON_CONFLICT, Field['addOns.creator-fee-cap']);
  const w = canonicalParams(p, [ParamKind.UINT256, ParamKind.UINT8]);
  if (w === null) return verdict(Reason.ADD_ON_PARAMS_MALFORMED, Field['addOns.creator-fee-cap']);
  if (!(word(w, 0) === 1000000000000000000n || word(w, 0) === 4000000000000000000n || word(w, 0) === 8000000000000000000n || word(w, 0) === 16000000000000000000n || word(w, 0) === 32000000000000000000n)) return verdict(Reason.NOT_A_MEMBER, Field['addOns.creator-fee-cap.capPerEpoch']);
  if (!(word(w, 1) === BigInt(CapExcess.HOLDERS) || word(w, 1) === BigInt(CapExcess.BURN) || word(w, 1) === BigInt(CapExcess.POOL_DEPTH))) return verdict(Reason.NOT_A_MEMBER, Field['addOns.creator-fee-cap.excess']);
  if (!(OFFERED_ON[network]['addOns.creator-fee-cap.excess'] ?? []).includes(Number(word(w, 1)))) return verdict(Reason.NOT_OFFERED, Field['addOns.creator-fee-cap.excess']);
  if (!(((s.qStream === QStream.TO_CREATOR || s.qStream === QStream.CREATOR_IN_T) || (s.tStream === TStream.TO_CREATOR || s.tStream === TStream.CREATOR_IN_Q)))) return verdict(Reason.ADD_ON_CONFLICT, Field['addOns.creator-fee-cap']);
  if (!((isZeroHex(s.q)))) return verdict(Reason.ADD_ON_CONFLICT, Field['addOns.creator-fee-cap']);
  return OK;
}

/** Add-on 6 `collection-metadata`: Collection page: banner, teasers and link (contractURI, ERC-7572). */
function checkCollectionMetadata(s: BoxSpecV1Bytes, p: Uint8Array): Verdict {
  if (!(s.version === 1 || s.version === 2)) return verdict(Reason.ADD_ON_NOT_AVAILABLE, Field['addOns.collection-metadata']);
  if (!(s.boxType === BoxType.NEW_COLLECTION)) return verdict(Reason.ADD_ON_CONFLICT, Field['addOns.collection-metadata']);
  const w = canonicalParams(p, [ParamKind.BYTES32, ParamKind.BYTES32_ARRAY, ParamKind.STRING]);
  if (w === null) return verdict(Reason.ADD_ON_PARAMS_MALFORMED, Field['addOns.collection-metadata']);
  if (readWordAt(p, word(w, 1)) > 4n) return verdict(Reason.LENGTH_OUT_OF_RANGE, Field['addOns.collection-metadata.teaserSha256s']);
  if (!nonZeroItems(p, word(w, 1))) return verdict(Reason.ZERO_VALUE, Field['addOns.collection-metadata.teaserSha256s']);
  const r2 = checkStringAt(p, word(w, 2), 0, 128, RULE_RANGES.URL, RULE_PREFIXES.URL);
  if (r2 !== Reason.OK) return verdict(r2, Field['addOns.collection-metadata.externalLink']);
  return OK;
}

function checkRules(s: BoxSpecV1Bytes, ctx: VersionContext): Verdict {
  // a token-only box is version 2 (P (F70): version 1 builds only box 0 (plan § 3.1); 'Nothing' is a choice for other people's boxes)
  if (s.boxType === BoxType.TOKEN_ONLY && !(s.version === 2)) return verdict(Reason.NOT_OFFERED, Field.boxType);
  // version 1 has no deadline (F44 F4; plan § 1 (NONE only in box 0's spec); BC-064)
  if (s.version === 1 && !(s.deadlineDays === 0)) return verdict(Reason.DEADLINE_RULE, Field.deadlineDays);
  // version 2 needs a deadline (F44 P6; BC-045)
  if (s.version === 2 && !((s.deadlineDays === 30 || s.deadlineDays === 60 || s.deadlineDays === 90 || s.deadlineDays === 180))) return verdict(Reason.DEADLINE_RULE, Field.deadlineDays);
  // BURN_Q only for a Q with a real burn (BP-13; BC-014; box-factory § 2.3)
  if (s.qStream === QStream.BURN_Q && !((qClassOf(s.q, ctx.qList) === QClass.FIT || qClassOf(s.q, ctx.qList) === QClass.BOX_T))) return verdict(Reason.MENU_RULE, Field.qStream);
  // SELL_FOR_Q never with BUYBACK_BURN_T (BP-13; box-factory § 2.3)
  if (s.tStream === TStream.SELL_FOR_Q && !(s.qStream !== QStream.BUYBACK_BURN_T)) return verdict(Reason.MENU_RULE, Field.tStream);
  // open art publishes its reveal list (plan § 1 and § 3.1; BC-052)
  if (s.artMode === ArtMode.OPEN && !(!(isZeroHex(s.revealListId)))) return verdict(Reason.ZERO_VALUE, Field.revealListId);
  // hidden art keeps its reveal list private (P (S1): a published list would reveal hidden art at creation)
  if (s.artMode === ArtMode.HIDDEN && !((isZeroHex(s.revealListId)))) return verdict(Reason.MUST_BE_ZERO, Field.revealListId);
  // hidden art needs the placeholders add-on (F55: hidden art revealed by draws is the placeholders add-on; its picture, texts and safety net come with it)
  if (s.artMode === ArtMode.HIDDEN && !(hasAddOn(s, AddOnId.Placeholders))) return verdict(Reason.ADD_ON_REQUIRED, Field.artMode);
  // the per-item stream action needs its add-on (plan § 1 (PER_ITEM_STREAM); BC-014; BC-065)
  if (s.tStream === TStream.PER_ITEM_STREAM && !(hasAddOn(s, AddOnId.PerItemStream))) return verdict(Reason.ADD_ON_REQUIRED, Field.tStream);
  // the creator option on the buyers' side is for other people's boxes (F68 (3) ('for other people's boxes'); F77: box 0's split is 11/15 FIT, 2/15 its own pool, 2/15 platform (capped); F70: per fee side. Replaces 'the creator takes the whole reward side or none of it' (F68 (3), P), which F70 supersedes)
  if ((s.qStream === QStream.TO_CREATOR || s.qStream === QStream.CREATOR_IN_T) && !(s.version === 2)) return verdict(Reason.MENU_RULE, Field.qStream);
  // the creator option on the sellers' side is for other people's boxes (F68 (3); F70: per fee side)
  if ((s.tStream === TStream.TO_CREATOR || s.tStream === TStream.CREATOR_IN_Q) && !(s.version === 2)) return verdict(Reason.MENU_RULE, Field.tStream);
  // the creator option names its recipient (F68 (3); F70: a creator kind on either side; F72 (3) and core v1: royalties to CREATOR are paid to the same payee (add-on 4 has no recipient; V BoxReceiverExtension.sol `initialize`))
  if (((s.qStream === QStream.TO_CREATOR || s.qStream === QStream.CREATOR_IN_T) || (s.tStream === TStream.TO_CREATOR || s.tStream === TStream.CREATOR_IN_Q) || addOnWordIs(s, AddOnId.Royalties, 1, BigInt(RoyaltyDestination.CREATOR))) && !(!(isZeroHex(s.creatorFeeRecipient)))) return verdict(Reason.ZERO_VALUE, Field.creatorFeeRecipient);
  // no fee recipient without the creator option (P (fee-model pass): one spec, one meaning; a recipient nobody is paid would only mislead the box page)
  if (!(((s.qStream === QStream.TO_CREATOR || s.qStream === QStream.CREATOR_IN_T) || (s.tStream === TStream.TO_CREATOR || s.tStream === TStream.CREATOR_IN_Q) || addOnWordIs(s, AddOnId.Royalties, 1, BigInt(RoyaltyDestination.CREATOR)))) && !((isZeroHex(s.creatorFeeRecipient)))) return verdict(Reason.MUST_BE_ZERO, Field.creatorFeeRecipient);
  // box 0 has no creator buy (F61 O2 allows a creator buy before the open for other people's boxes only; box 0 (version 1) has none)
  if (s.version === 1 && !((s.creatorBuy === 0n))) return verdict(Reason.MUST_BE_ZERO, Field.creatorBuy);
  // the creator buy cannot fill the curve (P (fee-model pass): a buy of the raise would close the curve before it opens (D1); after the 1% LP fee anything below the raise leaves part of the curve open. No other cap (F61 O2, F66 X6))
  if (!(s.creatorBuy === 0n) && !(s.creatorBuy < s.raise)) return verdict(Reason.OUT_OF_RANGE, Field.creatorBuy);
  return OK;
}

function hasAddOn(s: BoxSpecV1Bytes, id: number): boolean {
  return s.addOns.some((a) => a.id === id);
}

/** An entry of add-on `id` holds `value` in head word `index` (rules only: they run after every add-on passed). */
function addOnWordIs(s: BoxSpecV1Bytes, id: number, index: number, value: bigint): boolean {
  return s.addOns.some((a) => a.id === id && readWordAt(hexToBytes(a.params), BigInt(32 * index)) === value);
}

function isListed(q: Address, qList: readonly QAsset[]): boolean {
  return qList.some((x) => sameAddress(x.token, q));
}

/** The first listed entry for `q` decides, as in Solidity. */
function isPreset(q: Address, raise: bigint, qList: readonly QAsset[]): boolean {
  const entry = qList.find((x) => sameAddress(x.token, q));
  return entry !== undefined && entry.raisePresets.includes(raise);
}

function qClassOf(q: Address, qList: readonly QAsset[]): number {
  return qList.find((x) => sameAddress(x.token, q))?.qClass ?? 0;
}

// ------------------------------------------------------------------------------------------------ zod
const uintN = (bits: number) => z.number().int().min(0).max(2 ** bits - 1);
const uintBig = (bits: number) => z.bigint().min(0n).max((1n << BigInt(bits)) - 1n);
const hexBytes = z.custom<Hex>((v) => typeof v === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(v), 'hex bytes');
const bytes32 = z.custom<Hex>((v) => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v), '32 hex bytes');
const address = z.custom<Address>((v) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v), 'an address');

/**
 * The zod schema of a BoxSpecV1 built here (JS strings): the ABI types, then `validateBoxSpecV1` against `ctx` (and
 * `network`, F74 U1; mainnet by default). A refused spec has one issue whose `params` carry the same `{ reason, field }`
 * as Solidity`s `validate()`.
 */
export function boxSpecV1Schema(ctx: VersionContext, network: Network = STRICTEST_NETWORK) {
  return z
    .object({
      version: uintN(16),
      boxType: uintN(8),
      tokenName: z.string(),
      tokenSymbol: z.string(),
      collectionName: z.string(),
      collectionSymbol: z.string(),
      description: z.string(),
      n: uintN(32),
      firstId: uintBig(256),
      q: address,
      raise: uintBig(256),
      layout: uintN(8),
      gradLayout: uintN(8),
      launchFormat: uintN(8),
      openAt: uintN(32),
      deadlineDays: uintN(16),
      qStream: uintN(8),
      tStream: uintN(8),
      artMode: uintN(8),
      revealRoot: bytes32,
      metadataTable: hexBytes,
      generatorHash: bytes32,
      coverSha256: bytes32,
      revealListId: bytes32,
      marketplaceOwner: address,
      creatorFeeRecipient: address,
      creatorBuy: uintBig(256),
      collectionCoverSha256: bytes32,
      addOns: z.array(z.object({ id: uintN(16), params: hexBytes })),
    })
    .superRefine((spec, refinement) => {
      const v = validateBoxSpecV1(spec, ctx, network);
      if (v.reason === Reason.OK) return;
      const field = FIELD_NAMES[v.field] ?? 'spec';
      refinement.addIssue({
        code: 'custom',
        message: `${REASON_NAMES[v.reason] ?? 'UNKNOWN'} at ${field}`,
        path: [field.split('.')[0] ?? field],
        params: { reason: v.reason, field: v.field },
      });
    });
}
