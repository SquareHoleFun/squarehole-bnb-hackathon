// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ClaimReserveFixture} from "./ClaimReserve.t.sol";

/// Isolate a newly activated tip: close the no-buyer hook and relocate its bootstrap claims
/// to a separate PM owner before either estimate or send. No money is created or destroyed.
/// Only inbox P changes after the search; the failure prefix otherwise runs unchanged.
contract ClaimReserveEmptyPotTest is ClaimReserveFixture {
    function test_nativeMenuNewTip() public { _tip(0, false, false); }
    function test_nativeItemsNewTip() public { _tip(0, true, false); }
    function test_erc20MenuNewTip() public { _tip(1, false, false); }
    function test_erc20ItemsNewTip() public { _tip(1, true, false); }
    function test_linkedMenuNewTip() public { _tip(2, false, false); }
    function test_linkedItemsNewTip() public { _tip(2, true, false); }

    function test_nativeMenuClosedNewTip() public { _tip(0, false, true); }
    function test_nativeItemsClosedNewTip() public { _tip(0, true, true); }
    function test_erc20MenuClosedNewTip() public { _tip(1, false, true); }
    function test_erc20ItemsClosedNewTip() public { _tip(1, true, true); }
    function test_linkedMenuClosedNewTip() public { _tip(2, false, true); }
    function test_linkedItemsClosedNewTip() public { _tip(2, true, true); }

    function _tip(uint256 pKind, bool items, bool closed) private {
        _prepare(pKind, items, closed ? Action.EmptyFailClosed : Action.EmptyFail, false);
        vm.prank(address(box)); hook.close();
        uint256 id = uint160(box.q());
        uint256 pot = pm.balanceOf(address(box), id);
        vm.prank(address(box)); pm.transfer(address(this), id, pot);
        uint256 minimum = _minimum();
        emit log_named_uint("zero pot empty inbox minimum", minimum);
        uint256 snap = vm.snapshotState();
        uint256 beforeP = _balance(caller);
        (bool ok, bytes memory ret,) = _send(minimum);
        if (!ok) _rethrow(ret);
        assertEq(_balance(caller), beforeP, "empty estimate pays no tip");
        (pot,) = box.claimState(); assertEq(pot, 0, "estimate pot is empty");
        for (uint256 i; i < 2; ++i) {
            assertTrue(vm.revertToState(snap));
            uint256 amount = i == 0 ? 1 : 1e15;
            _fund(box.royaltyRouter(), amount);
            (ok, ret,) = _send(minimum);
            if (!ok) _rethrow(ret);
            uint256 tip = hook.deepenTipCap();
            if (tip > amount) tip = amount;
            assertGt(tip, 0);
            assertEq(_balance(caller) - beforeP, tip, "inclusion activates the real tip");
            (pot,) = box.claimState(); assertEq(pot, amount - tip);
            assertEq(_inboxBalance(), 0);
        }
    }
}
