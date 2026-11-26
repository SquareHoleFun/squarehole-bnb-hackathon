// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Uniswap v4-core @ 46c68346, MIT files only (interfaces, libraries, types; DEPENDENCIES.md).
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {ProtocolFeeLibrary} from "v4-core/src/libraries/ProtocolFeeLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {Slot0} from "v4-core/src/types/Slot0.sol";
import {TransientReentrancyGuard} from "../libraries/TransientReentrancyGuard.sol";
import {BoxSpecV1} from "./BoxSpecV1.sol";
import {IFitBuybackExecutor, IBoxReceiver} from "./interfaces/IBoxReceiver.sol";
import {IBoxPriceAverage} from "./interfaces/IBoxHook.sol";

interface IBurnableToken {
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function burn(uint256 amount) external;
}

/// @title FitBuybackExecutor (slice S5; FIT's buy-and-burn executor for box 0, one full contract per chain)
/// @notice A copy of BuybackBurner with FitBuybackBurner's reviewed bounds (src/v2/BuybackBurner.sol:66-690,
/// src/v2/FitBuybackBurner.sol:38-78) with three changes:
/// 1. **No treasury** (F67 (2); BC-108): `receive()` credits the whole amount to the buy-back budget exactly as
///    `fundBudget()` does. There is no treasury address, share, `treasuryOwed` or `payTreasury()`
///    (BuybackBurner.sol:334-366 removed): no ETH reaching this contract by any path can pay the Safe; box 0's 2/15
///    is split and capped only in box 0's receiver (BC-106).
/// 2. **Box 0's price average** (`IBoxPriceAverage`, dynamic-pool-share § 1.4): `poke()`, `twap()` as before, plus
///    `latestSampleTick()` (the recorded tick, `oracle().tick` in BuybackBurner) for `deepen()`'s caught-up check.
/// 3. **REV-16 from its own swaps** (BC-019): after an execution that bought, it reports the pool fee its own chunks
///    paid to box 0's receiver (`noteModuleFees`), which returns that fee to this budget first, never split. The
///    figure is a lower bound: the LP share of the swap fee on the ETH it spent (Uniswap's protocol share excluded),
///    less two raw units per possible swap step for v4's rounding, so it never credits more than the positions got.
/// 4. **P8 batches** (BC-041; BoxSpecV1.FIT_BURN_BATCH_MCAP_BPS): an execution buys only while the budget is at least
///    0.05% of FIT's market cap at the 1-hour average price (totalSupply × the average's ETH per FIT; about 0.01 ETH at
///    box 0's graduation price), then in the same bounded steps; a smaller budget waits (`Stop.BelowBatch`).
/// It also needs no initialised pool at deployment (BuybackBurner.sol:296-297 removed): its address must be known
/// before box 0 exists (plan § 3.1, BC-064). Its first sample is `seedTick`: box 0's graduation tick P1, where
/// graduate() leaves the price (factory v1's planner passes it and the factory re-reads it; until the review of the
/// Misfits line it was the curve's start, the cheapest FIT price the pool can show, as FitBuybackBurner.sol:76, from
/// which the sample walked 26,880 ticks after graduation before the first buy). It samples only while the pool has
/// active liquidity.
/// @dev No owner, admin, pause, upgrade, sweep or rescue (F23 C2). ETH leaves only as swap input; FIT only by burning.
contract FitBuybackExecutor is IFitBuybackExecutor, IUnlockCallback, TransientReentrancyGuard {
    /// @notice Why an execution stopped (BuybackBurner.Stop).
    enum Stop {
        MaxChunks,
        BlockLimit,
        BudgetSpent,
        AtCeiling,
        AtReserve,
        NoLiquidity,
        TwapNotReady,
        NotGraduated,
        /// the budget is below one batch: 0.05% of FIT's market cap at the average price (P8; BC-041)
        BelowBatch
    }

    struct Oracle {
        int24 tick;
        uint32 time;
        int56 tickCumulative;
        uint8 head;
        uint8 filled;
    }

    struct Checkpoint {
        uint32 time;
        int56 tickCumulative;
    }

    struct Run {
        uint256 chunks;
        uint256 ethIn;
        uint256 fitOut;
        Stop reason;
    }

    event Observed(int24 poolTick, int24 recordedTick, int56 tickCumulative);
    event ChunkBought(
        uint256 indexed chunk,
        uint256 ethIn,
        uint256 fitOut,
        uint160 sqrtPriceBeforeX96,
        uint160 sqrtPriceAfterX96,
        uint160 sqrtPriceLimitX96
    );
    event TokensBurned(uint256 bought, uint256 unsolicited);
    event Executed(
        uint256 chunks,
        uint256 ethSpent,
        uint256 fitBought,
        uint256 fitBurned,
        int24 twapTick,
        uint160 floorSqrtPriceX96,
        Stop reason
    );
    /// @notice The pool fee this executor's own chunks paid, reported to box 0's receiver (REV-16).
    event ModuleFeesReported(uint256 qFee);

    error ZeroAddress();
    error NotPoolManager();
    error UnexpectedDelta();
    error PriceBoundBreached(uint160 sqrtPriceX96, uint160 sqrtPriceLimitX96);
    error OutputBelowBound(uint256 fitOut, uint256 minFitOut);
    error BurnDidNotReduceSupply();

    // ------------------------------------------------------------------ reviewed bounds (FitBuybackBurner.sol:39-46)

    uint24 public constant POOL_FEE = BoxSpecV1.LP_FEE;
    int24 public constant TICK_SPACING = BoxSpecV1.TICK_SPACING;
    uint32 public constant TWAP_WINDOW = BoxSpecV1.EXECUTOR_TWAP_WINDOW_SECONDS;
    int24 public constant MAX_IMPACT_TICKS = BoxSpecV1.EXECUTOR_MAX_IMPACT_TICKS;
    int24 public constant TWAP_BAND_TICKS = BoxSpecV1.EXECUTOR_TWAP_BAND_TICKS;
    int24 public constant MAX_OBSERVATION_STEP = BoxSpecV1.EXECUTOR_MAX_OBSERVATION_STEP;
    uint8 public constant MAX_CHUNKS_PER_BLOCK = BoxSpecV1.EXECUTOR_MAX_CHUNKS_PER_BLOCK;
    uint160 public constant MIN_SQRT_PRICE_X96 = BoxSpecV1.EXECUTOR_MIN_SQRT_PRICE_X96;
    uint8 public constant CHECKPOINTS = 8;
    uint32 public constant CHECKPOINT_SPACING = (TWAP_WINDOW + CHECKPOINTS - 2) / (CHECKPOINTS - 1);

    uint256 internal constant PIPS = 1_000_000;
    uint256 internal constant Q96 = 1 << 96;
    bytes32 internal constant POOLS_SLOT = bytes32(uint256(6));
    uint256 internal constant LIQUIDITY_OFFSET = 3;
    // casting to 'uint128'/'uint256' is safe because type(int128).max is positive and fits both
    // forge-lint: disable-next-line(unsafe-typecast)
    uint256 internal constant MAX_SWAP_IN = uint256(uint128(type(int128).max));

    // ------------------------------------------------------------------ immutables

    IPoolManager public immutable poolManager;
    /// @notice FIT (box 0's T, currency1; native ETH is currency0).
    IBurnableToken public immutable token;
    /// @notice Box 0's coordinator: nothing is bought before its `graduated()` first reads true.
    address public immutable launchPhase;
    /// @notice Box 0's hook clone.
    address public immutable hooks;
    /// @notice Box 0's receiver, told of this executor's own pool fees (REV-16).
    address public immutable receiver;
    bytes32 public immutable poolId;
    bytes32 internal immutable _poolStateSlot;
    uint256 internal immutable _sqrtImpactFactorX96;
    uint256 internal immutable _maxSwapSteps;

    // ------------------------------------------------------------------ state

    uint256 public totalToBudget;
    uint256 public totalEthSpent;
    uint256 public totalBurned;
    Oracle internal _oracle;
    Checkpoint[CHECKPOINTS] internal _checkpoints;
    uint64 internal _chunkBlock;
    uint8 internal _chunksInBlock;
    /// @notice Latched once `launchPhase.graduated()` read true (BuybackBurner.sol:259, :558-563).
    bool public graduationSeen;

    /// @param seedTick the first sample: box 0's graduation tick P1 (the curve's lower tick when ETH is currency0).
    constructor(
        IPoolManager poolManager_,
        IBurnableToken token_,
        address launchPhase_,
        address hooks_,
        address receiver_,
        int24 seedTick
    ) {
        if (
            address(poolManager_) == address(0) || address(token_) == address(0) || launchPhase_ == address(0)
                || hooks_ == address(0) || receiver_ == address(0)
        ) revert ZeroAddress();
        poolManager = poolManager_;
        token = token_;
        launchPhase = launchPhase_;
        hooks = hooks_;
        receiver = receiver_;
        bytes32 id = keccak256(
            abi.encode(
                PoolKey({
                    currency0: Currency.wrap(address(0)),
                    currency1: Currency.wrap(address(token_)),
                    fee: POOL_FEE,
                    tickSpacing: TICK_SPACING,
                    hooks: IHooks(hooks_)
                })
            )
        );
        poolId = id;
        _poolStateSlot = keccak256(abi.encodePacked(id, POOLS_SLOT));
        _sqrtImpactFactorX96 = TickMath.getSqrtPriceAtTick(-MAX_IMPACT_TICKS);
        // casting to 'uint24' is safe because both values are positive constants
        // forge-lint: disable-next-line(unsafe-typecast)
        _maxSwapSteps = uint256(uint24(MAX_IMPACT_TICKS)) / uint256(uint24(TICK_SPACING)) + 4;
        // casting to 'uint32' is safe until the year 2106
        // forge-lint: disable-next-line(unsafe-typecast)
        uint32 nowTs = uint32(block.timestamp);
        _oracle = Oracle({tick: seedTick, time: nowTs, tickCumulative: 0, head: 0, filled: 1});
        _checkpoints[0] = Checkpoint({time: nowTs, tickCumulative: 0});
    }

    // ================================================================== intake (no treasury share, BC-108)

    /// @inheritdoc IFitBuybackExecutor
    receive() external payable nonReentrant {
        _credit();
    }

    /// @inheritdoc IFitBuybackExecutor
    function fundBudget() external payable nonReentrant {
        _credit();
    }

    // ================================================================== oracle (IBoxPriceAverage)

    /// @inheritdoc IBoxPriceAverage
    function poke() external nonReentrant returns (int24 recordedTick) {
        _observe();
        recordedTick = _oracle.tick;
    }

    /// @inheritdoc IBoxPriceAverage
    function twap() external view returns (bool ready, int24 tick, uint32 window) {
        return _twap();
    }

    /// @inheritdoc IBoxPriceAverage
    function latestSampleTick() external view returns (int24) {
        return _oracle.tick;
    }

    // ================================================================== execution

    /// @notice Buys FIT with the budget within the bounds and burns every FIT held; then reports the pool fee its
    /// own chunks paid to box 0's receiver (REV-16). Anyone; the caller receives nothing (BuybackBurner.sol:385-406).
    function execute(uint256 maxChunks)
        external
        nonReentrant
        returns (uint256 chunks, uint256 ethSpent, uint256 fitBurned)
    {
        _observe();
        (bool ready, int24 twapTick,) = _twap();
        Run memory run;
        uint160 floorSqrt = 0;
        uint24 lpShare;
        if (!_graduated()) {
            run.reason = Stop.NotGraduated;
        } else if (!ready) {
            run.reason = Stop.TwapNotReady;
        } else if (budget() < batchThreshold()) {
            run.reason = Stop.BelowBatch;
        } else {
            lpShare = _lpShare(_slot0());
            (floorSqrt, run) = _buy(maxChunks, _referenceTick(twapTick));
        }
        chunks = run.chunks;
        ethSpent = run.ethIn;
        fitBurned = _burnHeld(run.fitOut);
        if (ethSpent != 0) {
            totalEthSpent += ethSpent;
            // forge-lint: disable-next-line(divide-before-multiply)
            uint256 fee = FullMath.mulDiv(ethSpent, lpShare, PIPS);
            uint256 slack = 2 * _maxSwapSteps * run.chunks;
            fee = fee > slack ? fee - slack : 0;
            if (fee != 0) {
                emit ModuleFeesReported(fee);
                IBoxReceiver(receiver).noteModuleFees(fee, 0);
            }
        }
        emit Executed(chunks, ethSpent, run.fitOut, fitBurned, twapTick, floorSqrt, run.reason);
    }

    /// @notice PoolManager callback of `execute`'s own unlock (BuybackBurner.sol:409-447, unchanged).
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || !_insideGuardedCall()) revert NotPoolManager();
        (uint256 n, uint160 floorSqrt, uint256 available) = abi.decode(data, (uint256, uint160, uint256));
        Run memory run;
        run.reason = Stop.MaxChunks;
        PoolKey memory key = poolKey();
        uint24 swapFee = _zeroForOneSwapFee(_slot0());
        while (run.chunks < n) {
            if (available == 0) {
                run.reason = Stop.BudgetSpent;
                break;
            }
            uint160 sqrtBefore = _slot0().sqrtPriceX96();
            uint160 limit = _chunkLimit(sqrtBefore, floorSqrt);
            if (limit >= sqrtBefore) {
                run.reason = Stop.AtCeiling;
                break;
            }
            (uint256 ethIn, uint256 fitOut, uint160 sqrtAfter) = _swapChunk(key, available, limit, swapFee);
            available -= ethIn;
            run.ethIn += ethIn;
            run.fitOut += fitOut;
            if (ethIn != 0 || fitOut != 0) {
                emit ChunkBought(run.chunks, ethIn, fitOut, sqrtBefore, sqrtAfter, limit);
                ++run.chunks;
            }
            if (fitOut == 0) {
                run.reason = Stop.NoLiquidity;
                break;
            }
        }
        if (run.ethIn != 0) {
            poolManager.sync(Currency.wrap(address(0)));
            if (poolManager.settle{value: run.ethIn}() != run.ethIn) revert UnexpectedDelta();
        }
        if (run.fitOut != 0) poolManager.take(Currency.wrap(address(token)), address(this), run.fitOut);
        return abi.encode(run);
    }

    // ================================================================== views

    /// @inheritdoc IFitBuybackExecutor
    function budget() public view returns (uint256) {
        return address(this).balance;
    }

    /// @notice One batch (P8; BC-041): FIT_BURN_BATCH_MCAP_BPS (5 = 0.05%) of FIT's market cap in ETH at the 1-hour
    /// average tick (FIT per ETH = 1.0001^tick, ETH being currency0); 0 while the average is not ready.
    function batchThreshold() public view returns (uint256) {
        (bool ready, int24 tick,) = _twap();
        if (!ready) return 0;
        uint256 sqrtP = TickMath.getSqrtPriceAtTick(tick);
        uint256 mcap = FullMath.mulDiv(FullMath.mulDiv(token.totalSupply(), Q96, sqrtP), Q96, sqrtP);
        return mcap * BoxSpecV1.FIT_BURN_BATCH_MCAP_BPS / 10_000;
    }

    /// @inheritdoc IFitBuybackExecutor
    function fitGraduated() external view returns (bool) {
        if (graduationSeen) return true;
        return _launchGraduated();
    }

    function poolKey() public view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(hooks)
        });
    }

    function oracle() external view returns (Oracle memory) {
        return _oracle;
    }

    function checkpointAt(uint256 index) external view returns (Checkpoint memory) {
        return _checkpoints[index];
    }

    // ================================================================== internals

    function _credit() private {
        if (msg.value == 0) return;
        totalToBudget += msg.value;
        emit BudgetFunded(msg.sender, msg.value);
    }

    /// @dev BuybackBurner._observe (BuybackBurner.sol:505-527), unchanged.
    function _observe() private {
        Oracle memory o = _oracle;
        // casting to 'uint32' is safe until the year 2106
        // forge-lint: disable-next-line(unsafe-typecast)
        uint32 nowTs = uint32(block.timestamp);
        if (o.time == nowTs) return;
        if (uint256(poolManager.extsload(bytes32(uint256(_poolStateSlot) + LIQUIDITY_OFFSET))) == 0) return;
        int24 poolTick = _slot0().tick();
        o.tickCumulative += int56(o.tick) * int56(uint56(nowTs - o.time));
        int24 lo = o.tick - MAX_OBSERVATION_STEP;
        int24 hi = o.tick + MAX_OBSERVATION_STEP;
        o.tick = poolTick < lo ? lo : (poolTick > hi ? hi : poolTick);
        o.time = nowTs;
        if (nowTs - _checkpoints[o.head].time >= CHECKPOINT_SPACING) {
            o.head = (o.head + 1) % CHECKPOINTS;
            _checkpoints[o.head] = Checkpoint({time: nowTs, tickCumulative: o.tickCumulative});
            if (o.filled < CHECKPOINTS) ++o.filled;
        }
        _oracle = o;
        emit Observed(poolTick, o.tick, o.tickCumulative);
    }

    /// @dev BuybackBurner._twap (BuybackBurner.sol:530-552), unchanged.
    function _twap() private view returns (bool ready, int24 tick, uint32 window) {
        Oracle memory o = _oracle;
        // casting to 'uint32' is safe until the year 2106
        // forge-lint: disable-next-line(unsafe-typecast)
        uint32 nowTs = uint32(block.timestamp);
        if (nowTs < TWAP_WINDOW) return (ready, tick, window);
        uint32 target = nowTs - TWAP_WINDOW;
        for (uint256 j; j < o.filled; ++j) {
            Checkpoint memory c = _checkpoints[(uint256(o.head) + CHECKPOINTS - j) % CHECKPOINTS];
            if (c.time > target) continue;
            int56 cumNow = o.tickCumulative + int56(o.tick) * int56(uint56(nowTs - o.time));
            window = nowTs - c.time;
            int56 span = int56(uint56(window));
            int56 diff = cumNow - c.tickCumulative;
            int56 mean = diff / span;
            if (diff % span != 0 && diff > 0) ++mean;
            // casting to 'int24' is safe because the mean of valid ticks is a valid tick
            // forge-lint: disable-next-line(unsafe-typecast)
            tick = int24(mean);
            ready = true;
            break;
        }
    }

    /// @dev The latch (BuybackBurner.sol:558-563): a coordinator that later reports false cannot pause buying.
    function _graduated() private returns (bool) {
        if (graduationSeen) return true;
        if (!_launchGraduated()) return false;
        graduationSeen = true;
        return true;
    }

    /// @dev `launchPhase.graduated()` by staticcall; a coordinator without code (before box 0 exists) reads false.
    function _launchGraduated() private view returns (bool) {
        (bool ok, bytes memory ret) = launchPhase.staticcall(abi.encodeWithSignature("graduated()"));
        return ok && ret.length == 32 && abi.decode(ret, (bool));
    }

    function _buy(uint256 maxChunks, int24 twapTick) private returns (uint160 floorSqrt, Run memory run) {
        // casting to 'uint64' is safe for any real block number
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 blockNo = uint64(block.number);
        uint256 used = _chunkBlock == blockNo ? _chunksInBlock : 0;
        uint256 allowance = MAX_CHUNKS_PER_BLOCK - used;
        uint256 n = maxChunks < allowance ? maxChunks : allowance;
        floorSqrt = _floorSqrtPrice(twapTick);
        uint256 available = budget();
        if (n == 0) {
            run.reason = maxChunks == 0 ? Stop.MaxChunks : Stop.BlockLimit;
            return (floorSqrt, run);
        }
        if (available == 0) {
            run.reason = Stop.BudgetSpent;
            return (floorSqrt, run);
        }
        // forge-lint: disable-next-line(reentrancy-no-eth)
        run = abi.decode(poolManager.unlock(abi.encode(n, floorSqrt, available)), (Run));
        if (run.reason == Stop.MaxChunks && n < maxChunks) run.reason = Stop.BlockLimit;
        if (run.chunks != 0) {
            _chunkBlock = blockNo;
            // casting to 'uint8' is safe because used + chunks ≤ MAX_CHUNKS_PER_BLOCK
            // forge-lint: disable-next-line(unsafe-typecast)
            _chunksInBlock = uint8(used + run.chunks);
        }
    }

    function _swapChunk(PoolKey memory key, uint256 available, uint160 limit, uint24 swapFee)
        private
        returns (uint256 ethIn, uint256 fitOut, uint160 sqrtAfter)
    {
        uint256 amountIn = available < MAX_SWAP_IN ? available : MAX_SWAP_IN;
        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: true,
                // casting to 'int256' is safe because amountIn ≤ type(int128).max
                // forge-lint: disable-next-line(unsafe-typecast)
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: limit
            }),
            ""
        );
        int128 d0 = delta.amount0();
        int128 d1 = delta.amount1();
        if (d0 > 0 || d1 < 0) revert UnexpectedDelta();
        // casting to 'uint128' is safe because d0 ≤ 0 and d1 ≥ 0 (checked above)
        // forge-lint: disable-next-line(unsafe-typecast)
        ethIn = uint256(uint128(-d0));
        // forge-lint: disable-next-line(unsafe-typecast)
        fitOut = uint256(uint128(d1));
        if (ethIn > amountIn) revert UnexpectedDelta();
        sqrtAfter = _slot0().sqrtPriceX96();
        if (sqrtAfter < limit) revert PriceBoundBreached(sqrtAfter, limit);
        uint256 minOut = _minFitOut(ethIn, limit, swapFee);
        if (fitOut < minOut) revert OutputBelowBound(fitOut, minOut);
    }

    function _minFitOut(uint256 ethIn, uint160 limit, uint24 swapFee) private view returns (uint256) {
        uint256 net = FullMath.mulDiv(ethIn, PIPS - swapFee, PIPS);
        uint256 slack = _maxSwapSteps;
        if (net <= 2 * slack) return 0;
        uint256 out = FullMath.mulDiv(FullMath.mulDiv(net - 2 * slack, limit, Q96), limit, Q96);
        return out > slack ? out - slack : 0;
    }

    function _chunkLimit(uint160 sqrtPriceX96, uint160 floorSqrt) private view returns (uint160) {
        // casting to 'uint160' is safe because the factor is < 2^96, so the result is ≤ sqrtPriceX96
        // forge-lint: disable-next-line(unsafe-typecast)
        uint160 impactLimit = uint160(FullMath.mulDivRoundingUp(sqrtPriceX96, _sqrtImpactFactorX96, Q96));
        return impactLimit > floorSqrt ? impactLimit : floorSqrt;
    }

    function _referenceTick(int24 twapTick) private view returns (int24) {
        int24 sampleTick = _oracle.tick;
        return sampleTick > twapTick ? sampleTick : twapTick;
    }

    function _floorSqrtPrice(int24 referenceTick) private pure returns (uint160 floorSqrt) {
        int24 t = referenceTick - TWAP_BAND_TICKS;
        if (t < TickMath.MIN_TICK) t = TickMath.MIN_TICK;
        floorSqrt = TickMath.getSqrtPriceAtTick(t);
        if (floorSqrt < MIN_SQRT_PRICE_X96) floorSqrt = MIN_SQRT_PRICE_X96;
    }

    function _burnHeld(uint256 bought) private returns (uint256 amount) {
        amount = token.balanceOf(address(this));
        if (amount == 0) return 0;
        uint256 supplyBefore = token.totalSupply();
        token.burn(amount);
        // forge-lint: disable-next-line(incorrect-strict-equality)
        if (token.totalSupply() + amount != supplyBefore || token.balanceOf(address(this)) != 0) {
            revert BurnDidNotReduceSupply();
        }
        totalBurned += amount;
        emit TokensBurned(bought, amount > bought ? amount - bought : 0);
    }

    function _slot0() private view returns (Slot0) {
        return Slot0.wrap(poolManager.extsload(_poolStateSlot));
    }

    function _zeroForOneSwapFee(Slot0 slot0) private pure returns (uint24) {
        uint16 protocolFee = ProtocolFeeLibrary.getZeroForOneFee(slot0.protocolFee());
        return protocolFee == 0 ? slot0.lpFee() : ProtocolFeeLibrary.calculateSwapFee(protocolFee, slot0.lpFee());
    }

    /// @dev The LPs' part of the ETH → FIT swap fee in pips: the combined fee less Uniswap's protocol share.
    function _lpShare(Slot0 slot0) private pure returns (uint24) {
        uint16 protocolFee = ProtocolFeeLibrary.getZeroForOneFee(slot0.protocolFee());
        uint24 swapFee =
            protocolFee == 0 ? slot0.lpFee() : ProtocolFeeLibrary.calculateSwapFee(protocolFee, slot0.lpFee());
        return swapFee - protocolFee;
    }
}
