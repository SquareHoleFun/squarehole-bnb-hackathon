// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {ReceiverDeploy} from "../fee-modules/ReceiverDeploy.sol";

import {BoxReceiverV2} from "../../../src/box-v2/BoxReceiverV2.sol";
import {Test} from "forge-std/Test.sol";

/// @notice SIZE-B1: M3-23 consumes the recovered allowance within the unchanged release gate.
contract ReceiverSizeRecoveryTest is Test {
    function test_receiverUsesM3AllowanceWithinReleaseGate() public view {
        assertLe(vm.getDeployedCode("BoxReceiverV2.sol:BoxReceiverV2").length, 22_118);
    }

    function test_exactProductionSizesAndHelperGate() public view {
        assertEq(vm.getDeployedCode("BoxReceiverV2.sol:BoxReceiverV2").length, 17646);
        uint256 size = vm.getDeployedCode("out/ReceiverViews.sol/ReceiverViews.json").length;
        assertEq(size, 5477);
        assertLe(size, 22_118);
    }

    function test_constructorCreatesFixedStatelessPart() public {
        address receiver = deployCode(
            "BoxReceiverV2.sol:BoxReceiverV2",
            ReceiverDeploy.args(IPoolManager(address(0x1000)), address(0x2000), address(0x3000), address(0x4000))
        );
        (address views,,) = BoxReceiverV2(receiver).receiverCode();
        assertEq(vm.getNonce(receiver), 1, "implementation creates no children");
        assertEq(views.codehash, keccak256(vm.getDeployedCode("out/ReceiverViews.sol/ReceiverViews.json")));
        assertEq(receiver.code.length, 17646);
        assertEq(views.balance, 0);
    }
}
