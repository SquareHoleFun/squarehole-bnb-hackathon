// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MultipartPayoutGasTest} from "test/box-v2/payout-gas/Multipart.t.sol";

/// @notice Keeper entry proof with real receiver/PoolManager and the inherited arbitrary-supply P fixture.
/// Inherits cold activation, full-stipend exhaustion, rollback, independent debt and bounded-tail checks.
contract KeeperSafePayoutCallsTest is MultipartPayoutGasTest {
    uint256 private constant KEEPER_PAYOUT_GAS = 12_000_000;
    address private constant KEEPER = address(0x9988);

    /// @notice Any unrelated caller may trigger either immutable Safe; receives no P and cannot spend other debt.
    function test_keeperPaysBothSafesAndRetriesTheBoundedTail() public {
        uint256 fit = r.fitOwed();
        uint256 platform = r.platformOwed();
        uint256 backing = _balance(address(r));
        uint256 supply = p.totalSupply();
        vm.cool(address(r)); vm.cool(address(implementation)); vm.cool(address(pm));
        vm.cool(address(p)); vm.cool(FIT); vm.cool(PLATFORM);
        vm.prank(KEEPER);
        uint256 first = r.payFit{gas: KEEPER_PAYOUT_GAS}();
        assertGt(first, 0);
        assertLt(first, fit);
        assertEq(r.fitOwed(), fit - first);
        assertEq(r.platformOwed(), platform);
        vm.prank(KEEPER);
        assertEq(r.payPlatform{gas: KEEPER_PAYOUT_GAS}(), platform);
        vm.prank(KEEPER);
        assertEq(r.payFit{gas: KEEPER_PAYOUT_GAS}(), fit - first);
        assertEq(r.fitOwed(), 0);
        assertEq(r.platformOwed(), 0);
        assertEq(p.balanceOf(FIT), fit);
        assertEq(p.balanceOf(PLATFORM), platform);
        assertEq(p.balanceOf(KEEPER), 0);
        assertEq(_balance(address(r)), backing - fit - platform);
        assertEq(p.totalSupply(), supply);
        vm.prank(KEEPER);
        assertEq(r.payFit{gas: KEEPER_PAYOUT_GAS}(), 0);
        vm.prank(KEEPER);
        assertEq(r.payPlatform{gas: KEEPER_PAYOUT_GAS}(), 0);
    }
}
