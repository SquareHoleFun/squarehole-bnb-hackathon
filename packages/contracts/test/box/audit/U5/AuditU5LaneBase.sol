// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {BoxItemStreamGasBase} from "../../s8/BoxItemStreamGasBase.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxHook} from "../../../../src/box/BoxHook.sol";
import {BoxReceiver} from "../../../../src/box/BoxReceiver.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {FitBuybackExecutor} from "../../../../src/box/FitBuybackExecutor.sol";

/// @notice Factory box 0, mainnet build. The inherited fixture uses committed drand vectors, no RPC.
abstract contract AuditU5LaneBase is BoxItemStreamGasBase {
    using StateLibrary for IPoolManager;

    function _executor() internal view returns (FitBuybackExecutor) {
        return FitBuybackExecutor(payable(a.executor));
    }

    function _graduateReady() internal {
        b.toClosed();
        BoxCoordinator(a.coordinator).graduate();
        vm.warp(block.timestamp + 3601);
        vm.roll(block.number + 301);
        _executor().poke();
        (bool ready,,) = _executor().twap();
        assertTrue(ready);
    }

    function _fund(uint256 amount) internal {
        vm.deal(address(this), amount);
        _executor().fundBudget{value: amount}();
    }

    /// Independent StateLibrary reconstruction of X (including the receiver's unbatched claims).
    function _referenceValue() internal view returns (uint256) {
        IPoolManager pm = IPoolManager(a.poolManager);
        PoolId id = BoxHook(a.hook).poolId();
        uint256 pending = pm.balanceOf(a.receiver, uint256(uint160(a.token)));
        int24 mn = BoxSpecV1.MIN_USABLE_TICK;
        int24 mx = BoxSpecV1.MAX_USABLE_TICK;
        pending += _positionOwed(pm, id, mn, b.curve().tickLower, bytes32(uint256(1)));
        pending += _positionOwed(pm, id, b.curve().tickLower, mx, bytes32(uint256(1)));
        pending += _positionOwed(pm, id, b.curve().tickUpper, mx, bytes32(uint256(1)));
        pending += _positionOwed(pm, id, mn, mx, bytes32(uint256(3)));
        if (!BoxReceiver(payable(a.receiver)).graduationSettled()) {
            pending -= BoxReceiver(payable(a.receiver)).streamCurveDepthT();
        }
        (uint256 paid, uint256 burned) = st.totals();
        return BoxToken(a.token).balanceOf(a.itemStream) + paid + burned + 13 * (pending / 15);
    }

    function _positionOwed(IPoolManager pm, PoolId id, int24 lo, int24 hi, bytes32 salt)
        private
        view
        returns (uint256)
    {
        (uint128 l,, uint256 last) = pm.getPositionInfo(id, a.hook, lo, hi, salt);
        if (l == 0) return 0;
        (, uint256 growth) = pm.getFeeGrowthInside(id, lo, hi);
        unchecked {
            return FullMath.mulDiv(growth - last, l, 1 << 128);
        }
    }
}
