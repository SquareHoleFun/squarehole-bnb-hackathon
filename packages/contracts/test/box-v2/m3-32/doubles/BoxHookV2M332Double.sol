// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Test-only M3 fixture copy, synchronized with F137 plain-hook accounting.

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {Slot0} from "v4-core/src/types/Slot0.sol";
import {BoxSwapBoundsV2 as Bounds} from "../../../../src/box-v2/libraries/BoxSwapBoundsV2.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxKind, BoxPhase} from "../../../../src/box/interfaces/BoxTypes.sol";
import {BoxClones} from "../../../../src/box/libraries/BoxClones.sol";
import {GATE_CLOSED_OPEN_AT, IBoxCoordinatorV2} from "../../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {IBoxHookV2, ProtocolSkip, TradeBatchV2} from "../../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {ReleaseConstantsV2 as C} from "../../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";
import {BoxHookV2Args as A} from "../../../../src/box-v2/libraries/BoxHookV2Args.sol";
import {BoxHookV2BaseM332Double} from "./BoxHookV2BaseM332Double.sol";
import {BoxRolesV2} from "../../../../src/box-v2/interfaces/IBoxRegistryV2.sol";

/// @notice Closed plain pool. Buys pay 1% LP fees in P; sales pay 1% LP fees in T.
/// @dev Only the fixed extension executes lifecycle unlocks. Only PoolManager and the optional capped holder notice run on the swap path.
contract BoxHookV2M332Double is IBoxHookV2, BoxHookV2BaseM332Double {
    error OpenOutOfRange(uint256 openAt);
    bytes32 private constant _T_PROTOCOL_BEFORE = keccak256("squarehole.v2.hook.tProtocolBefore");
    uint24 public constant POOL_FEE = C.V2_POOL_FEE;
    int24 public constant TICK_SPACING = 60;
    uint256 public constant WINDOW_SECONDS = 384;
    uint160 public constant REQUIRED_FLAGS = C.V2_HOOK_FLAGS;
    address public immutable coordinatorImplementation;
    address public immutable extension;
    constructor(IPoolManager pm, address coordinatorImplementation_, address extension_) BoxHookV2BaseM332Double(pm) {
        coordinatorImplementation = coordinatorImplementation_;
        extension = extension_;
        _w = 1 << _O_DEPLOY;
    }
    /// @inheritdoc IBoxHookV2
    function initialize() external {
        address c = _argAddress(A.COORDINATOR);
        if (msg.sender != c || !BoxClones.isCloneOf(c, coordinatorImplementation)) revert NotCoordinator(msg.sender);
        if (_w != 0) revert AlreadyInitialised();
        if (uint160(address(this)) & Hooks.ALL_HOOK_MASK != REQUIRED_FLAGS ||
            uint160(address(this)) >> 152 == BoxSpecV1.HOOK_FORBIDDEN_ADDRESS_PREFIX) revert InvalidHookAddress();
        (address p, address t) = _argAddress2(A.Q);
        if (p >= t) revert QNotCurrency0(p, t);
        uint8 k = _argUint8(A.KIND);
        if (k != uint8(BoxKind.Standard)) revert UnknownKind(k);
        uint256 open = GATE_CLOSED_OPEN_AT;
        uint256 end;
        if (IBoxCoordinatorV2(c).gateOpen()) {
            open = IBoxCoordinatorV2(c).effectiveOpenAt();
            if (open == 0 || open >= GATE_CLOSED_OPEN_AT) revert OpenOutOfRange(open);
            end = IBoxCoordinatorV2(c).deadline();
            if (end > _M40) revert OpenOutOfRange(end);
        }
        _w = (block.number << _O_DEPLOY) | (open << _O_OPEN) | (end << _O_DEADLINE);
        if (IBoxCoordinatorV2(c).roleAddress(BoxRolesV2.ROLE_ITEM_LEDGER) != address(0)) _w |= _B_ITEM_SOURCE;
        _saleFeesPending = 1;
    }
    /// @notice Coordinator only, once after its metadata gate opens; fixes the trading window and deadline.
    function setOpen(uint256 openAt_) external {
        if (msg.sender != _argAddress(A.COORDINATOR)) revert NotCoordinator(msg.sender);
        uint256 w = _initialised();
        if ((w >> _O_OPEN) & _M40 != GATE_CLOSED_OPEN_AT) revert OpenAlreadySet();
        if (openAt_ == 0 || openAt_ >= GATE_CLOSED_OPEN_AT) revert OpenOutOfRange(openAt_);
        uint256 deadline_ = IBoxCoordinatorV2(msg.sender).deadline();
        if (deadline_ > _M40) revert OpenOutOfRange(deadline_);
        w &= ~((_M40 << _O_OPEN) | (_M40 << _O_DEADLINE));
        _w = w | ((openAt_ & _M40) << _O_OPEN) | (deadline_ << _O_DEADLINE);
        emit OpenSet(openAt_);
    }

    /// @inheritdoc IBoxHookV2
    function launch() external { _forward(); }

    /// @inheritdoc IBoxHookV2
    function migrate(uint256) external returns (uint256, uint256, uint256, uint256) { _forward(); }

    /// @inheritdoc IBoxHookV2
    function deepen(address) external returns (ProtocolSkip, uint256, uint256, uint256) { _forward(); }

    /// @notice Coordinator only: close atomically on failure; later calls forward late P claims to its pot only.
    function close() external returns (uint256, uint256) { _forward(); }

    /// @inheritdoc IBoxHookV2
    function harvest() external returns (uint256, uint256, uint256) { _forward(); }

    /// @notice PoolManager only, during this hook's guarded unlock; delegates the requested accounting step.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(_pm) || !_insideGuardedCall()) revert NotPoolManager();
        (uint8 action,) = abi.decode(data, (uint8, bytes));
        if (action == _ACT_SELL_FEES) {
            (uint256 tIn, uint256 pOut) = _sellFees();
            return abi.encode(tIn, pOut);
        }
        _forward();
    }
    /// @inheritdoc IBoxHookV2
    function sellFees() external nonReentrant returns (ProtocolSkip skip, uint256 tIn, uint256 pOut, uint256 tip) {
        uint256 w = _initialised();
        _noForeignUnlock();
        if (w & _B_FAILED != 0) revert BoxFailed();
        if ((w >> _O_MIGRATED) & _M40 == 0) revert NotGraduated();
        if ((w >> _O_PROTOCOL) & _M40 == block.number) skip = ProtocolSkip.StepTaken;
        else {
            uint256 pending = _waitingT();
            if (pending == 0 || Bounds.tInQAtSqrt(pending, _slot0(PoolId.unwrap(poolId())).sqrtPriceX96()) < _argUint(A.STEP_MIN_Q, 16)) {
                skip = ProtocolSkip.BelowMinimum;
            }
        }
        if (skip != ProtocolSkip.None) return (skip, 0, 0, 0);
        _markProtocol();
        (tIn, pOut) = abi.decode(_pm.unlock(abi.encode(_ACT_SELL_FEES, bytes(""))), (uint256, uint256));
        tip = _tipOf(pOut);
        if (tip != 0 && !_tryUnlock(_ACT_TIP, abi.encode(msg.sender, tip), C.TIP_GAS)) tip = 0;
        uint256 net = pOut - tip;
        _pm.transfer(_argAddress(A.RECEIVER), uint160(_argAddress(A.Q)), net);
        _saleFeesPending += net;
        if (_hasBatches()) _tradeBatches[_batchId(false)].netP += net;
        emit FeesSold(poolId(), msg.sender, tIn, pOut, tip);
    }
    /// @dev Include unpoked position fees for the dust guard, without counting gifts or old burn claims.
    function _waitingT() private view returns (uint256) {
        PoolId id = poolId();
        (uint128 liquidity,, uint256 last) = StateLibrary.getPositionInfo(_pm, id, address(this), BoxSpecV1.MIN_USABLE_TICK, BoxSpecV1.MAX_USABLE_TICK, _SALT_PAIR);
        (, uint256 growth) = StateLibrary.getFeeGrowthInside(_pm, id, BoxSpecV1.MIN_USABLE_TICK, BoxSpecV1.MAX_USABLE_TICK);
        unchecked { growth -= last; }
        return _tFeesPending + FullMath.mulDiv(growth, liquidity, 1 << 128);
    }
    /// @dev Own guarded unlock: realize fees, sell only counted T, retain the remainder for the next block.
    function _sellFees() private returns (uint256 tIn, uint256 pOut) {
        Args memory a = _args(); PoolKey memory key = _key(a);
        uint256 fees = _poke(key, BoxSpecV1.MIN_USABLE_TICK, BoxSpecV1.MAX_USABLE_TICK, _SALT_PAIR);
        _distribute(a, fees, false); _buyersCheckpointed += fees;
        Slot0 spot = _slot0(PoolId.unwrap(poolId()));
        uint160 limit = Bounds.roomLimit(false, spot.sqrtPriceX96(), uint24(C.STEP_TICKS));
        (uint24 fee,) = Bounds.fees(spot, false);
        uint256 input = _tFeesPending;
        if (input > uint256(uint128(type(int128).max))) input = uint256(uint128(type(int128).max));
        uint256 protocolBefore = _pm.protocolFeesAccrued(key.currency1);
        BalanceDelta d = _pm.swap(key, SwapParams(false, -int256(input), limit), "");
        if (d.amount0() <= 0 || d.amount1() >= 0) revert InsufficientOutput();
        tIn = uint256(-int256(d.amount1())); pOut = uint256(int256(d.amount0()));
        if (tIn > input || pOut < Bounds.minOut(false, tIn, limit, fee)) revert InsufficientOutput();
        _accountPoolT(d.amount1());
        _poolTInventory -= _pm.protocolFeesAccrued(key.currency1) - protocolBefore;
        _tFeesPending -= tIn;
        _pm.burn(address(this), uint160(a.token), tIn);
        _pm.mint(address(this), uint160(a.q), pOut);
    }
    /// @notice PoolManager only; enforces trading gates and snapshots sale protocol fees.
    function beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (msg.sender != address(_pm)) revert NotPoolManager();
        uint256 w = _initialised();
        if (w & _B_FAILED != 0) revert BoxFailed();
        _checkKey(key);
        if (w & _B_LAUNCHED == 0) revert NotInitialised();
        bool migrated = (w >> _O_MIGRATED) & _M40 != 0;
        if (sender == _argAddress(A.RECEIVER)) {
            if (!params.zeroForOne) revert ReceiverCannotSell();
            if (!migrated) revert NotGraduated();
            if ((w >> _O_PROTOCOL) & _M40 == block.number) revert ProtocolStepTaken();
            _markProtocol();
        }
        if (!migrated) {
            uint256 shut = (w >> _O_CLOSED) & _M40;
            if (shut != 0) revert CurveIsClosed(shut);
            uint256 end = (w >> _O_DEADLINE) & _M40;
            if (end != 0 && block.timestamp >= end) revert FailurePending(end);
            uint256 open = (w >> _O_OPEN) & _M40;
            address router = _argAddress(A.ROUTER);
            if (block.timestamp < open) {
                if (sender != router || block.number != (w >> _O_DEPLOY) & _M40) revert TradingNotOpen(open);
            } else if (block.timestamp < open + WINDOW_SECONDS && params.zeroForOne && sender != router) {
                revert BuyThroughLaunchRouter(router, open + WINDOW_SECONDS);
            }
        }
        if (!params.zeroForOne) {
            // The manager updates its input-token protocol fees between these two callbacks.
            // Snapshot only this swap's change; other pools and prior collections share the counter.
            uint256 accrued = _pm.protocolFeesAccrued(key.currency1);
            bytes32 slot = _T_PROTOCOL_BEFORE;
            assembly ("memory-safe") { tstore(slot, accrued) }
        }
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }
    /// @notice PoolManager only; preserves curve floor/fill and reports input-currency fee units.
    function afterSwap(address sender, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        external returns (bytes4, int128)
    {
        if (msg.sender != address(_pm)) revert NotPoolManager();
        uint256 w = _initialised();
        if (w & _B_FAILED != 0) revert BoxFailed();
        _checkKey(key);
        _accountPoolT(delta.amount1());
        if (!params.zeroForOne) {
            uint256 beforeFees;
            bytes32 slot = _T_PROTOCOL_BEFORE;
            assembly ("memory-safe") { beforeFees := tload(slot) }
            // T protocol fees remain redeemable by the manager's controller. They never belong
            // to this pool's liquidity or its eventual irrecoverable inventory.
            _poolTInventory -= _pm.protocolFeesAccrued(key.currency1) - beforeFees;
        }
        (address p, address t, uint160 p1, uint160 p0) = _hotArgs();
        PoolId id = PoolId.wrap(_poolIdOf(p, t));
        if ((w >> _O_MIGRATED) & _M40 == 0) {
            uint160 price = _slot0(PoolId.unwrap(id)).sqrtPriceX96();
            if (price > p0) revert BelowCurveFloor(price);
            if (price <= p1 && (w >> _O_CLOSED) & _M40 == 0) {
                _w = w | (block.number << _O_CLOSED);
                _closedAt = uint64(block.timestamp);
                emit CurveClosed(id, block.number, price);
            }
        }
        if (params.zeroForOne) {
            uint256 input = uint256(-int256(delta.amount0()));
            // Finish mandatory fee writes before budgeting the optional notice. This moves
            // only P claims; T's snapshot still precedes the buyer's later token receipt.
            _checkpointFees(key, id, (w >> _O_MIGRATED) & _M40 == 0);
            _noticeTrade(sender, true, (input + 99) / 100);
            return (IHooks.afterSwap.selector, 0);
        }
        _noticeTrade(sender, false, (uint256(-int256(delta.amount1())) + 99) / 100);
        return (IHooks.afterSwap.selector, 0);
    }
    /// @dev PoolManager-only buy callback: collect before v4's int128 fee delta can overflow.
    /// A successful swap's gross P input fits int128, hence its 1% LP fee is at most
    /// ceil(2^127 / 100). Starting below half int128 leaves ample room for that next fee.
    /// T fees cannot exceed the fixed T issuance; donations are forbidden.
    /// Checkpoints mint the ordinary D6/receiver claims; harvest reports each once. No token calls.
    function _checkpointFees(PoolKey calldata key, PoolId id, bool curve) private {
        int24 lo = curve ? _argInt24(A.TICK_LOWER) : BoxSpecV1.MIN_USABLE_TICK;
        int24 hi = curve ? _argInt24(A.TICK_UPPER) : BoxSpecV1.MAX_USABLE_TICK;
        bytes32 salt = curve ? _SALT_CURVE : _SALT_PAIR;
        (uint128 liquidity, uint256 last,) = StateLibrary.getPositionInfo(_pm, id, address(this), lo, hi, salt);
        (uint256 growth,) = StateLibrary.getFeeGrowthInside(_pm, id, lo, hi);
        unchecked { growth -= last; } // v4 fee growth deliberately wraps.
        if (FullMath.mulDiv(growth, liquidity, 1 << 128) <= uint256(uint128(type(int128).max)) / 2) return;
        uint256 fees = _poke(key, lo, hi, salt);
        uint256 reserve = _distribute(_args(), fees, curve);
        _buyersCheckpointed += fees - reserve;
        _reserveCheckpointed += reserve;
    }
    /// @dev Internal callback authentication binds the fixed fee, currencies and hook address.
    function _checkKey(PoolKey calldata key) private view {
        if (Currency.unwrap(key.currency0) != _argAddress(A.Q) || Currency.unwrap(key.currency1) != _argAddress(A.TOKEN)
            || key.fee != POOL_FEE || key.tickSpacing != TICK_SPACING || address(key.hooks) != address(this)) revert UnknownPool();
    }

    /// @notice Refuses outside liquidity, initialization and donation; unused callbacks are never enabled.
    function beforeInitialize(address, PoolKey calldata, uint160) external view returns (bytes4) {
        if (msg.sender != address(_pm)) revert NotPoolManager();
        revert ForeignInitialize();
    }

    /// @notice Refuses outside liquidity, initialization and donation; unused callbacks are never enabled.
    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        returns (bytes4)
    {
        if (msg.sender != address(_pm)) revert NotPoolManager();
        revert LiquidityLocked();
    }

    /// @notice Refuses outside liquidity, initialization and donation; unused callbacks are never enabled.
    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        returns (bytes4)
    {
        if (msg.sender != address(_pm)) revert NotPoolManager();
        revert LiquidityLocked();
    }

    /// @notice Refuses outside liquidity, initialization and donation; unused callbacks are never enabled.
    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external view returns (bytes4) {
        if (msg.sender != address(_pm)) revert NotPoolManager();
        revert DonationsDisabled();
    }

    /// @notice Refuses outside liquidity, initialization and donation; unused callbacks are never enabled.
    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    /// @notice Refuses outside liquidity, initialization and donation; unused callbacks are never enabled.
    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    /// @notice Refuses outside liquidity, initialization and donation; unused callbacks are never enabled.
    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    /// @notice Refuses outside liquidity, initialization and donation; unused callbacks are never enabled.
    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    /// @inheritdoc IBoxHookV2
    function poolManager() external view returns (IPoolManager) {
        return _pm;
    }

    /// @inheritdoc IBoxHookV2
    function poolKey() external view returns (PoolKey memory) {
        return _key(_args());
    }

    /// @inheritdoc IBoxHookV2
    function poolId() public view returns (PoolId) {
        (address q_, address t_) = _argAddress2(A.Q);
        return PoolId.wrap(_poolIdOf(q_, t_));
    }

    /// @inheritdoc IBoxHookV2
    function kind() external view returns (BoxKind) {
        return BoxKind(_argUint(A.KIND, 1));
    }

    /// @inheritdoc IBoxHookV2
    function token() external view returns (address) {
        return _argAddress(A.TOKEN);
    }

    /// @inheritdoc IBoxHookV2
    function q() external view returns (address) {
        return _argAddress(A.Q);
    }

    /// @inheritdoc IBoxHookV2
    function coordinator() external view returns (address) {
        return _argAddress(A.COORDINATOR);
    }

    /// @inheritdoc IBoxHookV2
    function receiver() external view returns (address) {
        return _argAddress(A.RECEIVER);
    }

    /// @inheritdoc IBoxHookV2
    function launchRouter() external view returns (address) {
        return _argAddress(A.ROUTER);
    }

    /// @inheritdoc IBoxHookV2
    function raise() external view returns (uint256) {
        return _raise();
    }

    /// @inheritdoc IBoxHookV2
    function deployBlock() external view returns (uint256) {
        return (_w >> _O_DEPLOY) & _M40;
    }

    /// @inheritdoc IBoxHookV2
    function openAt() public view returns (uint256) {
        return (_w >> _O_OPEN) & _M40;
    }

    /// @inheritdoc IBoxHookV2
    function windowEndsAt() external view returns (uint256) {
        return openAt() + WINDOW_SECONDS;
    }

    /// @inheritdoc IBoxHookV2
    function closed() external view returns (bool) {
        return (_w >> _O_CLOSED) & _M40 != 0;
    }

    /// @inheritdoc IBoxHookV2
    function closedAtBlock() external view returns (uint256) {
        return (_w >> _O_CLOSED) & _M40;
    }

    /// @inheritdoc IBoxHookV2
    function migratedAtBlock() external view returns (uint256) {
        return (_w >> _O_MIGRATED) & _M40;
    }

    /// @inheritdoc IBoxHookV2
    function curve() external view returns (int24 tickLower, int24 tickUpper, uint128 liquidity) {
        tickLower = _argInt24(A.TICK_LOWER);
        tickUpper = _argInt24(A.TICK_UPPER);
        uint256 w = _w;
        if (w & _B_LAUNCHED != 0 && (w >> _O_MIGRATED) & _M40 == 0 && w & _B_FAILED == 0) {
            liquidity = _argUint128(A.LIQUIDITY);
        }
    }

    /// @inheritdoc IBoxHookV2
    function reserveCap() external view returns (uint256) {
        return _reserveCap();
    }

    /// @inheritdoc IBoxHookV2
    function reserveMinted() external view returns (uint256) {
        return _reserveMinted;
    }

    /// @inheritdoc IBoxHookV2
    function pairedLiquidity() external view returns (uint128) {
        return
            _positionLiquidity(
                PoolId.unwrap(poolId()), BoxSpecV1.MIN_USABLE_TICK, BoxSpecV1.MAX_USABLE_TICK, _SALT_PAIR
            );
    }

    /// @inheritdoc IBoxHookV2
    function deepenTipCap() external view returns (uint256) {
        return _tipMaxQ();
    }

    /// @inheritdoc IBoxHookV2
    function phase() external view returns (BoxPhase) {
        if (_w & _B_FAILED != 0) return BoxPhase.Failed;
        if ((_w >> _O_DEPLOY) & _M40 == 0) return BoxPhase.None;
        if ((_w >> _O_MIGRATED) & _M40 != 0) return BoxPhase.Graduated;
        if ((_w >> _O_CLOSED) & _M40 != 0) return BoxPhase.Closed;
        if (_w & _B_LAUNCHED == 0 || block.timestamp < openAt()) return BoxPhase.Upcoming;
        return block.timestamp < openAt() + WINDOW_SECONDS ? BoxPhase.Window : BoxPhase.Bonding;
    }
    /// @inheritdoc IBoxHookV2
    function failed() external view returns (bool) { return _w & _B_FAILED != 0; }
    /// @inheritdoc IBoxHookV2
    function closedTResidue() external view returns (uint256) { return _w & _B_FAILED != 0 ? _poolTInventory : 0; }
    /// @inheritdoc IBoxHookV2
    function closedAt() external view returns (uint256) { return _closedAt; }
    /// @inheritdoc IBoxHookV2
    function lastProtocolBlock() external view returns (uint256) { return (_w >> _O_PROTOCOL) & _M40; }
    /// @inheritdoc IBoxHookV2
    function saleFeesPending() external view returns (uint256) { return _saleFeesPending == 0 ? 0 : _saleFeesPending - 1; }
    /// @inheritdoc IBoxHookV2
    function tradeBatchTotalP() external view returns (uint256 total) {
        for (uint256 i = 1; i <= _batchId(false); ++i) total += _tradeBatches[i].netP;
    }
    function tradeBatchPendingT(uint256) external pure returns (uint256) { return 0; }
    function tFeesPending() external view returns (uint256) { return _tFeesPending; }
    /// @inheritdoc IBoxHookV2
    function depthBudget() external view returns (uint256) { return _depthBudget(); }
    /// @inheritdoc IBoxHookV2
    function holderLedger() external view returns (address) { return _holderLedger(); }
    /// @inheritdoc IBoxHookV2
    function currentTradeBatch(bool buy) external view returns (uint256) {
        return _hasBatches() ? _batchId(buy) : 0;
    }
    /// @inheritdoc IBoxHookV2
    function tradeBatch(uint256 id) external view returns (TradeBatchV2 memory) { return _tradeBatches[id]; }
    /// @dev Internal fixed-code delegation; propagates the extension's return or revert without interpretation.
    function _forward() private {
        address ext = extension;
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), ext, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }
}
