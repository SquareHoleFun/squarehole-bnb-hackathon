// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {TransientReentrancyGuard} from "../../../src/libraries/TransientReentrancyGuard.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolDriver} from "./BoxV2TestBase.sol";
import {Test} from "forge-std/Test.sol";
import {HostileToken} from "./HostileToken.sol";

/// A guarded pull, as a converter or vault takes a token in.
contract KitGuardedPull is TransientReentrancyGuard {
    uint256 public pulls;

    function pull(HostileToken t, address from, uint256 amount) external nonReentrant {
        ++pulls;
        t.transferFrom(from, address(this), amount);
    }
}

/// @notice M1-03 part A: each switch of the hostile token makes its named transfer fail (ADR-0017 § 3's listing
/// checks and § 8's failures: a pause, an issuer's blocklist, a fee switched on, re-entry, an allowlist; decimals
/// 6-18).
contract HostileTokenTest is Test {
    address internal alice = address(101);
    address internal bob = address(102);
    address internal carol = address(103);
    address internal keeper = address(104);
    HostileToken internal t;

    function setUp() public {
        t = new HostileToken("Hostile", "HST", 18);
        t.mint(alice, 100e18);
    }

    function test_kit_switchesOffMoveExactly() public {
        vm.prank(alice);
        assertTrue(t.transfer(bob, 10e18));
        assertEq(t.balanceOf(bob), 10e18);
        vm.prank(alice);
        t.approve(carol, 5e18);
        vm.prank(carol);
        assertTrue(t.transferFrom(alice, bob, 5e18));
        assertEq(t.balanceOf(bob), 15e18);
        assertEq(t.balanceOf(alice), 85e18);
        assertEq(t.totalSupply(), 100e18);
    }

    function test_kit_pauseFailsTheTransfer() public {
        t.setPaused(true);
        vm.prank(alice);
        vm.expectRevert(HostileToken.Paused.selector);
        t.transfer(bob, 1);
        t.setPaused(false);
        vm.prank(alice);
        t.transfer(bob, 1);
        assertEq(t.balanceOf(bob), 1);
    }

    function test_kit_blocklistFailsTheTransferEachWay() public {
        t.mint(bob, 1e18);
        t.setBlocked(bob, true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HostileToken.Blocked.selector, bob));
        t.transfer(bob, 1);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(HostileToken.Blocked.selector, bob));
        t.transfer(alice, 1);
        // a blocked spender too (Circle's rule)
        vm.prank(alice);
        t.approve(carol, 1e18);
        t.setBlocked(carol, true);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(HostileToken.Blocked.selector, carol));
        t.transferFrom(alice, keeper, 1);
    }

    function test_kit_feeOnTransferFailsAnExactSettle() public {
        IPoolManager pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        PoolDriver lp = new PoolDriver(pm);
        PoolDriver seller = new PoolDriver(pm);
        PoolKey memory key = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(t)), 10_000, 60, IHooks(address(0)));
        pm.initialize(key, uint160(1 << 96));
        vm.deal(address(lp), 10 ether);
        t.mint(address(lp), 10e18);
        lp.modify(key, -887220, 887220, 1e18);
        t.setFeeBps(100);
        vm.prank(alice);
        t.transfer(bob, 100);
        assertEq(t.balanceOf(bob), 99, "the receiver is short by the fee");
        t.mint(address(seller), 1e18);
        vm.expectRevert(IPoolManager.CurrencyNotSettled.selector);
        seller.swap(key, false, 0.1e18, TickMath.MAX_SQRT_PRICE - 1);
    }

    function test_kit_reentryFailsAGuardedPull() public {
        KitGuardedPull g = new KitGuardedPull();
        vm.prank(alice);
        t.approve(address(g), type(uint256).max);
        t.armReentry(address(g), abi.encodeCall(KitGuardedPull.pull, (t, alice, 1)));
        vm.expectRevert(TransientReentrancyGuard.Reentrancy.selector);
        g.pull(t, alice, 1);
        // a failed re-entry fails the transfer, and its disarm rolls back with it: the token stays armed, as a
        // persistent hostile token would
        assertEq(t.reenterTarget(), address(g), "still armed");
        vm.expectRevert(TransientReentrancyGuard.Reentrancy.selector);
        g.pull(t, alice, 1);
        // only the test disarms it; the next pull then runs plainly
        t.armReentry(address(0), "");
        g.pull(t, alice, 1);
        assertEq(g.pulls(), 1);
        assertEq(t.balanceOf(address(g)), 1);
    }

    function test_kit_reentryRunsOnceIntoAnUnguardedTarget() public {
        KitGuardedPull g = new KitGuardedPull();
        vm.prank(bob);
        t.approve(address(g), type(uint256).max);
        t.mint(bob, 1);
        t.armReentry(address(g), abi.encodeCall(KitGuardedPull.pull, (t, bob, 1)));
        vm.prank(alice);
        t.transfer(carol, 1);
        assertEq(g.pulls(), 1, "the transfer re-entered once");
        assertEq(t.reenterTarget(), address(0), "and disarmed");
    }

    function test_kit_allowlistOnlyFailsATransferToAWalletNotAllowed() public {
        t.setAllowlistOnly(true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HostileToken.NotAllowed.selector, alice));
        t.transfer(bob, 1);
        t.setAllowed(alice, true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(HostileToken.NotAllowed.selector, bob));
        t.transfer(bob, 1);
        t.setAllowed(bob, true);
        vm.prank(alice);
        t.transfer(bob, 1);
        assertEq(t.balanceOf(bob), 1);
    }

    function test_kit_decimalsSixToEighteenAndTheRefusedOnes() public {
        for (uint8 d = 6; d <= 18; ++d) {
            assertEq(new HostileToken("D", "D", d).decimals(), d);
        }
        t.setDecimals(5);
        assertEq(t.decimals(), 5, "under the listing's range");
        t.setDecimals(19);
        assertEq(t.decimals(), 19, "over it");
    }

    function test_kit_feeOverAWholeIsRefused() public {
        vm.expectRevert(abi.encodeWithSelector(HostileToken.FeeTooHigh.selector, 10_001));
        t.setFeeBps(10_001);
    }
}
