// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BoxKind, BoxPhase} from "../../box/interfaces/BoxTypes.sol";
import {IBoxOpenGateV2} from "./IBoxCoordinatorV2.sol";

/// @notice Permissionless protocol-step outcome; no money moves for a skip.
enum ProtocolSkip { None, StepTaken, BelowMinimum }

/// @notice M2 holder notice; the hook alone reports fee units in P, without moving money.
interface IBoxHolderNoticeV2 {
    /// @notice Hook only, capped fail-safe notice of a trade's P fee; no transfer or external conversion.
    function onTradeFee(address swapper, bool buy, uint256 fee) external;
}

/// @notice One side's batch receipt, read without moving money. Odd ids buy, even ids sell; ids start at 1.
struct TradeBatchV2 {
    /// @notice All user units, including failed notices; never use successful notices as denominator.
    uint256 tradeUnits;
    /// @notice Bootstrap, deepen, fee-conversion and receiver-buy units, excluded from holder credits but retained in source allocation.
    uint256 protocolUnits;
    /// @notice Actual P claims minted to receiver for this side, after D6 and before receiver tip/carry/split.
    uint256 netP;
    /// @notice True once the units are frozen and all pending T fees have been converted; the receipt never changes again.
    bool closed;
}

/// @notice Additive batch notice. Implementations authenticate their immutable hook; no funds move.
interface IBoxHolderBatchNoticeV2 {
    /// @notice Hook only, capped and fail-safe; cumulative units are already stored before this notice.
    /// Swapper is v4's settlement caller, not a trusted beneficiary. Read eligible balances independently.
    function onTradeFeeBatch(uint256 batchId, address swapper, bool buy, uint256 units) external;
}

/// @notice CQ11-A pool interface; independent of box 0. Buys pay 1% in P and sales pay 1% in T.
interface IBoxHookV2 is IHooks, IUnlockCallback, IBoxOpenGateV2 {
    /// @notice PoolManager callbacks report curve seeding; T moves from the coordinator into the pool.
    event PoolLaunched(PoolId indexed poolId, int24 tickLower, int24 tickUpper, uint128 liquidity, uint160 sqrtPriceX96, uint256 tokenDeposited);
    /// @notice PoolManager callback records fill; no money moves beyond the filling trade.
    event CurveClosed(PoolId indexed poolId, uint256 blockNumber, uint160 sqrtPriceX96);
    /// @notice Receiver harvest reports P fees and P reserve; sellers P came from fee sales.
    event HarvestedV2(PoolId indexed poolId, uint256 buyersP, uint256 sellersP, uint256 qToReserve);
    /// @notice Coordinator migration reports one position, P left for depth and T burned.
    event MigratedV2(PoolId indexed poolId, uint128 liquidity, uint256 qLeft, uint256 tBurned);
    /// @notice Legacy pre-F137 log shape for historical readers; plain hooks never emit this event.
    event SaleFee(PoolId indexed poolId, address indexed payer, uint256 fee);
    /// @notice Permissionless conversion of post-graduation T fees; pOut includes the tip actually paid.
    event FeesSold(PoolId indexed poolId, address indexed caller, uint256 tIn, uint256 pOut, uint256 tip);
    /// @notice Permissionless deepen reports the P and T added, with the real-P tip actually paid.
    event Deepened(PoolId indexed poolId, uint128 liquidity, uint256 qUsed, uint256 tUsed, uint256 tip);
    /// @notice Permissionless deepen reports no movement when skipped.
    event DeepenSkipped(PoolId indexed poolId, ProtocolSkip reason);
    /// @notice Coordinator close reports P claims moved to its pot and T burned.
    event Closed(PoolId indexed poolId, uint256 qToPot, uint256 tBurned);
    /// @notice Rejects an invalid caller or pool operation atomically; no money moves.
    error NotPoolManager();
    /// @notice Rejects an invalid caller or pool operation atomically; no money moves.
    error NotCoordinator(address caller);
    /// @notice Rejects an invalid caller or pool operation atomically; no money moves.
    error NotReceiver(address caller);
    /// @notice Rejects an invalid caller or pool operation atomically; no money moves.
    error AlreadyInitialised();
    /// @notice Rejects an invalid caller or pool operation atomically; no money moves.
    error NotInitialised();
    /// @notice Rejects an invalid caller or pool operation atomically; no money moves.
    error AlreadyLaunched();
    /// @notice Rejects an invalid caller or pool operation atomically; no money moves.
    error InvalidHookAddress();
    /// @notice Rejects an invalid caller or pool operation atomically; no money moves.
    error UnknownPool();
    /// @notice Rejects an invalid caller or pool operation atomically; no money moves.
    error ForeignInitialize();
    /// @notice Rejects an invalid caller or pool operation atomically; no money moves.
    error LiquidityLocked();
    /// @notice Rejects an invalid caller or pool operation atomically; no money moves.
    error DonationsDisabled();
    /// @notice Rejects an invalid caller or pool operation atomically; no money moves.
    error HookNotImplemented();
    /// @notice Rejects an invalid caller or pool operation atomically; no money moves.
    error TradingNotOpen(uint256 openAt);
    /// @notice Rejects an invalid caller or pool operation atomically; no money moves.
    error BuyThroughLaunchRouter(address router, uint256 windowEnd);
    /// @notice Rejects an invalid caller or pool operation atomically; no money moves.
    error CurveIsClosed(uint256 closedAtBlock);
    /// @notice Rejects an invalid caller or pool operation atomically; no money moves.
    error BelowCurveFloor(uint160 sqrtPriceX96);
    /// @notice Rejects an invalid caller or pool operation atomically; no money moves.
    error NotClosed();
    /// @notice Rejects an invalid caller or pool operation atomically; no money moves.
    error AlreadyMigrated();
    /// @notice Rejects an invalid caller or pool operation atomically; no money moves.
    error ForeignUnlock();
    /// @notice Rejects an invalid caller or pool operation atomically; no money moves.
    error FailurePending(uint256 deadline);
    /// @notice Rejects an invalid caller or pool operation atomically; no money moves.
    error PartialExactOutSale();
    /// @notice Rejects an invalid caller or pool operation atomically; no money moves.
    error ReceiverCannotSell();
    /// @notice Rejects an invalid caller or pool operation atomically; no money moves.
    error ProtocolStepTaken();
    /// @notice Rejects an invalid caller or pool operation atomically; no money moves.
    error BoxFailed();
    /// @notice Coordinator only, once; authenticate clone wiring; moves no money.
    function initialize() external;
    /// @notice Coordinator only, once; pull T and seed the launch curve.
    function launch() external;
    /// @notice Coordinator only after fill; remove the curve and seed one full-range position; surplus P stays in depth and surplus T is burned fail-safe.
    function migrate(uint256 tokenBudget)
        external
        returns (uint256 qFromCurve, uint256 tFromCurve, uint256 tokenPulled, uint256 qDust);
    /// @notice Anyone may read this pool wiring or state; moves no money.
    function poolManager() external view returns (IPoolManager);
    /// @notice Anyone may read this pool wiring or state; moves no money.
    function poolKey() external view returns (PoolKey memory);
    /// @notice Anyone may read this pool wiring or state; moves no money.
    function poolId() external view returns (PoolId);
    /// @notice Anyone may read this pool wiring or state; moves no money.
    function kind() external view returns (BoxKind);
    /// @notice Anyone may read this pool wiring or state; moves no money.
    function token() external view returns (address);
    /// @notice Anyone may read this pool wiring or state; moves no money.
    function q() external view returns (address);
    /// @notice Anyone may read this pool wiring or state; moves no money.
    function coordinator() external view returns (address);
    /// @notice Anyone may read this pool wiring or state; moves no money.
    function coordinatorImplementation() external view returns (address);
    /// @notice Anyone may read this pool wiring or state; moves no money.
    function receiver() external view returns (address);
    /// @notice Anyone may read this pool wiring or state; moves no money.
    function launchRouter() external view returns (address);
    /// @notice Anyone may read this pool wiring or state; moves no money.
    function raise() external view returns (uint256);
    /// @notice Anyone may read this pool wiring or state; moves no money.
    function phase() external view returns (BoxPhase);
    /// @notice Anyone may read this pool wiring or state; moves no money.
    function deployBlock() external view returns (uint256);
    /// @notice Anyone may read this pool wiring or state; moves no money.
    function openAt() external view returns (uint256);
    /// @notice Anyone may read this pool wiring or state; moves no money.
    function windowEndsAt() external view returns (uint256);
    /// @notice Anyone may read this pool wiring or state; moves no money.
    function closed() external view returns (bool);
    /// @notice Anyone may read this pool wiring or state; moves no money.
    function closedAtBlock() external view returns (uint256);
    /// @notice Anyone may read this pool wiring or state; moves no money.
    function migratedAtBlock() external view returns (uint256);
    /// @notice Anyone may read this pool wiring or state; moves no money.
    function curve() external view returns (int24 tickLower, int24 tickUpper, uint128 liquidity);
    /// @notice Anyone may read this pool wiring or state; moves no money.
    function reserveCap() external view returns (uint256);
    /// @notice Anyone may read this pool wiring or state; moves no money.
    function reserveMinted() external view returns (uint256);
    /// @notice Anyone may read this pool wiring or state; moves no money.
    function pairedLiquidity() external view returns (uint128);
    /// @notice Anyone may read this pool wiring or state; moves no money.
    function TICK_SPACING() external view returns (int24);
    /// @notice Anyone may read this pool wiring or state; moves no money.
    function WINDOW_SECONDS() external view returns (uint256);
    /// @notice Anyone may read this pool wiring or state; moves no money.
    function REQUIRED_FLAGS() external view returns (uint160);
    /// @notice Anyone may read this pool wiring or state; moves no money.
    function deepenTipCap() external view returns (uint256);
    /// @notice Receiver only; mint buyers P fees after reserve, return already-minted sellers P and reset its counter. Failed hooks only drain the counter.
    function harvest() external returns (uint256 buyersP, uint256 sellersP, uint256 qToReserve);
    /// @notice Anyone after graduation; buy with 49.75% of spendable P then add full range with only that T; pay a capped real-P tip last.
    function deepen(address tipTo) external returns (ProtocolSkip skip, uint256 qUsed, uint256 tUsed, uint256 tip);
    /// @notice Coordinator only in its atomic failure; distribute fees, close the curve, move P claims to the coordinator, burn T fail-safe; never tips.
    function close() external returns (uint256 qToPot, uint256 tBurned);
    /// @notice Anyone reads exact irrecoverable T inventory of this pool after failure close; zero otherwise.
    /// @dev Excludes ERC-6909 backing, gifts and other pools. The coordinator subtracts it from outstanding T;
    /// no money moves, and close() still reports only P claims moved and T actually burned.
    function closedTResidue() external view returns (uint256);
    /// @notice Anyone reads the fill timestamp used by the seven-day graduation escape hatch; no money moves.
    function closedAt() external view returns (uint256);
    /// @notice Anyone reads whether failure closed this pool; no money moves.
    function failed() external view returns (bool);
    /// @notice Anyone reads the shared deepen/buy-back block mark; no money moves.
    function lastProtocolBlock() external view returns (uint256);
    /// @notice Anyone reads sellers P already minted to the receiver and not yet harvested; excludes the storage sentinel.
    /// @dev Anyone may read saleFeesPending; no funds move.
    function saleFeesPending() external view returns (uint256);
    /// @notice Anyone reads spendable P claims at the hook; no T budget or money movement.
    /// @dev Anyone may read depthBudget; no funds move.
    function depthBudget() external view returns (uint256 pBudget);
    /// @notice Anyone reads the optional cached holder address; zero disables M2 accounting. No money moves.
    function holderLedger() external view returns (address);
    /// @notice Anyone reads this side's open batch id (odd buy/even sell), zero without a ledger. No money moves.
    function currentTradeBatch(bool buy) external view returns (uint256);
    /// @notice Anyone reads cumulative units, minted P after D6, and immutable closure. No money moves.
    /// Includes missed notices in tradeUnits; protocolUnits never earn holder credit. A zero netP can be closed.
    function tradeBatch(uint256 batchId) external view returns (TradeBatchV2 memory);
    /// @notice Anyone after graduation sells only waiting T fees in this pool, within 49 ticks of live spot.
    /// The caller receives at most 5% of this step's P, capped at tipMaxQ; the receiver receives the rest.
    function sellFees() external returns (ProtocolSkip skip, uint256 tIn, uint256 pOut, uint256 tip);
    /// @notice Anyone reads realized post-graduation T fees waiting to sell; excludes gifts and refused burns.
    function tFeesPending() external view returns (uint256);
    /// @notice Anyone reads realized T fees still owed to a seller batch; no funds move.
    function tradeBatchPendingT(uint256 batchId) external view returns (uint256);
    /// @notice Anyone reads cumulative P credited to all source batches; no funds move.
    function tradeBatchTotalP() external view returns (uint256);
    /// @notice Anyone reads the fixed 1% LP fee; no money moves.
    function POOL_FEE() external view returns (uint24);
}
