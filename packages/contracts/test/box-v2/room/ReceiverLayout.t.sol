// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ReceiverDeploy} from "../fee-modules/ReceiverDeploy.sol";

import {ReceiverFixture} from "../cq11-b/ReceiverFixture.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {BoxReceiverV2} from "../../../src/box-v2/BoxReceiverV2.sol";

/// An unrelated delegate host can forge transient state, but is not this release's receiver clone.
contract ForeignReceiverDelegate {
    function invoke(address part, bytes calldata data) external returns (bytes memory) {
        bytes32 slot = keccak256("squarehole.receiver.v2.unlock");
        assembly ("memory-safe") { tstore(slot, 1) }
        (bool ok, bytes memory result) = part.delegatecall(data);
        if (!ok) assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
        return result;
    }
}

/// SH-V21-00-ROOM: pinned runtime room and bidirectional fixed-code authentication.
contract ReceiverLayoutTest is ReceiverFixture {
    function _part() private view returns (address part) {
        // Separately deployed release code is immutable in the implementation.
        (,part,) = implementation.receiverCode();
        assertGt(part.code.length, 0, "receiver constructs its fixed callback part");
    }

    function _callback() private pure returns (bytes memory) {
        return abi.encodeCall(IUnlockCallback.unlockCallback, (abi.encode(uint256(1), address(0), address(1), uint256(0))));
    }

    function test_receiverHasRoom() public view {
        assertLe(address(implementation).code.length, 22_118, "SH-V21-02 consumes the reserved receiver room");
    }

    function test_everyReceiverPartFits() public view {
        assertLe(_part().code.length, 22_118);
        (address views,,) = implementation.receiverCode();
        assertGt(views.code.length, 0);
        assertLe(views.code.length, 22_118);
    }

    function test_partRejectsDirectPoolManagerCall() public {
        address part = _part();
        vm.prank(address(pm));
        (bool ok,) = part.call(_callback());
        assertFalse(ok, "part is not a receiver");
    }

    function test_partRejectsForeignDelegateEvenWithArmedState() public {
        address part = _part();
        ForeignReceiverDelegate host = new ForeignReceiverDelegate();
        vm.expectRevert();
        vm.prank(address(pm));
        host.invoke(part, _callback());
    }

    function test_partRejectsCloneOfItself() public {
        address clone = BoxClones.create(BoxClones.initCode(_part(), ""));
        vm.prank(address(pm));
        (bool ok,) = clone.call(_callback());
        assertFalse(ok);
    }

    function test_receiverRetainsCallerAndArmingRefusals() public {
        vm.expectRevert(bytes("ReceiverOnlyPoolManager"));
        r.unlockCallback(abi.encode(uint256(1), address(p), FIT, uint256(1)));
        vm.expectRevert(bytes("ReceiverUnarmedUnlock"));
        vm.prank(address(pm));
        r.unlockCallback(abi.encode(uint256(1), address(p), FIT, uint256(1)));
    }

    function test_receiverUsesOnlyItsOwnPartAndRetryPreservesDebt() public {
        address part = _part();
        _fees(1500, 0);
        r.collect(address(0));
        uint256 owed = r.fitOwed();
        vm.mockCallRevert(part, abi.encodePacked(IUnlockCallback.unlockCallback.selector), "part unavailable");
        assertEq(r.payFit(), 0);
        assertEq(r.fitOwed(), owed);
        vm.clearMockedCalls();
        assertEq(r.payFit(), owed);
        assertEq(r.fitOwed(), 0);
        assertEq(p.balanceOf(FIT), owed);
    }

    function test_anotherReceiversPartCannotExecuteForThisClone() public {
        address part = _part();
        BoxReceiverV2 other = BoxReceiverV2(deployCode("BoxReceiverV2.sol:BoxReceiverV2",
            ReceiverDeploy.args(pm, coordinatorCode, FIT, PLATFORM)));
        (,address otherPart,) = other.receiverCode();
        _fees(1500, 0);
        r.collect(address(0));
        uint256 owed = r.fitOwed();
        bytes memory original = part.code;
        vm.etch(part, otherPart.code);
        assertEq(r.payFit(), 0, "wrong release part refuses delegation");
        assertEq(r.fitOwed(), owed);
        assertEq(p.balanceOf(FIT), 0);
        vm.etch(part, original);
        assertEq(r.payFit(), owed);
    }
}
