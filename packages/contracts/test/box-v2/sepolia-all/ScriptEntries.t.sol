// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {DryRunExtended} from "../../../script/sepolia-v2/DryRunExtended.s.sol";
import {DeploySepoliaV2TestSet} from "../../../script/sepolia-v2/DeploySepoliaV2TestSet.s.sol";
import {SepoliaTestToken} from "../../../script/sepolia-v2/SepoliaV2TestSet.sol";

contract SepoliaScriptEntriesTest is Test {
    function test_extendedEntryBuildsAndRunsWithoutSigner() public {
        new DryRunExtended().runRoyalties();
    }

    function test_assetEntriesSimulateWithoutSigner() public {
        vm.chainId(31337);
        vm.setEnv("CORE_V2_DEPLOYER", vm.toString(address(0xC064)));
        vm.setEnv("CORE_V2_BROADCAST", "false");
        // The helper only pins the manager; actual unlock behavior is exercised in Life.t.sol.
        vm.setEnv("CORE_V2_POOL_MANAGER", vm.toString(address(0xB064)));
        DeploySepoliaV2TestSet entry = new DeploySepoliaV2TestSet();
        vm.recordLogs();
        address[3] memory assets = entry.run();
        assertEq(SepoliaTestToken(assets[0]).decimals(), 6);
        assertEq(SepoliaTestToken(assets[1]).decimals(), 8);
        assertEq(SepoliaTestToken(assets[2]).decimals(), 18);
        for (uint256 i; i < 3; ++i) {
            assertEq(SepoliaTestToken(assets[i]).owner(), address(0xC064));
        }
        entry.runHelpers();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 checked;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != keccak256("TestDeploymentGas(string,uint256,uint256)")) continue;
            (, uint256 total, uint256 stateGas) = abi.decode(logs[i].data, (string, uint256, uint256));
            assertGt(total, 21_000);
            assertLe(total * 130 / 100, 16_777_216);
            assertLe(stateGas, total);
            ++checked;
        }
        assertEq(checked, 5, "all three assets and both helpers need measured envelopes");
    }
}
