// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReceiverFixture, ReceiverBurnToken, ReceiverForeignUnlock} from "../cq11-b/ReceiverFixture.sol";
import {BoxReceiverV2} from "../../../src/box-v2/BoxReceiverV2.sol";
import {BoxReceiverV2Args} from "../../../src/box-v2/libraries/BoxReceiverV2Args.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";

// Red-first additive shape: the existing receiver interface stays source compatible.
interface PileReceiver {
    function moveToPile() external returns (uint256);
    function pilePendingP() external view returns (uint256);
    function pileMovedP() external view returns (uint256);
    event PileFeesMoved(address indexed pile, address indexed asset, uint256 amount, uint256 total);
}
contract PileReceiptDouble {
    address public immutable asset;
    uint8 public mode;
    address public receiver;
    constructor(address a) { asset = a; }
    function setMode(uint8 m) external { mode = m; }
    function wire(address r) external { receiver = r; }
    receive() external payable {
        require(mode != 1, "refuse");
        if (mode == 2) { assembly { for {} 1 {} {} } }
        if (mode == 3) { (bool ok,) = receiver.call(abi.encodeWithSignature("moveToPile()")); require(!ok, "reentered"); }
    }
}
contract PileTransferTest is ReceiverFixture {
    PileReceiptDouble internal pile;
    PileReceiver internal e;
    ReceiverBurnToken internal price;

    function _pileReceiver(address asset) internal {
        pile = new PileReceiptDouble(asset);
        vm.mockCall(address(coord), abi.encodeWithSignature("vault()"), abi.encode(address(pile)));
        bytes memory args = bytes.concat(BoxReceiverV2Args.encode(_args(9, 9, 1, asset)), bytes4(0), bytes20(address(pile)));
        r = BoxReceiverV2(BoxClones.create(BoxClones.initCode(address(implementation), args)));
        hook.wire(address(r)); coord.initialize(r); e = PileReceiver(address(r)); pile.wire(address(r));
    }
    function test_PF14_nativePendingThenMoved() public {
        _pileReceiver(address(0));
        _fees(1500, 3000); r.collect(address(0));
        assertEq(e.pilePendingP(), 3000);
        vm.expectRevert(IBoxReceiverV2.NotGraduated.selector); e.moveToPile();
        coord.graduation(r);
        uint256 before_ = address(pile).balance;
        vm.expectEmit(true, true, false, true);
        emit PileReceiver.PileFeesMoved(address(pile), address(0), 3000, 3000);
        assertEq(e.moveToPile(), 3000);
        assertEq(address(pile).balance - before_, 3000);
        assertEq(e.pileMovedP(), 3000); assertEq(e.pilePendingP(), 0);
        assertEq(e.moveToPile(), 0);
        assertEq(r.booked(address(0)), _balance(address(r)));
    }

    function test_PF12_refusalExhaustionAndReentryRestoreClaimsForRetry() public {
        _pileReceiver(address(0)); _fees(1500, 1500); r.collect(address(0)); coord.graduation(r);
        uint256 balance = _balance(address(r));
        for (uint8 mode = 1; mode <= 2; ++mode) {
            pile.setMode(mode); assertEq(e.moveToPile(), 0);
            assertEq(e.pilePendingP(), 2000); assertEq(e.pileMovedP(), 0);
            assertEq(_balance(address(r)), balance); assertEq(address(pile).balance, 0);
        }
        pile.setMode(3); assertEq(e.moveToPile(), 2000); assertEq(e.moveToPile(), 0);
    }
    function test_PF13_pausedAndShortERC20ReceiptRollBackForRetry() public {
        _pileReceiver(address(p)); _fees(1500, 1500); r.collect(address(0)); coord.graduation(r);
        uint256 balance = _balance(address(r));
        p.setPaused(true); assertEq(e.moveToPile(), 0); p.setPaused(false);
        p.setFeeBps(100); assertEq(e.moveToPile(), 0); p.setFeeBps(0);
        assertEq(e.pilePendingP(), 2000); assertEq(e.pileMovedP(), 0);
        assertEq(_balance(address(r)), balance); assertEq(p.balanceOf(address(pile)), 0);
        assertEq(e.moveToPile(), 2000); assertEq(p.balanceOf(address(pile)), 2000);
    }
    function test_PF15_failureRoutesPendingAndFinalFeesToPotAndLateMoneyToPot() public {
        _pileReceiver(address(0)); pile.setMode(2);
        _fees(1500, 1500); r.collect(address(0));
        _fees(1500, 0); coord.failure(r);
        assertEq(e.pilePendingP(), 0); assertEq(e.pileMovedP(), 0);
        assertEq(_balance(address(coord)), 3600);
        assertEq(r.fitOwed(), 600); assertEq(r.platformOwed(), 300);
        vm.expectRevert(IBoxReceiverV2.BoxFailed.selector); e.moveToPile();
        _fees(150, 0); r.collect(address(0)); assertEq(r.fitOwed(), 600);
        assertEq(_balance(address(coord)), 3750);
    }

    function test_PF16_lowGasAndForeignUnlockChangeNothing() public {
        _pileReceiver(address(0)); _fees(1500, 0); r.collect(address(0)); coord.graduation(r);
        (bool ok,) = address(e).call{gas: 100_000}(abi.encodeCall(PileReceiver.moveToPile, ()));
        assertFalse(ok); assertEq(e.pilePendingP(), 1000); assertEq(e.pileMovedP(), 0);
        ReceiverForeignUnlock foreign = new ReceiverForeignUnlock(pm);
        vm.expectRevert(IBoxReceiverV2.ForeignUnlock.selector);
        foreign.attempt(address(e), abi.encodeCall(PileReceiver.moveToPile, ()));
        assertEq(e.moveToPile(), 1000);
    }

    function test_PF17_oneGasAdmissionBoundaryRestoresFullCapExhaustion() public {
        _pileReceiver(address(0)); _fees(1500, 0); r.collect(address(0)); coord.graduation(r); pile.setMode(2);
        uint256 balance = _balance(address(r));
        uint256 low = 100_000; uint256 high = 6_000_000;
        while (high - low > 1) {
            uint256 mid = (low + high) / 2;
            if (_attempt(mid)) high = mid; else low = mid;
        }
        assertFalse(_attempt(high - 1)); assertTrue(_attempt(high));
        emit log_named_uint("one-gas pile activation", high);
        assertEq(e.pilePendingP(), 1000); assertEq(e.pileMovedP(), 0);
        assertEq(_balance(address(r)), balance); assertEq(r.booked(address(0)), balance);
        pile.setMode(0); assertEq(e.moveToPile(), 1000);
    }

    function test_PF18_pendingAboveInt128DrainsInBoundedParts() public {
        _pileReceiver(address(0));
        uint256 part = uint256(uint128(type(int128).max)) / 2;
        vm.deal(address(driver), 4 * part);
        for (uint256 i; i < 4; ++i) { _fees(part, 0); r.collect(address(0)); }
        uint256 pending = e.pilePendingP();
        uint256 maxPart = uint256(uint128(type(int128).max));
        assertGt(pending, maxPart); coord.graduation(r);
        uint256 before_ = address(pile).balance;
        assertEq(e.moveToPile(), maxPart);
        assertEq(e.moveToPile(), pending - maxPart);
        assertEq(e.moveToPile(), 0);
        assertEq(e.pilePendingP(), 0); assertEq(e.pileMovedP(), pending);
        assertEq(address(pile).balance - before_, pending);
        assertEq(_balance(address(hook)) + r.booked(address(0)) + pending, 4 * part);
    }

    function test_PF19_deficitReconciliationIncludesPendingWithoutInventingClaims() public {
        _pileReceiver(address(0)); _fees(4500, 0); r.collect(address(0));
        // Model a claims deficit; the moved claims remain visible in conservation.
        vm.prank(address(r)); pm.transfer(address(123), 0, 1500);
        r.collect(address(0));
        // FIT/platform debt stays senior: only the remaining 2,100 claims are shared.
        assertEq(r.fitOwed(), 600); assertEq(r.platformOwed(), 300);
        assertEq(e.pilePendingP(), 1750); assertEq(r.booked(address(0)), 3000);
        coord.graduation(r); assertEq(e.moveToPile(), 1750);
        assertEq(_balance(address(123)) + _balance(address(hook)) + r.booked(address(0)) + e.pileMovedP(), 4500);
    }

    function _attempt(uint256 allowance) private returns (bool ok) {
        vm.cool(address(r)); vm.cool(address(implementation)); vm.cool(address(coord));
        vm.cool(coordinatorCode); vm.cool(address(pile)); vm.cool(address(pm));
        vm.cool(vm.computeCreateAddress(address(implementation), 1));
        vm.cool(vm.computeCreateAddress(address(implementation), 2));
        (ok,) = address(e).call{gas: allowance}(abi.encodeCall(PileReceiver.moveToPile, ()));
    }

    function testFuzz_PF20_conservationBothSides(uint96 buyers, uint96 sellers, bool failed) public {
        _pileReceiver(address(0));
        buyers = uint96(bound(buyers, 0, 1e24)); sellers = uint96(bound(sellers, 0, 1e24));
        _fees(buyers, sellers); r.collect(address(0));
        uint256 total = uint256(buyers) + sellers;
        uint256 pending = e.pilePendingP();
        assertEq(r.booked(address(0)), total);
        if (failed) {
            coord.failure(r);
            assertEq(_balance(address(coord)) + r.fitOwed() + r.platformOwed(), total);
            assertEq(e.pilePendingP(), 0);
        } else {
            coord.graduation(r); assertEq(e.moveToPile(), pending);
            assertEq(_balance(address(hook)) + r.booked(address(0)) + e.pileMovedP(), total);
            assertEq(e.pilePendingP(), 0);
        }
    }
}
