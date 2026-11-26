// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReceiverFixture, ReceiverCoordinator} from "../cq11-b/ReceiverFixture.sol";
import {BoxReceiverV2} from "../../../src/box-v2/BoxReceiverV2.sol";
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {BoxReceiverV2Args, ReceiverArgs} from "../../../src/box-v2/libraries/BoxReceiverV2Args.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";

/// @notice SH-V2-INT-FIX2 / Fable 5: clone arguments alone confer no release authority.
contract ReceiverInitializationTest is ReceiverFixture {
    function test_implementationIsLocked() public {
        address recorded = implementation.coordinator();
        vm.expectRevert(IBoxReceiverV2.AlreadyInitialised.selector);
        vm.prank(recorded);
        implementation.initialize();
    }

    function test_recordedEoaCannotInitialize() public {
        address outsider = address(0xBAD);
        ReceiverArgs memory a = _args(1, 1, 1, address(p));
        a.coordinator = outsider;
        r = _clone(a);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiverV2.NotCoordinator.selector, outsider));
        vm.prank(outsider);
        r.initialize();
        assertEq(r.creatorPayee(), address(0));
    }

    function test_recordedStandaloneCoordinatorCannotInitialize() public {
        ReceiverCoordinator outsider = new ReceiverCoordinator();
        _refuseCoordinator(outsider);
    }

    function test_coordinatorCloneFromAnotherReleaseCannotInitialize() public {
        address other = address(new ReceiverCoordinator());
        ReceiverCoordinator outsider = ReceiverCoordinator(BoxClones.create(BoxClones.initCode(other, "")));
        _refuseCoordinator(outsider);
    }

    function _refuseCoordinator(ReceiverCoordinator outsider) private {
        ReceiverArgs memory a = _args(1, 1, 1, address(p));
        a.coordinator = address(outsider);
        r = _clone(a);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiverV2.NotCoordinator.selector, address(outsider)));
        outsider.initialize(r);
        assertEq(r.creatorPayee(), address(0));
    }

    function test_indirectReceiverProxyCannotInitialize() public {
        address middle = BoxClones.create(BoxClones.initCode(address(implementation), ""));
        bytes memory args = BoxReceiverV2Args.encode(_args(1, 1, 1, address(p)));
        r = BoxReceiverV2(BoxClones.create(BoxClones.initCode(middle, args)));
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiverV2.NotCoordinator.selector, address(coord)));
        coord.initialize(r);
        assertEq(r.creatorPayee(), address(0));
    }

    function test_releaseCloneInitializesOnceAndPaysItsRecordedSafes() public {
        assertEq(r.coordinator(), address(coord));
        assertEq(r.creatorPayee(), PAYEE);
        vm.expectRevert(IBoxReceiverV2.AlreadyInitialised.selector);
        coord.initialize(r);
        _fees(150, 0);
        r.collect(address(0));
        assertEq(r.payFit(), 20);
        assertEq(r.payPlatform(), 10);
        assertEq(p.balanceOf(FIT), 20);
        assertEq(p.balanceOf(PLATFORM), 10);
        assertEq(r.booked(address(p)), 120);
    }
}
