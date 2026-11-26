// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M132aBase} from "./M132aBase.sol";
import {BoxFactoryV2} from "../../../src/box-v2/BoxFactoryV2.sol";
import {BoxFactoryV2Planner} from "../../../src/box-v2/BoxFactoryV2Planner.sol";

contract M132aReleaseWiringTest is M132aBase {
    function _prepare() internal returns (BoxFactoryV2Planner.Release memory r) {
        r = release;
        address next = vm.computeCreateAddress(DEPLOYER, vm.getNonce(DEPLOYER));
        vm.mockCall(r.implementations[0], abi.encodeWithSignature("factory()"), abi.encode(next));
        vm.mockCall(r.registry, abi.encodeWithSignature("factory()"), abi.encode(next));
    }

    function _refuse(BoxFactoryV2Planner.Release memory r, bytes memory reason, address checker) internal {
        vm.expectRevert(reason);
        vm.prank(DEPLOYER);
        new BoxFactoryV2(r, address(planner), checker);
    }

    function test_retiredImplementationSlotRefused() public {
        BoxFactoryV2Planner.Release memory r = _prepare();
        r.implementations[9] = r.implementations[1];
        _refuse(r, abi.encodeWithSelector(BoxFactoryV2.BadPreviewRelease.selector), address(factory.checks()));
    }

    function test_coordinatorFromAnotherManagerRefused() public {
        BoxFactoryV2Planner.Release memory r = _prepare();
        vm.mockCall(r.implementations[0], abi.encodeWithSignature("poolManager()"), abi.encode(address(0xBAD)));
        _refuse(r, abi.encodeWithSelector(BoxFactoryV2.ReleaseMiswired.selector, 1), address(factory.checks()));
    }

    function test_partFromAnotherCoordinatorRefused() public {
        BoxFactoryV2Planner.Release memory r = _prepare();
        vm.mockCall(
            r.implementations[1], abi.encodeWithSignature("coordinatorImplementation()"), abi.encode(address(0xBAD))
        );
        _refuse(r, abi.encodeWithSelector(BoxFactoryV2.ImplementationMiswired.selector, 1), address(factory.checks()));
    }

    function test_wrongCheckerCodeCannotEnterCommitment() public {
        BoxFactoryV2Planner.Release memory r = _prepare();
        _refuse(r, abi.encodeWithSelector(BoxFactoryV2.BadPreviewRelease.selector), address(planner));
    }

    function test_receiverFromAnotherCoordinatorRefused() public {
        BoxFactoryV2Planner.Release memory r = _prepare();
        vm.mockCall(
            r.implementations[5], abi.encodeWithSignature("coordinatorImplementation()"), abi.encode(address(0xBAD))
        );
        _refuse(r, abi.encodeWithSelector(BoxFactoryV2.ImplementationMiswired.selector, 5), address(factory.checks()));
    }
}
