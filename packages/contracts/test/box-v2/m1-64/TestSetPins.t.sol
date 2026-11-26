// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {DryRunCoreV2} from "../../../script/sepolia-v2/DryRunCoreV2.s.sol";
import {Vm} from "forge-std/Vm.sol";

/// CQ11-F / M1-64 / M2-64 / M3-64 replaces the retired converter/oracle test-set plan.
contract SepoliaDryRunTest is Test {
    function test_combinedRunIsExecutableWithoutRpcSignerOrBroadcast() public {
        vm.recordLogs();
        new DryRunCoreV2().run();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool finished;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != keccak256("RehearsalStep(string,address,uint256)")) continue;
            (string memory step,,) = abi.decode(logs[i].data, (string, address, uint256));
            if (keccak256(bytes(step)) == keccak256("365d simulated: claims stay open")) finished = true;
        }
        assertTrue(finished, "combined run must reach the final money exit");
    }
}
