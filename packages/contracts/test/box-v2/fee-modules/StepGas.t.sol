// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {PayInTLifecycleTest} from "../pay-in-t/Lifecycle.t.sol";
import {ReceiverDeploy} from "./ReceiverDeploy.sol";

/// Complete successful step with cold shared code and state, used for the pinned-base comparison.
contract FeeModuleStepGasTest is PayInTLifecycleTest {
    function test_FM14_coldHolderTStep() public { _step(false); }
    function test_FM14_coldItemTStep() public { _step(true); }
    function _step(bool items) private {
        _start(_rewardSpec(items, false)); _fill(); box.graduate(); receiver.collect(address(0));
        vm.roll(block.number + 1);
        for (uint256 i; i < 24; ++i) {
            address part = box.roleAddress(i); if (part != address(0)) vm.cool(part);
            address implementation = release.implementations[i]; if (implementation != address(0)) vm.cool(implementation);
        }
        ReceiverDeploy.cool(release.implementations[5]);
        vm.cool(address(pm));
        uint256 before_ = gasleft();
        (, uint256 spent, uint256 bought,) = receiver.buyBack(address(0));
        uint256 used = before_ - gasleft();
        assertGt(spent, 0); assertGt(bought, 0);
        emit log_named_uint(items ? "cold items T complete step" : "cold holders T complete step", used);
        assertLe(used, 3_000_000);
    }
}
