// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Test-only M3 fixture copy, synchronized with F137 plain-hook accounting.

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {Slot0} from "v4-core/src/types/Slot0.sol";
import {IBoxToken} from "../../../../src/box/interfaces/IBoxToken.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {IBoxHookV2, ProtocolSkip} from "../../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {IBoxCoordinatorV2} from "../../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {BoxRolesV2} from "../../../../src/box-v2/interfaces/IBoxRegistryV2.sol";
import {ReleaseConstantsV2 as C} from "../../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";
import {BoxHookV2Args as A} from "../../../../src/box-v2/libraries/BoxHookV2Args.sol";
import {BoxLayoutV2} from "../../../../src/box-v2/libraries/BoxLayoutV2.sol";
import {BoxSwapBoundsV2 as Bounds} from "../../../../src/box-v2/libraries/BoxSwapBoundsV2.sol";
import {BoxHookV2BaseM332Double} from "./BoxHookV2BaseM332Double.sol";

/// @notice Fixed delegatecall half: launch, full-range migration, accounting, deepen and failure closure.
contract BoxHookV2ExtensionM332Double is BoxHookV2BaseM332Double {
    using PoolIdLibrary for PoolKey;
    error NotDelegated();
    address private immutable _self;
    struct Migration { uint256 q; uint256 t; uint256 pulled; uint256 dust; uint128 liquidity; }
    struct Depth { uint256 qIn; uint256 bought; uint256 qUsed; uint256 tUsed; uint128 liquidity; }
    uint256 private constant _MAX_DELTA = uint256(uint128(type(int128).max));
    constructor(IPoolManager pm) BoxHookV2BaseM332Double(pm) { _self = address(this); }
    modifier delegated() { if (address(this) == _self) revert NotDelegated(); _; }

    /// @notice Coordinator only through the hook, once; validate the curve and pull exactly its T principal.
    function launch() external delegated nonReentrant {
        uint256 w = _initialised();
        _onlyCoordinator(); _noForeignUnlock();
        if (w & _B_FAILED != 0) revert IBoxHookV2.BoxFailed();
        if (w & _B_LAUNCHED != 0) revert IBoxHookV2.AlreadyLaunched();
        Args memory a = _args();
        _checkCurve(a);
        _w = w | _B_LAUNCHED;
        PoolKey memory key = _key(a);
        _pm.initialize(key, a.sqrtP0);
        uint256 deposited = abi.decode(_pm.unlock(abi.encode(_ACT_LAUNCH, bytes(""))), (uint256));
        emit IBoxHookV2.PoolLaunched(key.toId(), a.tickLower, a.tickUpper, _argUint128(A.LIQUIDITY), a.sqrtP0, deposited);
    }
    /// @notice Coordinator only through the hook after fill; unused P is depth and unused T burns fail-safe.
    function migrate(uint256 tokenBudget) external delegated nonReentrant returns (uint256, uint256, uint256, uint256) {
        uint256 w = _initialised();
        _onlyCoordinator(); _noForeignUnlock();
        if (w & _B_FAILED != 0) revert IBoxHookV2.BoxFailed();
        if ((w >> _O_MIGRATED) & _M40 != 0) revert IBoxHookV2.AlreadyMigrated();
        if ((w >> _O_CLOSED) & _M40 == 0) revert IBoxHookV2.NotClosed();
        _w = w | (block.number << _O_MIGRATED);
        Migration memory m = abi.decode(_pm.unlock(abi.encode(_ACT_MIGRATE, abi.encode(tokenBudget))), (Migration));
        _closeTradeBatches();
        uint256 burned = _burnHeld();
        emit IBoxHookV2.MigratedV2(_id(), m.liquidity, m.dust, burned);
        return (m.q, m.t, m.pulled, m.dust);
    }
    /// @notice Receiver only through the hook; sale claims are already minted and are counted exactly once.
    function harvest() external delegated nonReentrant returns (uint256 buyers, uint256 sellers, uint256 reserve) {
        uint256 w = _initialised();
        if (msg.sender != _argAddress(A.RECEIVER)) revert IBoxHookV2.NotReceiver(msg.sender);
        _noForeignUnlock();
        sellers = uint256(_saleFeesPending) - 1;
        _saleFeesPending = 1;
        if (w & _B_FAILED == 0 && w & _B_LAUNCHED != 0) {
            (buyers, reserve) = abi.decode(_pm.unlock(abi.encode(_ACT_HARVEST, bytes(""))), (uint256, uint256));
        }
        _closeTradeBatches();
        emit IBoxHookV2.HarvestedV2(_id(), buyers, sellers, reserve);
    }
    /// @notice Coordinator only through the hook; first close splits fees before principal reaches the pot.
    /// After failure, forward late P claims only; never remove liquidity, burn T or repeat the failure event.
    function close() external delegated nonReentrant returns (uint256 pot, uint256 burned) {
        uint256 w = _initialised();
        _onlyCoordinator(); _noForeignUnlock();
        if (w & _B_FAILED != 0) return (_forwardPot(), 0);
        if ((w >> _O_MIGRATED) & _M40 != 0) revert IBoxHookV2.AlreadyMigrated();
        _w = w | _B_FAILED;
        pot = abi.decode(_pm.unlock(abi.encode(_ACT_CLOSE, bytes(""))), (uint256));
        _closeTradeBatches();
        burned = _burnHeld();
        emit IBoxHookV2.Closed(_id(), pot, burned);
    }
    /// @notice Anyone through the hook after graduation; pairs only this call's bought T and pays actual-work tip last.
    /// @dev Tips to this box's recorded parts or the PoolManager remain in the depth budget.
    function deepen(address tipTo) external delegated nonReentrant returns (ProtocolSkip skip, uint256 qUsed, uint256 tUsed, uint256 tip) {
        uint256 w = _initialised();
        _noForeignUnlock();
        if (w & _B_FAILED != 0) revert IBoxHookV2.BoxFailed();
        if ((w >> _O_MIGRATED) & _M40 == 0) revert NotGraduated();
        uint256 budget = _depthBudget();
        if ((w >> _O_PROTOCOL) & _M40 == block.number) skip = ProtocolSkip.StepTaken;
        else if (budget < _argUint(A.STEP_MIN_Q, 16) || budget == 0) skip = ProtocolSkip.BelowMinimum;
        if (skip != ProtocolSkip.None) {
            emit IBoxHookV2.DeepenSkipped(_id(), skip);
            return (skip, 0, 0, 0);
        }
        _markProtocol();
        Depth memory d = abi.decode(_pm.unlock(abi.encode(_ACT_DEEPEN, abi.encode(budget))), (Depth));
        uint256 remainder = d.bought - d.tUsed;
        if (remainder != 0) _tryUnlock(_ACT_BURN, abi.encode(remainder, remainder), C.BURN_GAS);
        tip = _tipOf(d.qIn + d.qUsed);
        if (tip != 0 && !_tryUnlock(_ACT_TIP, abi.encode(tipTo, tip), C.TIP_GAS)) tip = 0;
        emit IBoxHookV2.Deepened(_id(), d.liquidity, d.qUsed, d.tUsed, tip);
        return (ProtocolSkip.None, d.qUsed, d.tUsed, tip);
    }
    /// @notice PoolManager only in the hook's own guarded unlock. Action and payload originate in these entry points.
    function unlockCallback(bytes calldata data) external delegated returns (bytes memory) {
        if (msg.sender != address(_pm) || !_insideGuardedCall()) revert IBoxHookV2.NotPoolManager();
        (uint8 action, bytes memory arg) = abi.decode(data, (uint8, bytes));
        Args memory a = _args(); PoolKey memory key = _key(a);
        if (action == _ACT_LAUNCH) return abi.encode(_seed(a, key));
        if (action == _ACT_MIGRATE) return abi.encode(_migrate(a, key, abi.decode(arg, (uint256))));
        if (action == _ACT_HARVEST) {
            (uint256 fees, uint256 reserve) = _harvest(a, key);
            return abi.encode(fees - reserve, reserve);
        }
        if (action == _ACT_CLOSE) return abi.encode(_close(a, key));
        if (action == _ACT_DEEPEN) return abi.encode(_deepen(a, key, abi.decode(arg, (uint256))));
        if (action == _ACT_TIP) {
            (address to, uint256 amount) = abi.decode(arg, (address, uint256));
            if (to == address(0) || to == address(this) || to == address(_pm)) revert UnexpectedDelta();
            // The fixed tip stipend also bounds part reads; a refusal rolls back only this tip unlock.
            IBoxCoordinatorV2 coordinator = IBoxCoordinatorV2(_argAddress(A.COORDINATOR));
            for (uint256 role; role < BoxRolesV2.ROLE_COUNT; ++role) {
                if (to == coordinator.roleAddress(role)) revert UnexpectedDelta();
            }
            _pm.burn(address(this), uint256(uint160(a.q)), amount);
            _pm.take(key.currency0, to, amount);
            return "";
        }
        if (action == _ACT_BURN) {
            (uint256 claims, uint256 amount) = abi.decode(arg, (uint256, uint256));
            if (claims != 0) {
                _pm.burn(address(this), uint256(uint160(a.token)), claims);
                _pm.take(key.currency1, address(this), claims);
            }
            IBoxToken(a.token).burn(amount);
            return "";
        }
        revert UnexpectedDelta();
    }
    /// @dev Internal coordinator check; no token interaction.
    function _onlyCoordinator() private view {
        if (msg.sender != _argAddress(A.COORDINATOR)) revert IBoxHookV2.NotCoordinator(msg.sender);
    }
    /// @dev Internal pool id reader; no money moves.
    function _id() private view returns (PoolId) { return PoolId.wrap(_poolIdOf(_argAddress(A.Q), _argAddress(A.TOKEN))); }
    /// @dev Internal fail-safe burn: failed take/burn rolls the whole capped unlock back, preserving claims for H.
    function _burnHeld() private returns (uint256 amount) {
        address t = _argAddress(A.TOKEN);
        uint256 claims = _pm.balanceOf(address(this), uint256(uint160(t)));
        amount = claims + IBoxToken(t).balanceOf(address(this));
        if (amount != 0 && !_tryUnlock(_ACT_BURN, abi.encode(claims, amount), C.BURN_GAS)) amount = 0;
    }
    /// @dev Internal curve check uses the CQ9 small-raise centre without recomputing the bisection.
    function _checkCurve(Args memory a) private view {
        uint256 r = _raise(); uint128 l = _argUint128(A.LIQUIDITY);
        int24 centre = BoxLayoutV2.centreTick(r, false);
        int24 half = BoxSpecV1.CURVE_SPAN_TICKS / 2;
        if (r < 1e6 || a.tickLower != centre - half || a.tickUpper != centre + half ||
            a.sqrtP1 != TickMath.getSqrtPriceAtTick(a.tickLower) || a.sqrtP0 != TickMath.getSqrtPriceAtTick(a.tickUpper) || l == 0 ||
            SqrtPriceMath.getAmount0Delta(a.sqrtP1, a.sqrtP0, l, false) != r ||
            SqrtPriceMath.getAmount0Delta(a.sqrtP1, a.sqrtP0, l - 1, false) >= r) revert InvalidCurve();
    }
    /// @dev Internal launch settlement charges only the coordinator's T.
    function _seed(Args memory a, PoolKey memory key) private returns (uint256 amount) {
        (BalanceDelta d,) = _pm.modifyLiquidity(key, ModifyLiquidityParams(a.tickLower, a.tickUpper, int256(uint256(_argUint128(A.LIQUIDITY))), _SALT_CURVE), "");
        if (d.amount0() != 0 || d.amount1() >= 0) revert InvalidCurve();
        _accountPoolT(d.amount1());
        amount = uint256(-int256(d.amount1()));
        _pullToken(a.token, amount);
    }
    /// @dev Internal fee poke; failure closure calls this before removing any curve principal.
    function _harvest(Args memory a, PoolKey memory key) private returns (uint256 fees, uint256 reserve) {
        bool curveLive = (_w >> _O_MIGRATED) & _M40 == 0;
        fees = curveLive ? _poke(key, a.tickLower, a.tickUpper, _SALT_CURVE)
            : _poke(key, BoxSpecV1.MIN_USABLE_TICK, BoxSpecV1.MAX_USABLE_TICK, _SALT_PAIR);
        reserve = _distribute(a, fees, curveLive);
        fees += _buyersCheckpointed + _reserveCheckpointed;
        reserve += _reserveCheckpointed;
        _buyersCheckpointed = 0;
        _reserveCheckpointed = 0;
    }
    /// @dev Internal removal follows a fee poke, so the returned delta is curve principal only.
    function _removeCurve(Args memory a, PoolKey memory key) private returns (uint256 qOut, uint256 tOut) {
        uint256 left = _argUint128(A.LIQUIDITY);
        // The whole range contains at most raise + 1 P (rounded up), at any reachable spot.
        // T is bounded by ISSUANCE. Scale before narrowing: each BalanceDelta must fit int128,
        // although the sum of the removals and the unlock's transient delta may exceed it.
        uint256 chunk = _raise() < _MAX_DELTA ? left : FullMath.mulDiv(left, _MAX_DELTA, _raise() + 1);
        while (left != 0) {
            uint256 take = left < chunk ? left : chunk;
            (BalanceDelta d,) = _pm.modifyLiquidity(key,
                ModifyLiquidityParams(a.tickLower, a.tickUpper, -int256(take), _SALT_CURVE), "");
            if (d.amount0() < 0 || d.amount1() < 0) revert UnexpectedDelta();
            _accountPoolT(d.amount1());
            qOut += uint256(int256(d.amount0()));
            tOut += uint256(int256(d.amount1()));
            left -= take;
        }
    }
    /// @dev Internal migration removes all liquidity, walks without spending, then adds one salt-3 full-range position.
    function _migrate(Args memory a, PoolKey memory key, uint256 budget) private returns (Migration memory m) {
        uint256 fees = _poke(key, a.tickLower, a.tickUpper, _SALT_CURVE);
        _distribute(a, fees, true);
        _buyersCheckpointed = 0;
        _reserveCheckpointed = 0;
        (m.q, m.t) = _removeCurve(a, key);
        bytes32 id = PoolId.unwrap(key.toId());
        if (_activeLiquidity(id) != 0) revert MigrationNotNeutral();
        uint160 spot = _slot0(id).sqrtPriceX96();
        if (spot != a.sqrtP1) {
            BalanceDelta d = _pm.swap(key, SwapParams(spot > a.sqrtP1, -1, a.sqrtP1), "");
            if (BalanceDelta.unwrap(d) != 0 || _slot0(id).sqrtPriceX96() != a.sqrtP1) revert MigrationNotNeutral();
        }
        BoxLayoutV2.FullRange memory g = _addFullRange(key, a.sqrtP1, m.q, m.t + budget);
        m.liquidity = g.liquidity; m.dust = g.qDust;
        if (g.tAmount > m.t) { m.pulled = g.tAmount - m.t; _pullToken(a.token, m.pulled); }
        else if (m.t > g.tAmount) _pm.mint(address(this), uint256(uint160(a.token)), m.t - g.tAmount);
        if (g.qDust != 0) _pm.mint(address(this), uint256(uint160(a.q)), g.qDust);
    }
    /// @dev Internal bounded adds to the SAME salt-3 position. Recompute from remaining budgets after
    /// each rounded debit so splitting never overspends either currency. Caller pokes fees first.
    function _addFullRange(PoolKey memory key, uint160 spot, uint256 qMax, uint256 tMax)
        private returns (BoxLayoutV2.FullRange memory total)
    {
        BoxLayoutV2.Curve memory c; c.sqrtPriceEndX96 = spot;
        total.qDust = qMax; total.tDust = tMax;
        while (total.qDust != 0 && total.tDust != 0) {
            uint256 q = total.qDust < _MAX_DELTA ? total.qDust : _MAX_DELTA;
            uint256 t = total.tDust < _MAX_DELTA ? total.tDust : _MAX_DELTA;
            BoxLayoutV2.FullRange memory g = BoxLayoutV2.fullRange(c, q, t);
            if (g.liquidity == 0) break;
            (BalanceDelta d,) = _pm.modifyLiquidity(key,
                ModifyLiquidityParams(g.tickLower, g.tickUpper, int256(uint256(g.liquidity)), _SALT_PAIR), "");
            if (int256(d.amount0()) != -int256(g.qAmount) || int256(d.amount1()) != -int256(g.tAmount)) revert UnexpectedDelta();
            _accountPoolT(d.amount1());
            total.liquidity += g.liquidity;
            total.qAmount += g.qAmount; total.tAmount += g.tAmount;
            total.qDust -= g.qAmount; total.tDust -= g.tAmount;
            // At least one uncapped currency exhausted its representable liquidity; its dust stays dust.
            if (q == qMax && t == tMax) break;
            qMax = total.qDust; tMax = total.tDust;
        }
    }
    /// @dev Internal failure settlement: fees to their owners, all P principal/gifts to coordinator, T to burn claims.
    function _close(Args memory a, PoolKey memory key) private returns (uint256 pot) {
        if (_w & _B_LAUNCHED != 0) {
            _harvest(a, key);
            (uint256 qOut, uint256 tOut) = _removeCurve(a, key);
            while (qOut != 0) {
                uint256 amount = qOut < _MAX_DELTA ? qOut : _MAX_DELTA;
                _pm.mint(address(this), uint256(uint160(a.q)), amount);
                qOut -= amount;
            }
            if (tOut != 0) _pm.mint(address(this), uint256(uint160(a.token)), tOut);
        }
        return _forwardPot();
    }
    /// @dev Internal claims-only exit for initial principal and later gifts; the coordinator owns the fixed pot.
    function _forwardPot() private returns (uint256 pot) {
        pot = _depthBudget();
        if (pot != 0) _pm.transfer(_argAddress(A.COORDINATOR), uint256(uint160(_argAddress(A.Q))), pot);
    }
    /// @dev Internal self-buy at the fixed LP fee; only bought T funds the add, regardless of donated T claims.
    function _deepen(Args memory a, PoolKey memory key, uint256 budget) private returns (Depth memory d) {
        // Bound the whole step, including the paired add and its rounding headroom,
        // before the 49.75% split. A price limit alone cannot bound v4's raw deltas.
        // Unselected claims remain depth; the tip is still only on actual work.
        if (budget > _MAX_DELTA) budget = _MAX_DELTA;
        uint256 reserve = _tipOf(budget);
        uint256 spend = FullMath.mulDiv(budget - reserve, C.DEPTH_BUY_SHARE_BPS, C.BPS);
        Slot0 s = _slot0(PoolId.unwrap(key.toId()));
        uint160 limit = Bounds.roomLimit(true, s.sqrtPriceX96(), uint24(C.STEP_TICKS));
        (uint24 fee,) = Bounds.fees(s, true);
        BalanceDelta swap = _pm.swap(key, SwapParams(true, -int256(spend), limit), "");
        if (swap.amount0() >= 0 || swap.amount1() <= 0) revert InsufficientOutput();
        _accountPoolT(swap.amount1());
        d.qIn = uint256(-int256(swap.amount0())); d.bought = uint256(int256(swap.amount1()));
        if (_hasBatches()) _tradeBatches[_batchId(true)].protocolUnits += (d.qIn + 99) / 100;
        if (d.qIn > spend || d.bought < Bounds.minOut(true, d.qIn, limit, fee)) revert InsufficientOutput();
        _pm.burn(address(this), uint256(uint160(a.q)), d.qIn);
        _pm.mint(address(this), uint256(uint160(a.token)), d.bought);
        _addDepth(a, key, budget - spend - reserve, d);
    }
    /// @dev Internal add segregates accrued fees from principal before burning exactly the added claims.
    function _addDepth(Args memory a, PoolKey memory key, uint256 qMax, Depth memory d) private {
        BoxLayoutV2.Curve memory c; c.sqrtPriceEndX96 = _slot0(PoolId.unwrap(key.toId())).sqrtPriceX96();
        BoxLayoutV2.FullRange memory g = BoxLayoutV2.fullRange(c, qMax, d.bought);
        d.liquidity = g.liquidity; d.qUsed = g.qAmount; d.tUsed = g.tAmount;
        if (g.liquidity == 0) return;
        (BalanceDelta delta, BalanceDelta fees) = _pm.modifyLiquidity(key, ModifyLiquidityParams(g.tickLower, g.tickUpper, int256(uint256(g.liquidity)), _SALT_PAIR), "");
        if (int256(delta.amount0()) - fees.amount0() != -int256(g.qAmount) ||
            int256(delta.amount1()) - fees.amount1() != -int256(g.tAmount) || fees.amount1() < 0 || fees.amount0() < 0) revert UnexpectedDelta();
        _accountPoolT(delta.amount1());
        _mintTFees(key, fees.amount1(), true);
        _distribute(a, uint256(int256(fees.amount0())), false);
        _pm.burn(address(this), uint256(uint160(a.q)), g.qAmount);
        _pm.burn(address(this), uint256(uint160(a.token)), g.tAmount);
    }
}
