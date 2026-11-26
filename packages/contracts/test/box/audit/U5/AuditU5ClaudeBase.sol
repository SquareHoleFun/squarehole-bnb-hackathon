// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {FitBuybackExecutor} from "../../../../src/box/FitBuybackExecutor.sol";
import {AuditPhases} from "../common/AuditPhases.sol";

/// @title AuditU5ClaudeBase
/// @notice TEST ONLY (SH-AUDIT-B0 U5, the Claude auditor). Reads of box 0's pool and of the two U5 contracts that do
/// not go through the code under review: the stream's value X rebuilt from StateLibrary (v4-core's own reader)
/// instead of the stream's packed `extsload`, the executor's oracle and its swap bounds rebuilt from TickMath, and
/// small drivers (price pushes, sampled blocks) on the shared world (`AuditPhases`, the factory's box 0 on the mainnet
/// build).
abstract contract AuditU5ClaudeBase is AuditPhases {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    uint256 internal constant Q128 = 1 << 128;
    bytes32 internal constant SALT_L7 = bytes32(uint256(1));
    bytes32 internal constant SALT_PAIR = bytes32(uint256(3));

    // ================================================================================================ the pool

    function _poolId() internal view returns (PoolId) {
        return poolKey.toId();
    }

    function _tick() internal view returns (int24 t) {
        (, t,,) = pm.getSlot0(_poolId());
    }

    function _sqrtPrice() internal view returns (uint160 p) {
        (p,,,) = pm.getSlot0(_poolId());
    }

    /// @notice One position of the hook's: its uncollected Q and T fees by v4's own formula (Position.update).
    function _positionFees(int24 lower, int24 upper, bytes32 salt) internal view returns (uint256 q, uint256 t) {
        PoolId id = _poolId();
        (uint128 l, uint256 last0, uint256 last1) = pm.getPositionInfo(id, a.hook, lower, upper, salt);
        if (l == 0) return (0, 0);
        (uint256 in0, uint256 in1) = pm.getFeeGrowthInside(id, lower, upper);
        unchecked {
            q = FullMath.mulDiv(in0 - last0, l, Q128);
            t = FullMath.mulDiv(in1 - last1, l, Q128);
        }
    }

    /// @notice U: what box 0's four positions earned and nobody collected (the ask, the bid, the sentinel, the pair).
    function _uncollected() internal view returns (uint256 q, uint256 t) {
        int24 lo = BoxSpecV1.MIN_USABLE_TICK;
        int24 hi = BoxSpecV1.MAX_USABLE_TICK;
        (uint256 q1, uint256 t1) = _positionFees(lo, curve.tickLower, SALT_L7);
        (uint256 q2, uint256 t2) = _positionFees(curve.tickLower, hi, SALT_L7);
        (uint256 q3, uint256 t3) = _positionFees(curve.tickUpper, hi, SALT_L7);
        (uint256 q4, uint256 t4) = _positionFees(lo, hi, SALT_PAIR);
        q = q1 + q2 + q3 + q4;
        t = t1 + t2 + t3 + t4;
    }

    /// @notice F: every T the stream ever received (its balance plus what it paid out and burned).
    function _streamF() internal view returns (uint256) {
        (uint256 claimed, uint256 burned) = stream.totals();
        return token.balanceOf(a.itemStream) + claimed + burned;
    }

    /// @notice R: the receiver's T claims (its next batch and carry, as box 0's receiver books no other T ledger
    /// once settled).
    function _receiverT() internal view returns (uint256) {
        return pm.balanceOf(a.receiver, uint256(uint160(a.token)));
    }

    /// @notice X rebuilt from StateLibrary: F + 13·⌊(U + R)/15⌋, the receiver's held curve-depth claims excluded
    /// before its settlement (IBoxItemStream's definition, BoxItemStream.sol:29-36).
    function _refX() internal view returns (uint256) {
        (, uint256 uT) = _uncollected();
        uint256 pending = uT + _receiverT();
        if (!receiver.graduationSettled()) pending -= receiver.streamCurveDepthT();
        return _streamF() + BoxSpecV1.BOX0_FEE_SHARE_T_BURN * (pending / BoxSpecV1.FEE_SHARE_DENOMINATOR);
    }

    /// @notice The T on its way to the stream: 13·⌊(U + R)/15⌋ (X − F).
    function _streamPending() internal view returns (uint256) {
        return _refX() - _streamF();
    }

    // ================================================================================================ the executor

    function _oracle() internal view returns (FitBuybackExecutor.Oracle memory) {
        return executor.oracle();
    }

    /// @notice The lowest √price `execute` may reach now (its `_floorSqrtPrice(max(sample, average))`), rebuilt.
    function _execFloor() internal view returns (uint160 floorSqrt, int24 referenceTick) {
        (, int24 avg,) = executor.twap();
        int24 sample = executor.latestSampleTick();
        referenceTick = sample > avg ? sample : avg;
        int24 t = referenceTick - BoxSpecV1.EXECUTOR_TWAP_BAND_TICKS;
        if (t < TickMath.MIN_TICK) t = TickMath.MIN_TICK;
        floorSqrt = TickMath.getSqrtPriceAtTick(t);
        if (floorSqrt < BoxSpecV1.EXECUTOR_MIN_SQRT_PRICE_X96) floorSqrt = BoxSpecV1.EXECUTOR_MIN_SQRT_PRICE_X96;
    }

    /// @notice `blocks` blocks of 12 s, each sampled by a `poke()` from the keeper.
    function _sampledBlocks(uint256 blocks) internal {
        for (uint256 i; i < blocks; ++i) {
            _advance(1);
            vm.prank(keeper);
            executor.poke();
        }
    }

    /// @notice Pushes the pool's price toward `target`'s √price with one swap by `who`, limited there: a buy (ETH in,
    /// up to 1,000 ETH, the rest refunded) lowers the tick, ETH being currency0; a sell of the T `who` holds raises
    /// it. Returns the tick reached.
    function _pushTo(address who, int24 target) internal returns (int24 reached) {
        uint160 limit = TickMath.getSqrtPriceAtTick(target);
        uint160 now_ = _sqrtPrice();
        if (limit < now_) {
            _buyTo(who, 1_000 ether, limit);
        } else if (limit > now_) {
            uint256 have = token.balanceOf(who);
            require(have != 0, "AuditU5ClaudeBase: the pusher holds no T");
            _swap(who, SwapParams({zeroForOne: false, amountSpecified: -int256(have), sqrtPriceLimitX96: limit}), 0);
        }
        reached = _tick();
    }
}
