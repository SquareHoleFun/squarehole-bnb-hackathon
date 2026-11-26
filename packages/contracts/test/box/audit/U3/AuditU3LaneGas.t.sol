// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import "./AuditU3LaneBase.sol";
import {NativeLiquidityHelper} from "../../../v2/utils/NativeV4Callers.sol";
import {S0StateDiff} from "../../../spikes/S0StateDiff.sol";

/// @notice BC-018: cold real swaps and rejected attempts, using each fork's execution schedule.
/// The +14,123 bound applies to ordinary graduated swaps; other phases are recorded separately.
/// Baseline: same real T and exact L7 liquidity at the same price, in a hookless pool on the same PoolManager.
contract AuditU3LaneGas is AuditU3LaneBase {
    using StateLibrary for IPoolManager;
    uint256 internal constant BC018 = 14_123;

    function testProperty_AUDIT_U3_swapGasCancun() public {
        _gas("cancun");
    }

    function testProperty_AUDIT_U3_swapGasOsaka() public {
        _gas("osaka");
    }

    function testProperty_AUDIT_U3_swapGasAmsterdam() public {
        _gas("amsterdam");
    }

    function _gas(string memory fork) internal {
        vm.setEvmVersion(fork);
        vm.deal(trader, 100 ether);
        _attempt(fork, "upcoming rejected", false);
        vm.warp(hook.openAt());
        vm.roll(block.number + 300);
        _cool();
        vm.prank(trader);
        BoxLaunchRouter(payable(a.launchRouter)).buy{value: 0.1 ether}(0.1 ether, 0, trader, block.timestamp);
        emit log_named_uint(string.concat(fork, " window router buy"), vm.lastFrameGas().gasTotalUsed);
        _attempt(fork, "window direct rejected", false);
        _bonding();
        _attempt(fork, "bonding buy", true);
        kit.buy(trader, 10 ether, curve.sqrtPriceLowerX96);
        _attempt(fork, "closed rejected", false);
        coord.graduate();
        PoolKey memory baseline = _baseline();
        _warm(key);
        _warm(baseline);
        (uint160 left,,,) = pm.getSlot0(key.toId());
        (uint160 right,,,) = pm.getSlot0(baseline.toId());
        assertEq(left, right, "same layout/price");
        for (uint256 side; side < 2; ++side) {
            uint256 baseGas = _ordinary(baseline, side == 0);
            uint256 hookGas = _ordinary(key, side == 0);
            assertGe(hookGas, baseGas);
            assertLe(hookGas - baseGas, BC018);
            string memory label = string.concat(fork, side == 0 ? " graduated buy" : " graduated sell");
            emit log_named_uint(label, hookGas);
            emit log_named_uint(string.concat(label, " extra"), hookGas - baseGas);
        }
    }

    function _attempt(string memory fork, string memory phase, bool expected) internal {
        _cool();
        vm.prank(trader);
        (bool ok,) = address(swapper).call{value: 0.01 ether}(abi.encodeCall(swapper.swap, (key, true, -0.01 ether, 0)));
        uint256 gasUsed = vm.lastFrameGas().gasTotalUsed;
        assertEq(ok, expected);
        emit log_named_uint(string.concat(fork, " ", phase), gasUsed);
    }

    function _baseline() internal returns (PoolKey memory k) {
        k = PoolKey(key.currency0, key.currency1, 10_000, 60, IHooks(address(0)));
        pm.initialize(k, curve.sqrtPriceLowerX96);
        NativeLiquidityHelper lp = new NativeLiquidityHelper(pm);
        vm.prank(trader);
        token.transfer(address(this), 220_000_000e18);
        token.approve(address(lp), type(uint256).max);
        (uint128 ask, uint128 bid, uint128 sentinel) = hook.graduatedLayout();
        lp.modify{value: 10 ether}(k, curve.tickLower, BoxSpecV1.MAX_USABLE_TICK, int256(uint256(bid)));
        lp.modify{value: 5 ether}(k, curve.tickUpper, BoxSpecV1.MAX_USABLE_TICK, int256(uint256(sentinel)));
        lp.modify(k, BoxSpecV1.MIN_USABLE_TICK, curve.tickLower, int256(uint256(ask)));
    }

    function _warm(PoolKey memory k) internal {
        vm.prank(trader);
        swapper.swap{value: 0.3 ether}(k, true, -0.3 ether, 0);
        vm.prank(trader);
        swapper.swap(k, false, -1_000_000e18, 0);
        vm.prank(trader);
        swapper.swap{value: 0.05 ether}(k, true, -0.05 ether, 0);
    }

    function _ordinary(PoolKey memory k, bool buy) internal returns (uint256 gasUsed) {
        _cool();
        vm.startStateDiffRecording();
        vm.prank(trader);
        swapper.swap{value: buy ? 0.01 ether : 0}(k, buy, buy ? -0.01 ether : -int256(100_000e18), 0);
        gasUsed = vm.lastFrameGas().gasTotalUsed;
        S0StateDiff.Counts memory changes = S0StateDiff.count(vm.stopAndReturnStateDiff());
        assertEq(changes.newSlots, 0, "lastFrameGas excludes Amsterdam state gas: assert none");
        assertEq(changes.accounts, 0);
    }

    function _cool() internal {
        vm.cool(address(pm));
        vm.cool(address(swapper));
        vm.cool(a.token);
        vm.cool(a.hook);
        vm.cool(impls.hook);
        vm.cool(impls.hookExtension);
        vm.cool(trader);
        vm.cool(a.launchRouter);
        vm.cool(impls.launchRouter);
        vm.cool(address(this));
    }
}
