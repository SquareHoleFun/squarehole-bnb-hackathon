// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReceiverFixture, ReceiverBurnToken, ReceiverForeignUnlock} from "../cq11-b/ReceiverFixture.sol";
import {BoxReceiverV2} from "../../../src/box-v2/BoxReceiverV2.sol";
import {BoxReceiverV2Args} from "../../../src/box-v2/libraries/BoxReceiverV2Args.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";

// Red-first additive shape: the existing receiver interface stays source compatible.
interface EatReceiver {
    function eatPriceCoin() external returns (uint256);
    function eatPendingP() external view returns (uint256);
    function eatenP() external view returns (uint256);
    function priceBurnSelector() external view returns (bytes4);
    event PriceCoinEaten(address indexed asset, uint256 amount, uint256 total, bool burned);
}

contract EatTest is ReceiverFixture {
    address internal constant DEAD = address(0xdEaD);
    EatReceiver internal e;
    ReceiverBurnToken internal price;

    function _eatReceiver(address asset, bytes4 selector) internal {
        bytes memory args = bytes.concat(BoxReceiverV2Args.encode(_args(6, 6, 1, asset)), selector);
        r = BoxReceiverV2(BoxClones.create(BoxClones.initCode(address(implementation), args)));
        hook.wire(address(r));
        coord.initialize(r);
        e = EatReceiver(address(r));
    }

    function _burnable() internal {
        // Preserve sorted P/T while installing a mutable hostile burn double.
        vm.etch(address(0xEAA), address(t).code);
        price = ReceiverBurnToken(address(0xEAA));
        price.mint(address(driver), 1e30);
        _eatReceiver(address(price), bytes4(keccak256("burn(uint256)")));
    }

    function test_EAT01_nativeHeldUntilGraduationThenLockedAndCounted() public {
        _eatReceiver(address(0), bytes4(0));
        _fees(1500, 3000); r.collect(address(0));
        assertEq(e.eatPendingP(), 3000);
        vm.expectRevert(IBoxReceiverV2.NotGraduated.selector); e.eatPriceCoin();
        coord.graduation(r);
        uint256 before_ = DEAD.balance;
        vm.expectEmit(true, false, false, true);
        emit EatReceiver.PriceCoinEaten(address(0), 3000, 3000, false);
        assertEq(e.eatPriceCoin(), 3000);
        assertEq(DEAD.balance - before_, 3000);
        assertEq(e.eatenP(), 3000); assertEq(e.eatPendingP(), 0);
        assertEq(e.eatPriceCoin(), 0);
        assertEq(r.booked(address(0)), _balance(address(r)));
    }

    function test_EAT02_checkedBurnUsesExactSupplyAndLeavesNoLiquidP() public {
        _burnable(); _fees(1500, 0); r.collect(address(0)); coord.graduation(r);
        uint256 supply = price.totalSupply();
        assertEq(e.priceBurnSelector(), bytes4(keccak256("burn(uint256)")));
        assertEq(e.eatPriceCoin(), 1000);
        assertEq(price.totalSupply(), supply - 1000);
        assertEq(price.balanceOf(address(r)), 0); assertEq(price.balanceOf(DEAD), 0);
        assertEq(e.eatenP(), 1000);
    }

    function test_EAT03_uncheckedTokenLocksWithoutCallingBurn() public {
        _burnable(); price.mode(1);
        _eatReceiver(address(price), bytes4(0));
        _fees(0, 1500); r.collect(address(0)); coord.graduation(r);
        uint256 supply = price.totalSupply();
        assertEq(e.eatPriceCoin(), 1000);
        assertEq(price.totalSupply(), supply); assertEq(price.balanceOf(DEAD), 1000);
    }

    function test_EAT04_revertingLyingAndExhaustingBurnRestoreExactClaimsForRetry() public {
        _burnable(); _fees(1500, 1500); r.collect(address(0)); coord.graduation(r);
        uint256 balance = _balance(address(r)); uint256 supply = price.totalSupply();
        for (uint8 mode = 1; mode <= 3; ++mode) {
            price.mode(mode);
            assertEq(e.eatPriceCoin(), 0);
            assertEq(e.eatPendingP(), 2000); assertEq(e.eatenP(), 0);
            assertEq(_balance(address(r)), balance); assertEq(price.totalSupply(), supply);
            assertEq(price.balanceOf(address(r)), 0); assertEq(price.balanceOf(DEAD), 0);
            assertEq(r.booked(address(price)), balance);
        }
        price.mode(0); assertEq(e.eatPriceCoin(), 2000); assertEq(e.eatPriceCoin(), 0);
    }

    function test_EAT05_failureRoutesPendingAndFinalFeesToPotAndLateMoneyToPot() public {
        _burnable(); price.mode(3);
        _fees(1500, 1500); r.collect(address(0));
        _fees(1500, 0); coord.failure(r);
        assertEq(e.eatPendingP(), 0); assertEq(e.eatenP(), 0);
        assertEq(_balance(address(coord)), 3600);
        assertEq(r.fitOwed(), 600); assertEq(r.platformOwed(), 300);
        vm.expectRevert(IBoxReceiverV2.BoxFailed.selector); e.eatPriceCoin();
        _fees(150, 0); r.collect(address(0)); assertEq(r.fitOwed(), 600);
        assertEq(_balance(address(coord)), 3750);
    }

    function test_EAT06_lowGasAndForeignUnlockChangeNothing() public {
        _burnable(); _fees(1500, 0); r.collect(address(0)); coord.graduation(r);
        (bool ok,) = address(e).call{gas: 100_000}(abi.encodeCall(EatReceiver.eatPriceCoin, ()));
        assertFalse(ok); assertEq(e.eatPendingP(), 1000); assertEq(e.eatenP(), 0);
        ReceiverForeignUnlock foreign = new ReceiverForeignUnlock(pm);
        vm.expectRevert(IBoxReceiverV2.ForeignUnlock.selector);
        foreign.attempt(address(e), abi.encodeCall(EatReceiver.eatPriceCoin, ()));
        assertEq(e.eatPriceCoin(), 1000);
    }

    function test_EAT19_oneGasAdmissionBoundaryRestoresFullCapExhaustion() public {
        _burnable(); _fees(1500, 0); r.collect(address(0)); coord.graduation(r); price.mode(3);
        uint256 balance = _balance(address(r));
        uint256 low = 100_000; uint256 high = 6_000_000;
        while (high - low > 1) {
            uint256 mid = (low + high) / 2;
            if (_attempt(mid)) high = mid; else low = mid;
        }
        assertFalse(_attempt(high - 1)); assertTrue(_attempt(high));
        emit log_named_uint("one-gas eat activation", high);
        assertEq(e.eatPendingP(), 1000); assertEq(e.eatenP(), 0);
        assertEq(_balance(address(r)), balance); assertEq(r.booked(address(price)), balance);
        price.mode(0); assertEq(e.eatPriceCoin(), 1000);
    }

    function test_EAT25_pendingAboveInt128DrainsInBoundedParts() public {
        _eatReceiver(address(0), bytes4(0));
        uint256 part = uint256(uint128(type(int128).max)) / 2;
        vm.deal(address(driver), 4 * part);
        for (uint256 i; i < 4; ++i) { _fees(part, 0); r.collect(address(0)); }
        uint256 pending = e.eatPendingP();
        uint256 maxPart = uint256(uint128(type(int128).max));
        assertGt(pending, maxPart); coord.graduation(r);
        uint256 before_ = DEAD.balance;
        assertEq(e.eatPriceCoin(), maxPart);
        assertEq(e.eatPriceCoin(), pending - maxPart);
        assertEq(e.eatPriceCoin(), 0);
        assertEq(e.eatPendingP(), 0); assertEq(e.eatenP(), pending);
        assertEq(DEAD.balance - before_, pending);
        assertEq(_balance(address(hook)) + r.booked(address(0)) + pending, 4 * part);
    }

    function test_EAT26_deficitReconciliationIncludesPendingWithoutInventingClaims() public {
        _eatReceiver(address(0), bytes4(0)); _fees(4500, 0); r.collect(address(0));
        // Model a claims deficit; the moved claims remain visible in conservation.
        vm.prank(address(r)); pm.transfer(address(123), 0, 1500);
        r.collect(address(0));
        // FIT/platform debt stays senior: only the remaining 2,100 claims are shared.
        assertEq(r.fitOwed(), 600); assertEq(r.platformOwed(), 300);
        assertEq(e.eatPendingP(), 1750); assertEq(r.booked(address(0)), 3000);
        coord.graduation(r); assertEq(e.eatPriceCoin(), 1750);
        assertEq(_balance(address(123)) + _balance(address(hook)) + r.booked(address(0)) + e.eatenP(), 4500);
    }

    function _attempt(uint256 allowance) private returns (bool ok) {
        vm.cool(address(r)); vm.cool(address(implementation)); vm.cool(address(coord));
        vm.cool(coordinatorCode); vm.cool(address(price)); vm.cool(address(pm));
        vm.cool(vm.computeCreateAddress(address(implementation), 1));
        vm.cool(vm.computeCreateAddress(address(implementation), 2));
        (ok,) = address(e).call{gas: allowance}(abi.encodeCall(EatReceiver.eatPriceCoin, ()));
    }

    function testFuzz_EAT07_conservationBothSides(uint96 buyers, uint96 sellers, bool failed) public {
        _eatReceiver(address(0), bytes4(0));
        buyers = uint96(bound(buyers, 0, 1e24)); sellers = uint96(bound(sellers, 0, 1e24));
        _fees(buyers, sellers); r.collect(address(0));
        uint256 total = uint256(buyers) + sellers;
        uint256 pending = e.eatPendingP();
        assertEq(r.booked(address(0)), total);
        if (failed) {
            coord.failure(r);
            assertEq(_balance(address(coord)) + r.fitOwed() + r.platformOwed(), total);
            assertEq(e.eatPendingP(), 0);
        } else {
            coord.graduation(r); assertEq(e.eatPriceCoin(), pending);
            assertEq(_balance(address(hook)) + r.booked(address(0)) + e.eatenP(), total);
            assertEq(e.eatPendingP(), 0);
        }
    }
}
