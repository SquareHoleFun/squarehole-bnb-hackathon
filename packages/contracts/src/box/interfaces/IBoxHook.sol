// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Uniswap v4-core @ 46c68346, MIT interfaces and types (DEPENDENCIES.md).
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BoxKind, BoxPhase, DeepenSkip, DepthKind} from "./BoxTypes.sol";

/// @title IBoxPriceAverage
/// @notice The 1-hour price average `deepen()` reads (dynamic-pool-share.md § 1.4): one sample per block, at most 100
/// ticks per sample. Box 0: FIT's executor ring (BuybackBurner.sol:372-375 `poke`, :460 `twap`). Other boxes: a
/// per-box sampler (BoxPriceSampler; core-v1-interfaces § 6).
interface IBoxPriceAverage {
    /// @notice Records this block's sample (no-op if it has one). Anyone.
    function poke() external returns (int24 recordedTick);
    /// @return ready a full window exists; tick the average tick; window its length in seconds
    function twap() external view returns (bool ready, int24 tick, uint32 window);
    /// @notice The tick of the latest sample.
    function latestSampleTick() external view returns (int24);
}

/// @title IBoxPriceQuote (slice S5.M3; docs/design/swap-module-v1.md § 4.2, § 5)
/// @notice A Standard box's sampler (BoxPriceSampler) values T in Q for add-on 5's creator-fee cap: only T paid as T
/// (TO_CREATOR on the sellers' side) has no Q amount, so the receiver counts it at this value. A view: no funds, no
/// new state, no poke. Box 0's average (FIT's executor) does not have it; box 0 has no creator.
interface IBoxPriceQuote {
    /// @notice `t` valued in Q at the 1-hour average tick (Q per T = 1.0001^−tick), rounded up, so rounding never lets
    /// a payout pass the cap; `ready` false (and `q` 0) while the average has no full window.
    function quoteTInQ(uint256 t) external view returns (bool ready, uint256 q);
}

/// @title IBoxHook (slices S4 and S5; per-box clone at a mined address, F61 A1, plan P7)
/// @notice The hook of one box's pool, from the curve to the graduated pool, on one PoolKey for life. Generalises
/// FitPoolHook (src/v2/FitPoolHook.sol:64-832) and the S0 spike (test/spikes/SpikeBoxHook.sol) under D1, D2, D3, D6,
/// L7, F68, F72 and F77. Flags exactly 0x2AE0 (BoxSpecV1.HOOK_FLAGS), static 1% fee, no return-delta flag, no 0x91
/// prefix: Uniswap's automatic routing class (BC-031). The PoolManager and the version's coordinator implementation are
/// implementation immutables;
/// everything else is a clone argument, except `deployBlock` / `openAt` (written by `initialize`, packed into the
/// slot every swap reads) and the counters below.
///
/// - **Open** (DECISION-LOG F80; docs/design/open-at-clock-time.md): a clock time. `openAt()` is the spec's openAt (Unix
///   seconds), or the creation block's time + 1 when the spec says 0 (Now) or a time the creation reached: never the
///   creation block, always the next one at the latest (every block's timestamp exceeds its parent's).
/// - **Gate** (`beforeSwap`; F33, F61 O1): while `block.timestamp < openAt()` only the box's launch router swaps, and
///   only inside `deployBlock` (the bootstrap and the creator buy, F61 O2); while `block.timestamp` is in
///   [openAt(), windowEndsAt()) (WINDOW_SECONDS, 384 s) a buy passes only from the launch router, sells always pass;
///   the gate holds only while the curve is open (BC-096).
/// - **Curve** (BoxLayoutV1): single-sided T over the version's span; no swap may end beyond P0 (`BelowCurveFloor`).
/// - **Close on fill** (D1; BC-025): the swap that ends at or beyond P1 sets `closedAtBlock` in its own `afterSwap`;
///   from then every swap reverts `CurveIsClosed` until `migrate`.
/// - **Migrate** (the coordinator's `graduate()`): pokes the curve (fees as in `harvest`), removes it, walks the
///   price back to exactly P1, seeds L7 (F61; plan § 3.4): the ask (the pool share from P1 to the maximum price), the
///   "full-range" bid from P1 down to the minimum price at the ask's liquidity, and a bid sentinel from P0 down to
///   the minimum price holding the rest of R (BC-067, BC-029), salt 1. No code path removes or moves a seeded position.
/// - **Closed pool** (D3; BC-032): `beforeAddLiquidity`, `beforeRemoveLiquidity` and `beforeDonate` revert for
///   everyone; the hook's own changes skip its hooks (v4 `Hooks.noSelfCall`). Foreign `initialize` reverts.
/// - **Fees in batches** (D2; BC-017, BC-061): no fee work inside swaps. `harvest()` (the receiver's `collect()`)
///   pokes the curve before graduation, and after it at most four positions: the three L7 positions and the paired
///   position (BC-122; no rungs since F77, so no loop and no harvest step). It mints the fees as ERC-6909 claims:
///   before graduation first min(Q fees, reserveCap − reserveMinted) to the coordinator (the D6 reserve), the rest of
///   Q and all of T to the receiver.
/// - **Depth** (`deepen()`, anyone; BC-119 to BC-121, BC-123): the hook's own ERC-6909 claims are the depth budget.
///   Every box (box 0 since F77, which removed its Q-only rungs): pair and lock (F72 (B)): Q and T at the current price
///   into one full-range position, salt 3 (salt 2 is never used), sized by the smaller side, the Q side capped at 10%
///   of the Q the core (the pair included) holds within 10% of t_ref; the unmatched side waits. Guards: graduated,
///   ≥ 300 blocks since the last add, average ready and caught up (≤ 99 ticks from spot), |spot − average| ≤ 99, the
///   Q side ≥ MIN_ADD (0.5% of the raise); a skipped add returns `DeepenSkip` and keeps the budget;
///   the add runs only in this hook's own unlock (a foreign unlock reverts), at most one per block; before adding
///   into a position with fees it pokes it and mints them to the receiver, then spends exactly the principal.
/// - **Depth conversions** (S5.M5; R F76, every box since F77; swap-module-v1 § 8; BC-137): when the T side (valued at
///   spot) is below MIN_ADD, `deepen()` buys T with x = min(DEPTH_CONVERT_SHARE_BPS of the unpaired Q (Q budget − T
///   value), the Q budget less the tip) in one exact-input swap in this box's own pool, inside the swap module's bounds
///   (BoxSwapBounds: limit the nearer of spot − 49 ticks and t_ref − 99 ticks, t_ref the cheaper-T of the average and
///   the latest sample; minimum output on what it spent). The bought T stays as the hook's claims (the depth budget).
///   If both sides now reach MIN_ADD at the re-read price, the pair follows in the same unlock (`DepthKind.Pair`);
///   otherwise the call ends as a conversion (`DepthKind.Convert`). Either starts the 300-block cooldown. A conversion
///   alone needs DEPTH_CONVERT_MIN_Q of what it can spend, min(x, the room before its limit) (S5 review: a sliver of
///   room left by a push or a buy-back is a skip, not a conversion); one expected to pair has no separate minimum
///   (`ConvertBelowMin` otherwise, a skip that starts no cooldown).
///   T is never sold (F72 (B)). The conversion's own LP fee is noted to the receiver (`noteModuleFees`, REV-16) and
///   comes back to these claims in the next batch, never split.
/// - **Tip and amounts:** min(5% of the Q the call spent (the conversion's input and the pair's Q), `deepenTipCap()`),
///   from the Q side, to `tipTo`, last. `qUsed` is that Q (so the Q budget falls by `qUsed + tip`), `tUsed` the T the
///   pair placed; a conversion's T bought is in `DepthConverted`. Nothing ever removes depth liquidity.
/// - No owner, admin, pause, upgrade, `receive` or `fallback`; no ETH held (F23 C2).
/// @dev Invariants: one pool per hook; no position's liquidity ever decreases except the curve's single removal
/// inside `migrate`; the hook's claim balances == depth budget between calls; reserveMinted ≤ reserveCap; no swap
/// writes a storage slot from zero (BC-018).
interface IBoxHook is IHooks, IUnlockCallback {
    event PoolLaunched(
        PoolId indexed poolId,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint160 sqrtPriceX96,
        uint256 tokenDeposited
    );
    /// @notice The filling swap closed the curve (D1), in its own afterSwap.
    event CurveClosed(PoolId indexed poolId, uint256 blockNumber, uint160 sqrtPriceX96);
    /// @notice `migrate`: what the curve held, the three L7 positions' liquidity, the T pulled from the coordinator,
    /// the Q the positions could not take (minted to the receiver as fees).
    event Migrated(
        PoolId indexed poolId,
        uint256 qFromCurve,
        uint256 tFromCurve,
        uint128 askLiquidity,
        uint128 bidLiquidity,
        uint128 sentinelLiquidity,
        uint256 tokenPulled,
        uint256 qDust
    );
    event Harvested(PoolId indexed poolId, uint256 qFees, uint256 tFees, uint256 qToReserve);
    event Deepened(
        PoolId indexed poolId,
        DepthKind kind,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint256 qUsed,
        uint256 tUsed,
        uint256 tip
    );
    event DeepenSkipped(PoolId indexed poolId, DeepenSkip reason);
    /// @notice S5.M5: one depth conversion inside `deepen()`: the Q it spent, the T it bought (both now the hook's
    /// claims' change), the reference tick, the √price before and after, and the limit it swapped to.
    event DepthConverted(
        PoolId indexed poolId,
        uint256 qIn,
        uint256 tOut,
        int24 referenceTick,
        uint160 sqrtPriceBeforeX96,
        uint160 sqrtPriceAfterX96,
        uint160 sqrtPriceLimitX96
    );

    error NotPoolManager();
    error NotCoordinator(address caller);
    error NotReceiver(address caller);
    error AlreadyInitialised();
    /// @notice A clone the factory never initialised (SH-S0-spikes decision 9; BC-100).
    error NotInitialised();
    error AlreadyLaunched();
    error InvalidHookAddress();
    error UnknownPool();
    error ForeignInitialize();
    error LiquidityLocked();
    error DonationsDisabled();
    error HookNotImplemented();
    /// @notice Before the open (Unix seconds), only the launch router trades, and only in the creation block.
    error TradingNotOpen(uint256 openAt);
    /// @notice In the launch window a buy goes through the box's launch router until `windowEnd` (Unix seconds).
    error BuyThroughLaunchRouter(address router, uint256 windowEnd);
    /// @notice The curve is closed: every swap waits for `graduate()` (D1).
    error CurveIsClosed(uint256 closedAtBlock);
    error BelowCurveFloor(uint160 sqrtPriceX96);
    error NotClosed();
    error AlreadyMigrated();
    error MigrationNotNeutral();
    /// @notice `deepen()` or `harvest()` reached from inside another unlock.
    error ForeignUnlock();
    /// @notice S5.M5: a depth conversion ended beyond its limit or bought less than its minimum output (never expected:
    /// the swap's own limit and v4's maths prevent both; the whole `deepen()` reverts, as FitBuybackExecutor's).
    error ConversionOutOfBounds(uint160 sqrtPriceX96, uint160 sqrtPriceLimitX96, uint256 amountOut, uint256 minOut);

    /// @notice The box's coordinator only, once, in createBox: deployBlock = block.number; openAt = the `openAt`
    /// argument, or block.timestamp + 1 when it is 0 (Now) or not after block.timestamp (the next block). The caller
    /// must be the `coordinator` argument and a clone of `coordinatorImplementation()` (BC-100: a stranger's clone of
    /// this code stays inert).
    function initialize() external;
    /// @notice The coordinator only, once: initialises the pool at P0 and seeds the curve with T pulled from the
    /// coordinator (`launch` is the only path that initialises a pool keyed to this hook; S0 decision 9).
    function launch() external;
    /// @notice The coordinator only, once, after the close (its `graduate()`): see the contract notes.
    function migrate(uint256 tokenBudget)
        external
        returns (uint256 qFromCurve, uint256 tFromCurve, uint256 tokenPulled, uint256 qDust);
    /// @notice The receiver only (its `collect()`): pokes and mints the batch's fees; see the contract notes.
    function harvest() external returns (uint256 qFees, uint256 tFees, uint256 qToReserve);
    /// @notice Anyone: one depth add, or a conversion (and a pair when it can follow, S5.M5), if every guard holds; else
    /// a `DeepenSkip` reason and nothing changes.
    function deepen(address tipTo)
        external
        returns (DepthKind kind, DeepenSkip skip, uint256 qUsed, uint256 tUsed, uint256 tip);

    // ------------------------------------------------------------------ wiring
    function poolManager() external view returns (IPoolManager);
    function poolKey() external view returns (PoolKey memory);
    function poolId() external view returns (PoolId);
    function kind() external view returns (BoxKind);
    function token() external view returns (address);
    /// @notice The box's Q (address(0) = native ETH).
    function q() external view returns (address);
    function coordinator() external view returns (address);
    /// @notice The version's coordinator implementation: only a clone of it may initialise this hook.
    function coordinatorImplementation() external view returns (address);
    function receiver() external view returns (address);
    function launchRouter() external view returns (address);
    function priceAverage() external view returns (IBoxPriceAverage);
    function raise() external view returns (uint256);

    // ------------------------------------------------------------------ state
    function phase() external view returns (BoxPhase);
    function deployBlock() external view returns (uint256);
    /// @notice When trading opens, in Unix seconds (see the contract notes: the spec's openAt, or the creation block's
    /// time + 1 for Now); the first block with `block.timestamp >= openAt()` is the window's first. 0 before
    /// `initialize`.
    function openAt() external view returns (uint256);
    /// @notice openAt() + WINDOW_SECONDS: from this second on every route trades at the pool fee alone.
    function windowEndsAt() external view returns (uint256);
    function closed() external view returns (bool);
    function closedAtBlock() external view returns (uint256);
    function migratedAtBlock() external view returns (uint256);
    /// @notice The curve's range (P1 and P0 ticks by token order) and its liquidity (0 after `migrate`).
    function curve() external view returns (int24 tickLower, int24 tickUpper, uint128 liquidity);
    /// @notice The L7 positions' liquidity (all 0 before `migrate`).
    function graduatedLayout()
        external
        view
        returns (uint128 askLiquidity, uint128 bidLiquidity, uint128 sentinelLiquidity);
    /// @notice D6: 0.1% of R (BoxSpecV1.GRADUATION_REWARD_CAP_BPS).
    function reserveCap() external view returns (uint256);
    function reserveMinted() external view returns (uint256);
    /// @notice The hook's ERC-6909 claims of Q and T: the depth budget.
    function depthBudget() external view returns (uint256 qBudget, uint256 tBudget);
    function lastDeepenBlock() external view returns (uint256);
    /// @notice The pair-and-lock position's liquidity (every box, box 0 included since F77).
    function pairedLiquidity() external view returns (uint128);

    // ------------------------------------------------------------------ version constants
    function LP_FEE() external view returns (uint24);
    function TICK_SPACING() external view returns (int24);
    /// @notice The launch window's length in seconds: BoxSpecV1.WINDOW_STEPS (32) steps of TAX_STEP_SECONDS (12).
    function WINDOW_SECONDS() external view returns (uint256);
    function REQUIRED_FLAGS() external view returns (uint160);
    function DEEPEN_COOLDOWN_BLOCKS() external view returns (uint256);
    function MAX_DEVIATION_TICKS() external view returns (int24);
    /// @notice 0.5% of the raise.
    function minAdd() external view returns (uint256);
    function deepenTipCap() external view returns (uint256);
}
