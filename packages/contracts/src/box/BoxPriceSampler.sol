// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Uniswap v4-core @ 46c68346, MIT files only (interfaces, libraries, types; DEPENDENCIES.md).
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Slot0} from "v4-core/src/types/Slot0.sol";
import {BoxSpecV1} from "./BoxSpecV1.sol";
import {IBoxHook, IBoxPriceAverage, IBoxPriceQuote} from "./interfaces/IBoxHook.sol";
import {BoxCloneReader} from "./BoxCloneReader.sol";

/// @title BoxPriceSampler (slice S4; the 1-hour price average of every box but box 0, a per-box clone)
/// @notice The average `deepen()` reads for a box whose price average is not FIT's executor (core-v1-interfaces § 6,
/// "a per-box sampler or a hook-recorded tick, within BC-018"): a per-box sampler costs the swap path nothing, so
/// BC-018's budget stays as measured. It is BuybackBurner's oracle (src/v2/BuybackBurner.sol:112-128, :253-254,
/// :372-375, :456-462, :505-552) with the reviewed bounds (FitBuybackBurner.sol:39-46: a 3,600 s window, samples
/// truncated to 100 ticks, a ring of 8 checkpoints) and nothing else: no budget, no swap.
/// - **Sample and hold:** at most one sample per timestamp, before nothing else in the block can move the price for
///   `deepen()` (which pokes first); a sample counts only for the time after it; while the pool has no active
///   liquidity the last sample stays in force (Fable R-19).
/// - **From graduation only:** before the box's hook has migrated `poke()` records nothing (the curve's price is not
///   a market price). The first sample after it is the graduation price P1 (the curve's lower tick, where `migrate`
///   leaves the price), not the spot, so a push in the first poke's block moves nothing; later samples move at most
///   100 ticks each.
/// - **Inert unless wired:** `poke()` writes only when the hook named in its arguments names this sampler as its
///   price average, so a stranger's clone of this code can record nothing for any box.
/// - **A quote for add-on 5** (S5.M3, swap-module § 4.2): `quoteTInQ(t)` values T in Q at the 1-hour average, rounded
///   up, for the receiver's creator-fee cap on T paid as T. A view: it adds no state and changes nothing above.
///
/// **Clone arguments** (`abi.encodePacked`, 60 bytes): `hook` (20) · `q` (20) · `token` (20).
/// @dev No owner, admin, pause, upgrade, setter or rescue (F23 C2); holds no funds.
contract BoxPriceSampler is IBoxPriceAverage, IBoxPriceQuote, BoxCloneReader {
    /// @notice The oracle's running state (one storage slot), as BuybackBurner.Oracle.
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

    event Observed(int24 poolTick, int24 recordedTick, int56 tickCumulative);

    uint32 public constant TWAP_WINDOW = BoxSpecV1.EXECUTOR_TWAP_WINDOW_SECONDS;
    int24 public constant MAX_OBSERVATION_STEP = BoxSpecV1.EXECUTOR_MAX_OBSERVATION_STEP;
    uint8 public constant CHECKPOINTS = 8;
    /// @notice ceil(TWAP_WINDOW / (CHECKPOINTS − 1)) as BuybackBurner.sol:309.
    uint32 public constant CHECKPOINT_SPACING = (TWAP_WINDOW + CHECKPOINTS - 2) / (CHECKPOINTS - 1);
    /// @notice Length of the clone arguments.
    uint256 public constant ARGS_LENGTH = 60;

    uint256 private constant _LIQUIDITY_OFFSET = 3;
    uint256 private constant _Q96 = 1 << 96;

    IPoolManager public immutable poolManager;

    Oracle internal _oracle;
    Checkpoint[CHECKPOINTS] internal _checkpoints;

    constructor(IPoolManager poolManager_) {
        poolManager = poolManager_;
    }

    /// @inheritdoc IBoxPriceAverage
    function poke() external returns (int24 recordedTick) {
        Oracle memory o = _oracle;
        if (o.filled == 0) {
            IBoxHook hook_ = IBoxHook(_argAddress(0));
            if (address(hook_.priceAverage()) != address(this) || hook_.migratedAtBlock() == 0) return o.tick;
            (int24 p1Tick,,) = hook_.curve();
            // casting to 'uint32' is safe until the year 2106
            // forge-lint: disable-next-line(unsafe-typecast)
            uint32 nowTs = uint32(block.timestamp);
            _oracle = Oracle({tick: p1Tick, time: nowTs, tickCumulative: 0, head: 0, filled: 1});
            _checkpoints[0] = Checkpoint({time: nowTs, tickCumulative: 0});
            emit Observed(p1Tick, p1Tick, 0);
            return p1Tick;
        }
        _observe(o);
        return _oracle.tick;
    }

    /// @inheritdoc IBoxPriceAverage
    function twap() external view returns (bool ready, int24 tick, uint32 window) {
        return _twap();
    }

    /// @inheritdoc IBoxPriceAverage
    function latestSampleTick() external view returns (int24) {
        return _oracle.tick;
    }

    /// @inheritdoc IBoxPriceQuote
    /// @dev Q per T = 1.0001^−tick = 2^192 / √P², at the average tick `twap()` reports; both divisions round up.
    function quoteTInQ(uint256 t) external view returns (bool ready, uint256 q) {
        int24 tick;
        (ready, tick,) = _twap();
        if (!ready) return (false, 0);
        uint256 s = TickMath.getSqrtPriceAtTick(tick);
        q = FullMath.mulDivRoundingUp(FullMath.mulDivRoundingUp(t, _Q96, s), _Q96, s);
    }

    function oracle() external view returns (Oracle memory) {
        return _oracle;
    }

    function checkpointAt(uint256 index) external view returns (Checkpoint memory) {
        return _checkpoints[index];
    }

    function hook() external view returns (address) {
        return _argAddress(0);
    }

    /// @dev BuybackBurner._observe (BuybackBurner.sol:505-527), unchanged.
    function _observe(Oracle memory o) private {
        // casting to 'uint32' is safe until the year 2106
        // forge-lint: disable-next-line(unsafe-typecast)
        uint32 nowTs = uint32(block.timestamp);
        if (o.time == nowTs) return;
        bytes32 stateSlot = _stateSlot();
        if (uint256(poolManager.extsload(bytes32(uint256(stateSlot) + _LIQUIDITY_OFFSET))) == 0) return;
        int24 poolTick = Slot0.wrap(poolManager.extsload(stateSlot)).tick();
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

    /// @dev BuybackBurner._twap (BuybackBurner.sol:530-552), unchanged: the mean recorded tick from the newest
    /// checkpoint at least TWAP_WINDOW old until now, rounded up.
    function _twap() private view returns (bool ready, int24 tick, uint32 window) {
        Oracle memory o = _oracle;
        // casting to 'uint32' is safe until the year 2106
        // forge-lint: disable-next-line(unsafe-typecast)
        uint32 nowTs = uint32(block.timestamp);
        if (o.filled == 0 || nowTs < TWAP_WINDOW) return (ready, tick, window);
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

    /// @dev The pool's Pool.State slot: keccak256(PoolId, POOLS_SLOT = 6) (StateLibrary @ 46c68346).
    function _stateSlot() private view returns (bytes32) {
        (address q_, address t_) = _argAddress2(20);
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(q_),
            currency1: Currency.wrap(t_),
            fee: BoxSpecV1.LP_FEE,
            tickSpacing: BoxSpecV1.TICK_SPACING,
            hooks: IHooks(_argAddress(0))
        });
        return keccak256(abi.encodePacked(keccak256(abi.encode(key)), bytes32(uint256(6))));
    }
}
