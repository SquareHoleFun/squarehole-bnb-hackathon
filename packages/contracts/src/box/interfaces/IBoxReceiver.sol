// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IBoxPriceAverage} from "./IBoxHook.sol";
import {BoxKind, FeeBatch, ModuleProceedsTo, RoyaltyDestination} from "./BoxTypes.sol";

/// @title IFitBuybackExecutor (slice S5: box 0's executor, a copy of FitBuybackBurner / BuybackBurner)
/// @notice What box contracts call on FIT's buy-and-burn executor. Unlike BuybackBurner.receive()
/// (src/v2/BuybackBurner.sol:334-349), `receive()` credits the whole amount to the budget: the executor holds no
/// treasury address, share or `payTreasury()` (F67 (2); BC-108). It is box 0's price average (IBoxPriceAverage) and
/// reports its own swap fees to box 0's receiver (`noteModuleFees`, REV-16; BC-019). It buys nothing before box 0
/// graduates (BuybackBurner.sol:55, :558).
interface IFitBuybackExecutor is IBoxPriceAverage {
    event BudgetFunded(address indexed from, uint256 amount);

    /// @notice ETH into the buy-back budget, no share to anyone. Anyone.
    function fundBudget() external payable;
    /// @notice The same as `fundBudget()` (BC-108).
    receive() external payable;
    function budget() external view returns (uint256);
    /// @notice True once box 0 (FIT's own launch) graduated: before it other boxes' FIT shares wait in their
    /// receivers (BC-102).
    function fitGraduated() external view returns (bool);
}

/// @title IBoxReceiver (slice S5; per-box clone with immutable arguments)
/// @notice Every fee of one box, from `collect()` to its payees. Generalises FitFeeCollector
/// (src/v2/FitFeeCollector.sol:43-151) under D2 (batches), D6 (reserve), F59, F62, F64, F65, F68, F69 C1, F72 and F77.
///
/// - **`collect()`** (anyone; BC-017): `hook.harvest()`, then refuses a batch whose Q side is below `batchMin()`
///   (0.005 ETH or the Q list's equivalent) except in `onGraduation()`; pays `tipTo` min(10% of the batch's Q after
///   the reserve, `tipMax()`), and splits the rest in fifteenths, remainders carried to the next batch:
///   - **Box 0** (F62, F64, F77): Q 11/15 to FIT (held until graduation, BC-020), 2/15 depth; P = 2/15, keep = min(P,
///     32 ETH − kept this epoch) credited to the fixed Safe, P − keep to the hook's claims (depth); epoch = ⌊(now −
///     graduatedAt) / 2,592,000⌋, no carry-over; the pre-graduation P counts in epoch 0 (BC-106). T side 13/15
///     burned, or the per-item stream after graduation (S8), 2/15 depth (BC-139).
///   - **Other boxes** (F64, F68 (3), F72): each side 10/15 reward, 3/15 FIT, 2/15 depth.
///   - **Depth, every box** (F72 (B), F77): held here until graduation (BC-109: the refund range's at a failure, v2;
///     box 0 has no failure) and then moved to the hook's claims, where `deepen()` pairs and locks them (the
///     pair-and-lock accumulators). The reward side follows `qStream()` /
///     `tStream()`; TO_CREATOR credits the creator (held until graduation, F69 C1; to the refund range at failure,
///     v2), paid as collected: Q as Q and T as T (F72 (A)). The payout currency is part of the stream value.
///   - **Swap module** (S5.M1; swap-module-v1 § 4.1-4.2; every Standard box has one, W4): BUYBACK_BURN_T's Q books to
///     the module's burn-buy ledger, CREATOR_IN_T's Q to its creator-buy ledger, CREATOR_IN_Q's T to its creator-sell
///     ledger; SELL_FOR_Q's T is burned before graduation and joins FIT's T share (`fitWaitingT`) after; all held until
///     the settlement, then pulled by the module (`pullForModule`), never moved inside `collect()`. The module's
///     proceeds come back through `moduleProceeds`, bounded by the step's snapshot.
///   - Burns and rewards never fund depth (F59; BC-118). A module's own swap fees (`noteModuleFees`) return to it
///     first, never split (REV-16; BC-019, BC-133): to its `moduleBack*` ledgers within its fee-note allowance (box 0:
///     FIT's executor's to `fitOwed`), the hook's conversion fees to the hook's claims.
/// - **ETH intake** (hook point `receiver.ethIntake`): `fundFees()` splits ETH like a Q batch (box 0: 11/15 FIT, 2/15
///   depth, 2/15 under the same cap, BC-107); `fundDepth()` adds it all to depth (held here until graduation);
///   `fundCreator()` credits the creator payee (the Creator royalty destination, through the box's royalty router). A
///   box whose Q is not native ETH sends both to FIT through `fundBudget()` (P). Forced ETH is never counted as fees
///   and never reaches the Safe.
/// - **Payouts are pulled or triggered by anyone, never pushed inside a swap** (BC-021): `payFit()`, `payPlatform()`
///   (box 0 only), `claimCreator()` (the payee only). A reverting payee blocks only its own claim.
/// - **Creator payee** (F72 (1), (3)): one wallet, changeable only by its current holder, in two steps
///   (`proposeCreatorPayee`, `acceptCreatorPayee`); the role carries every unclaimed and held credit.
/// - No owner, admin, pause, upgrade, setter or rescue (F23 C2). Other boxes have no platform payee (BC-109).
/// @dev Invariants: per batch reward + FIT + depth + platform + burned + tip + reserve == the batch (to the wei, with
/// remainders carried); box 0's Safe is credited at most PLATFORM_CAP_WEI per epoch by every path (BC-106, BC-107),
/// and a payout may carry earlier epochs' credits, so the Safe's receipts by the end of epoch k are at most (k + 1) ×
/// PLATFORM_CAP_WEI (a `collect` tip whose caller names the Safe is outside the cap); the epoch field is 32 bits, so
/// the cap is exact for 2^32 epochs, about 353 million years after graduation (box 0's own review W1-U4-1, W1-U4-2,
/// FQ-10, F147); claims held == Σ ledgers below + the next batch (claims not yet in a ledger; W1-U4-3).
interface IBoxReceiver is IUnlockCallback {
    event Collected(address indexed caller, address tipTo, uint256 q, uint256 t, uint256 qToReserve, uint256 tip);
    /// @notice One batch's split per side (raw units). Box 0's `qPlatform` is the kept part only.
    event BatchSplit(
        uint256 qReward,
        uint256 qFit,
        uint256 qDepth,
        uint256 qPlatform,
        uint256 tReward,
        uint256 tFit,
        uint256 tDepth,
        uint256 tBurned
    );
    event PlatformCredited(uint256 indexed epoch, uint256 kept, uint256 toDepth, uint256 keptInEpoch);
    event PlatformPaid(address indexed safe, uint256 amount);
    event FitPaid(address indexed executor, uint256 amount);
    event DepthFunded(uint256 q, uint256 t);
    /// @notice Other boxes before graduation: depth parts held in the receiver (BC-109), moved at the settlement.
    event DepthHeld(uint256 q, uint256 t);
    event FeesFunded(address indexed from, uint256 amount);
    event DepthGifted(address indexed from, uint256 amount);
    /// @notice ETH for the creator payee through `fundCreator()` (the Creator royalty destination).
    event CreatorFunded(address indexed from, uint256 amount);
    event ModuleFeesNoted(address indexed module, uint256 q, uint256 t);
    event CreatorCredited(uint256 q, uint256 t, bool held);
    event CreatorClaimed(address indexed payee, address to, uint256 q, uint256 t);
    event CreatorPayeeProposed(address indexed payee, address indexed proposed);
    event CreatorPayeeChanged(address indexed previous, address indexed payee);
    /// @notice Once, at or after graduation: held shares released (box 0's FIT and platform shares, creator credits).
    event GraduationSettled(
        uint256 fitReleased, uint256 platformKept, uint256 platformToDepth, uint256 creatorQ, uint256 creatorT
    );
    event StreamFunded(address indexed stream, uint256 amount);
    event StreamNotifyFailed(address indexed stream, uint256 amount);
    /// @notice S5.M1: what one `pullForModule` handed the box's swap module (raw units; each ledger keeps 1).
    event ModulePulled(
        uint256 qBurn, uint256 qCreator, uint256 tForFit, uint256 tForCreator, uint256 qBack, uint256 tBack
    );
    /// @notice S5.M1: a module's proceeds booked (at most the claims that arrived since the step's pull).
    event ModuleProceeds(ModuleProceedsTo indexed dest, uint256 amount);
    /// @notice S5.M1 (REV-16): fees returned in a collect before the tip and the split, never split: the module's to
    /// its `moduleBack*` ledgers (box 0: FIT's executor's to `fitOwed`), the hook's conversion fees to its claims.
    event ModuleFeesReturned(uint256 moduleQ, uint256 moduleT, uint256 hookQ);
    /// @notice S5.M1: the part of a module's fee note above its allowance (or a hook's T note), dropped, not reverted.
    event ModuleFeesClipped(address indexed noter, uint256 qClipped, uint256 tClipped);
    /// @notice S5.M3, add-on 5: one creator payout counted against the cap in `epoch` (Q at face; T paid as T at its
    /// value from the box's sampler): `keptQ` counted for the creator, the excess (`excessQ` in Q, `excessT` in T) to
    /// the excess destination in the currency it arrived in, `keptInEpoch` the epoch's total so far.
    event CreatorCapped(uint256 indexed epoch, uint256 keptQ, uint256 excessQ, uint256 excessT, uint256 keptInEpoch);

    error ZeroAddress();
    error NotCoordinator(address caller);
    error NotHook(address caller);
    error NotPoolManager();
    error NotModule(address caller);
    error AlreadyInitialised();
    /// @notice The reward action (with its payout currency) needs a part no v1 lane builds (core-v1-interfaces § 5).
    error ActionNotBuilt(uint8 qStream, uint8 tStream);
    /// @notice `fundCreator()` on a box whose royalties do not go to the creator.
    error NotCreatorRoyalties();
    error BatchTooSmall(uint256 q, uint256 min);
    error NotGraduated();
    error AlreadySettled();
    error NotBox0();
    error NotPayee(address caller);
    error NotPendingPayee(address caller);
    error NothingOwed();
    error PaymentFailed();
    error BurnDidNotReduceSupply();
    error EthRefused(address from);
    /// @notice `initialize`: box 0 named a swap module, or a Standard box's module does not name this receiver and the
    /// box's Q, T and hook.
    error ModuleMismatch(address module);
    /// @notice `initialize` (S8): box 0 names a per-item stream exactly when its T stream is PER_ITEM_STREAM.
    error StreamMismatch(address stream);
    /// @notice `moduleProceeds` without a `pullForModule` (after the settlement) in the same transaction.
    error NoStepOpen();
    /// @notice `moduleProceeds` above the claims that arrived since the step's pull and are not in any ledger.
    error ProceedsTooLarge(uint256 amount, uint256 arrived);
    /// @notice `initialize`: add-on 5's arguments name a cap this receiver cannot keep (box 0; no creator kind on either
    /// fee side; an excess destination other than BURN or POOL_DEPTH; a destination without a cap, or a cap without one).
    error CreatorCapRefused(uint256 capPerEpoch, uint8 excess);

    /// @notice The box's coordinator only (the `coordinator` argument, a clone of `coordinatorImplementation()`), once,
    /// in createBox: checks the stream choices against what is built.
    function initialize() external;

    // ------------------------------------------------------------------ batches
    /// @notice Anyone: one D2 batch (see the contract notes).
    function collect(address tipTo) external returns (FeeBatch memory batch);
    /// @notice Anyone, once, at or after the coordinator's graduation (its poke calls it in try/catch): splits what
    /// the final harvest left (no minimum) and releases the held shares.
    function onGraduation() external;
    /// @notice FIT's executor (box 0), the box's swap module (Standard boxes) or the box's hook (its depth conversions,
    /// S5.M5; every box) only: fees its own swaps paid, returned in the next `collect` before the tip and the split,
    /// never split (REV-16; BC-019, BC-133). A module's notes are booked up to its fee-note allowance (Σ handed ×
    /// LP_FEE / 10^6 per side, added by `pullForModule`) and the rest clipped, never reverted (BC-132); the hook's carry
    /// no allowance and only Q (it never sells T, F72 (B)).
    function noteModuleFees(uint256 qFee, uint256 tFee) external;

    // ------------------------------------------------------------------ swap module hand-off (S5.M1, Standard boxes)
    /// @notice The box's swap module only. Once the graduation settlement ran (this call runs it if due): hands the
    /// module, by ERC-6909 `transfer`, every module ledger less 1 raw unit each (buy-back Q, creator Q, returned Q fees;
    /// FIT's T share and SELL_FOR_Q's T, creator T, returned T fees), adds the handed amounts × LP_FEE / 10^6 to the
    /// fee-note allowance per side, and records this contract's Q and T claim balances in transient storage (the
    /// step's snapshot). Before the settlement: zeros, nothing handed, no snapshot.
    function pullForModule()
        external
        returns (uint256 qBurn, uint256 qCreator, uint256 tForFit, uint256 tForCreator, uint256 qBack, uint256 tBack);
    /// @notice The box's swap module only: books `amount` of claims it minted here since this transaction's pull into
    /// `dest`'s ledger; at most the claims that arrived since the snapshot and are in no ledger (`ProceedsTooLarge`),
    /// and `NoStepOpen` without a pull in the same transaction. It can never book the next batch.
    function moduleProceeds(ModuleProceedsTo dest, uint256 amount) external;

    // ------------------------------------------------------------------ ETH intake
    function fundFees() external payable;
    function fundDepth() external payable;
    /// @notice Anyone (the box's royalty router for the Creator destination): `msg.value` credited to the creator
    /// payee, held until graduation (F69 C1), pulled with `claimCreator`. Only a box whose royalty destination is
    /// Creator (`NotCreatorRoyalties`).
    function fundCreator() external payable;

    // ------------------------------------------------------------------ payouts
    /// @notice Anyone, after this box and box 0 graduated (BC-020, BC-102): the held FIT share to `fundBudget()`.
    function payFit() external returns (uint256 amount);
    /// @notice Anyone, box 0 only: the Safe's credited share to the fixed Safe; if it refuses, the credit stays.
    function payPlatform() external returns (uint256 amount);
    /// @notice The current payee only: its claimable Q and T, to `to`.
    function claimCreator(address to) external returns (uint256 qAmount, uint256 tAmount);
    function proposeCreatorPayee(address proposed) external;
    function acceptCreatorPayee() external;

    // ------------------------------------------------------------------ wiring
    function kind() external view returns (BoxKind);
    function coordinator() external view returns (address);
    /// @notice The version's coordinator implementation: only a clone of it may initialise this receiver (BC-100).
    function coordinatorImplementation() external view returns (address);
    /// @notice The fixed cold half (`BoxReceiverExtension`: `initialize`, the payee changes), run by DELEGATECALL in
    /// this clone's context (S5.M1's split, swap-module-v1 § 7).
    function extension() external view returns (address);
    function hook() external view returns (address);
    function token() external view returns (address);
    function q() external view returns (address);
    function executor() external view returns (address);
    /// @notice Box 0: the fixed Safe (F44); address(0) for every other box.
    function platformSafe() external view returns (address);
    /// @notice The per-item stream (add-on 2, box 0), or address(0).
    function itemStream() external view returns (address);
    /// @notice BoxSpecV1 Q_STREAM_* and T_STREAM_* values.
    function qStream() external view returns (uint8);
    function tStream() external view returns (uint8);
    function royaltyDestination() external view returns (RoyaltyDestination);
    function creatorPayee() external view returns (address);
    function pendingCreatorPayee() external view returns (address);

    // ------------------------------------------------------------------ ledgers
    function graduationSettled() external view returns (bool);

    /// @notice Box 0: the current epoch, what the Safe kept in it, what it may still keep.
    function platformEpoch() external view returns (uint256 epoch, uint256 kept, uint256 remaining);
    /// @notice S5.M3, add-on 5 (Standard boxes; zeros without it): the cap per 30-day epoch (Q raw units) and its
    /// excess destination (BoxSpecV1 CAP_EXCESS_*), the current epoch, what the creator was counted in it, what it may
    /// still receive in it (the full cap until the settlement, whose held payouts count in epoch 0).
    function creatorCap()
        external
        view
        returns (uint256 capPerEpoch, uint8 excess, uint256 epoch, uint256 kept, uint256 remaining);
    function platformOwed() external view returns (uint256);
    /// @notice Box 0's 2/15 held before graduation (counts in epoch 0).
    function platformHeld() external view returns (uint256);
    function fitOwed() external view returns (uint256);
    /// @notice Other boxes' T-side FIT share (and SELL_FOR_Q's T after graduation), waiting for the swap module's sells
    /// (W4; `pullForModule` hands it over after the settlement, keeping 1 raw unit).
    function fitWaitingT() external view returns (uint256);
    /// @notice Every box's depth parts held here before graduation (BC-109, BC-143; box 0's too since F77); zero once
    /// settled.
    function depthHeld() external view returns (uint256 qAmount, uint256 tAmount);
    function creatorOwed() external view returns (uint256 qAmount, uint256 tAmount);
    function creatorHeld() external view returns (uint256 qAmount, uint256 tAmount);
    /// @notice The module's (box 0: FIT's executor's) fee notes waiting for the next collect.
    function moduleFeesPending() external view returns (uint256 qAmount, uint256 tAmount);
    /// @notice The hook's conversion fee notes (Q) waiting for the next collect (S5.M5).
    function hookFeesPending() external view returns (uint256 qAmount);
    /// @notice The box's swap module (S5.M1), address(0) for box 0.
    function swapModule() external view returns (address);
    /// @notice What the module's ledgers hold (each keeps 1 raw unit after a pull); `held` until the settlement.
    function moduleOwed()
        external
        view
        returns (
            uint256 qBurn,
            uint256 qCreator,
            uint256 tForFit,
            uint256 tForCreator,
            uint256 qBack,
            uint256 tBack,
            bool held
        );
    /// @notice The module's fee-note allowance per side (Σ handed × LP_FEE / 10^6, less the notes booked).
    function moduleFeeAllowance() external view returns (uint256 qAmount, uint256 tAmount);
    function totals()
        external
        view
        returns (
            uint256 toFit,
            uint256 toPlatform,
            uint256 qToDepth,
            uint256 tToDepth,
            uint256 tBurned,
            uint256 qToCreator,
            uint256 tToCreator
        );

    // ------------------------------------------------------------------ version constants
    function FEE_SHARE_DENOMINATOR() external view returns (uint256);
    function batchMin() external view returns (uint256);
    function TIP_BPS() external view returns (uint256);
    function tipMax() external view returns (uint256);
    function PLATFORM_CAP_WEI() external view returns (uint256);
    function PLATFORM_EPOCH_SECONDS() external view returns (uint256);
}

/// @notice Box 0 only: curve claims excluded from stream income (F126).
interface IBoxStreamSettlement {
    /// @notice T from curve batches held for depth, retained after settlement for the stream's graduation baseline.
    function streamCurveDepthT() external view returns (uint256);
}
