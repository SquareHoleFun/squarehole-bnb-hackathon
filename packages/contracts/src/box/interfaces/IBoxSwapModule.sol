// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IBoxPriceAverage} from "./IBoxHook.sol";

/// @title IBoxSwapModuleWiring (slice S5.M1: what a box's receiver relies on; docs/design/swap-module-v1.md § 4.2)
/// @notice The two calls a Standard box's receiver makes on its swap module at `initialize`: the module must name that
/// receiver and the box's Q, T and hook, and its first storage writes are paid in the creation transaction.
interface IBoxSwapModuleWiring {
    /// @notice Its receiver only, once, from the receiver's `initialize` (the creation transaction pays the module's
    /// first storage writes, swap-module § 6). Since S5.M3 the module builds every action of the receiver's menu
    /// (buy-back, sells for FIT, the creator conversions), so the menu is the final one.
    function initialize() external;

    /// @notice The module's wiring, read by the receiver at `initialize`: it must name that receiver and the box's Q,
    /// T and hook (one staticcall).
    function wiring() external view returns (address receiver, address q, address token, address hook);
}

/// @title IBoxSwapModule (slice S5.M2; docs/design/swap-module-v1.md § 4.3-4.8, § 5, § 6)
/// @notice A Standard box's swap module: one clone per box (architecture A, swap-module § 3), named in its receiver's
/// clone arguments (`swapModule`), funded only by the claims its receiver hands it (`IBoxReceiver.pullForModule`) after
/// the graduation settlement. It converts that box's fee shares between Q and T in bounded steps, by direct
/// `PoolManager.swap` in the box's own closed pool only, after graduation:
/// - **BuyBurn** (BUYBACK_BURN_T's buyers' 10/15): buys T with Q and burns it (a burn the vault's floor refuses waits).
/// - **SellForFit** (W4: sellers' FIT 3/15 in T, with SELL_FOR_Q's 10/15 on the same ledger): sells T for Q, booked to
///   FIT's owed Q in the receiver (`moduleProceeds`), which `payFit()` sends to FIT's executor.
/// - **BuyForCreator** (CREATOR_IN_T's buyers' 10/15, S5.M3): buys T with Q for the creator payee, minted as claims to
///   the receiver and booked to the payee (`moduleProceeds`, CreatorT); add-on 5's cap counted its Q at the split.
/// - **SellForCreator** (CREATOR_IN_Q's sellers' 10/15, S5.M3): sells T for Q, booked to the payee (`moduleProceeds`,
///   CreatorQ), where the receiver counts it against add-on 5's cap at face and sends any excess to its destination
///   (BURN: the burn-buy ledger, which BuyBurn then spends; POOL_DEPTH: the hook's claims).
/// - **REV-16's attribution** (§ 4.8): returned Q goes first to the creator-buy ledger, up to the fees its steps
///   reported, the rest to the burn-buy ledger; returned T first to the creator-sell ledger likewise, the rest to the
///   sell-for-FIT ledger.
///
/// **Bounds** (FIT's executor's reviewed ones, mirrored for sells; `BoxSwapBounds`): at most 49 ticks of impact per
/// step, never beyond the reference ∓ 99 ticks (buys: the cheaper-T of the 1-hour average and the latest sample;
/// sells: the dearer-T), one step per block per box across all actions, an output of at least (input − fee − slack)
/// at the limit price. A step's budget, valued in Q at the reference tick, must reach SWAP_STEP_MIN_Q; its caller's tip
/// is min(5% of the step's Q, FEE_BATCH_TIP_MAX_ETH), from the step itself, paid last inside the unlock. Every
/// condition that stops a step is a `Stop` reason (`StepSkipped`), never a revert, and the budget stays.
///
/// **Clone arguments** (`abi.encodePacked`, 102 bytes): `receiver` · `hook` · `priceAverage` · `q` · `token` (20
/// each) · `qAction` (1: the receiver's QStream value) · `tAction` (1: its TStream value).
/// @dev No owner, admin, pause, upgrade, setter or rescue (F23 C2); no token allowance and no ERC-6909 operator right
/// anywhere. No core path calls it (only the receiver's `initialize`), so it can block no collect, graduation, claim or
/// deepen (BC-060, BC-061, BC-132).
interface IBoxSwapModule is IBoxSwapModuleWiring, IUnlockCallback {
    enum Action {
        None,
        /// BUYBACK_BURN_T: Q → T, burned.
        BuyBurn,
        /// CREATOR_IN_T: Q → T for the creator payee (S5.M3).
        BuyForCreator,
        /// W4 and SELL_FOR_Q: T → Q, to FIT's owed Q.
        SellForFit,
        /// CREATOR_IN_Q: T → Q for the creator payee (S5.M3).
        SellForCreator
    }

    enum Stop {
        None,
        /// The box's hook has not migrated yet (nothing converts before graduation, BC-130).
        NotGraduated,
        /// This box already stepped in this block (any action).
        BlockLimit,
        /// The price average failed or has no full window yet.
        AverageNotReady,
        /// No room left in the step's direction: spot is at or beyond the reference ∓ 99 ticks.
        AtBand,
        /// The budget, valued in Q at the reference tick, is below SWAP_STEP_MIN_Q.
        BelowStepMin,
        /// The pool has no active liquidity.
        NoLiquidity,
        /// The action's budget is empty (each ledger keeps 1 raw unit).
        NothingToDo
    }

    /// @notice What one pull from the receiver added to the module's ledgers (raw units), after REV-16's attribution:
    /// `qCreator` / `tForCreator` include the returned fees booked back to the creator ledgers, `qBack` / `tBack` are
    /// the rest of the returned fees (booked to the burn-buy and sell-for-FIT ledgers).
    event Pulled(uint256 qBurn, uint256 qCreator, uint256 tForFit, uint256 tForCreator, uint256 qBack, uint256 tBack);
    /// @notice One step: what it spent and received (gross), the caller's tip (Q), the reference and the √prices.
    event Stepped(
        Action indexed action,
        uint256 amountIn,
        uint256 amountOut,
        uint256 tip,
        address tipTo,
        int24 referenceTick,
        uint160 sqrtPriceBeforeX96,
        uint160 sqrtPriceAfterX96,
        uint160 sqrtPriceLimitX96
    );
    event StepSkipped(Action indexed action, Stop reason);
    /// @notice A burn of bought T: `amount` burned (0: the vault's floor refused it), `stillPending` held to burn.
    event TokensBurned(uint256 amount, uint256 stillPending);
    /// @notice The LP share of this module's own swap fee, less the rounding slack, noted to the receiver (REV-16).
    event ModuleFeesReported(uint256 qFee, uint256 tFee);
    /// @notice S5.M3, swap-module § 13 point 7: a SellForCreator step found the creator's room for the epoch spent and
    /// add-on 5's excess BURN, so it burned `amount` of the creator's T instead of selling it: since the S5 review at
    /// most what that one sale would have sold (the same guards, block limit and sell limit), the rest left for later
    /// steps.
    event CreatorTBurned(uint256 amount);

    error NotReceiver(address caller);
    error NotPoolManager();
    error NotInitialised();
    error AlreadyInitialised();
    /// @notice v1 converts native-ETH Q only (Q is currency0; S12 adds ERC-20 Q).
    error QNotSupported(address q);
    /// @notice The clone arguments disagree with the receiver's streams or the hook's price average and receiver.
    error WiringMismatch();
    /// @notice `step` with `Action.None` (not an action; S5.M3 built the other four). Carries the box's actions.
    error ActionNotBuilt(uint8 qAction, uint8 tAction);
    error UnexpectedDelta();
    error PriceBoundBreached(uint160 sqrtPriceX96, uint160 sqrtPriceLimitX96);
    error OutputBelowBound(uint256 amountOut, uint256 minOut);
    error BurnDidNotReduceSupply();

    /// @notice Anyone: one bounded step of `action`, or a `Stop` reason (no revert for a skip). Pulls what the receiver
    /// owes first and burns T waiting to be burned. `tipTo` address(0) takes no tip (it stays in the budget).
    function step(Action action, address tipTo)
        external
        returns (Stop stop, uint256 amountIn, uint256 amountOut, uint256 tip);
    /// @notice Anyone: pulls what the receiver owes this module (no swap, no tip).
    function sync() external;
    /// @notice Anyone: burns T whose burn the vault's floor refused earlier (1 raw unit always stays, § 6).
    function burnPending() external returns (uint256 burned);

    /// @notice The ledgers (raw units; Σ Q ledgers == this module's Q claims, Σ T ledgers == its T claims,
    /// `tBurnPending` == its T balance).
    function budgets()
        external
        view
        returns (uint256 qBurn, uint256 qCreator, uint256 tForFit, uint256 tForCreator, uint256 tBurnPending);
    /// @notice For keepers, the site and S14's converter: whether a step of `action` could run at the current price
    /// (the average not poked) and within which price.
    function bounds(Action action) external view returns (bool ready, int24 referenceTick, uint160 sqrtPriceLimitX96);
    /// @notice S5.M3 (REV-16's attribution, swap-module § 4.8): the fees the creator ledgers' own steps reported (Q:
    /// BuyForCreator, T: SellForCreator) and not yet returned; a pull books returned fees to those ledgers first, up to
    /// these, and the rest to the burn-buy and sell-for-FIT ledgers.
    function creatorFeesPending() external view returns (uint256 qFee, uint256 tFee);
    function lastStepBlock() external view returns (uint256);
    function graduationSeen() external view returns (bool);
    function receiver() external view returns (address);
    function hook() external view returns (address);
    function priceAverage() external view returns (IBoxPriceAverage);
    function q() external view returns (address);
    function token() external view returns (address);
    /// @notice The receiver's QStream and TStream values this module was built for.
    function actions() external view returns (uint8 qAction, uint8 tAction);
}
