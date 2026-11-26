// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {RoyaltyRelease} from "../kit/RoyaltyRelease.sol";
import {M234Base} from "./Fixture.sol";
import {WBox0Read} from "../m1-64/CQ11WDeployment.t.sol";
import {DeployCoreV2} from "../../../script/DeployCoreV2.s.sol";
import {CoreV2Deployment} from "../../../script/sepolia-v2/CoreV2Deployment.sol";
import {BoxFactoryV2} from "../../../src/box-v2/BoxFactoryV2.sol";
import {BoxFactoryV2Planner} from "../../../src/box-v2/BoxFactoryV2Planner.sol";
import {Vm} from "forge-std/Vm.sol";

/// Exercise the script's real deployment and manifest without reading or writing process-wide CORE_V2_*.
/// The existing M2DeploymentSeamsTest remains the sole owner of environment-based run()/Safe preflight.
contract M234DeploymentHarness is DeployCoreV2 {
    function simulate(Config memory c, address box0) external returns (BoxFactoryV2 f, string memory manifest) {
        // Probe state gas exactly as the existing deployment fixture, without a network or environment input.
        bytes memory code = hex"6104006000f3";
        uint256 before_ = gasleft();
        address probe;
        assembly ("memory-safe") { probe := create(0, add(code, 32), mload(code)) }
        chargesStateGas = before_ - gasleft() > 1_000_000;
        require(probe != address(0));
        vm.startPrank(c.deployer);
        BoxFactoryV2Planner.Release memory r = _deployM2CoreV2(c);
        vm.stopPrank();
        f = BoxFactoryV2(r.factory);
        manifest = _manifest(c, r, box0, "{}", false);
    }
}

contract M234DeploymentTest is M234Base {
    function test_scriptDeploysAndCommitsEveryM2Implementation() public {
        CoreV2Deployment.Config memory c = CoreV2Deployment.Config(
            DEPLOYER, address(pm), release.weth, release.randomness, address(registry),
            fitSafe, address(this), RoyaltyRelease.config());
        WBox0Read box0 = new WBox0Read(c.platformSafe, c.manager, c.randomness, c.weth, fitSafe);
        M234DeploymentHarness script = new M234DeploymentHarness();
        uint256 nonce = vm.getNonce(DEPLOYER);
        vm.recordLogs();
        (BoxFactoryV2 f, string memory manifest) = script.simulate(c, address(box0));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 steps;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == keccak256("DeploymentGas(string,uint256,uint256)")) ++steps;
        }
        assertEq(steps, 30);
        address[] memory inventory = vm.parseJsonAddressArray(manifest, ".parts");
        assertEq(inventory.length, 42, "include the shared CoW handler");
        assertEq(inventory[41], vm.parseJsonAddress(manifest, ".royaltyCowHandler"));
        address[] memory implementations = vm.parseJsonAddressArray(manifest, ".implementations");
        bytes32[] memory hashes = vm.parseJsonBytes32Array(manifest, ".implementationCodeHashes");
        assertEq(implementations.length, 24); assertEq(hashes.length, 24);
        for (uint256 slot; slot < 24; ++slot) {
            bool used = slot < 9 || slot == 17 || slot == 19 || slot == 20 || slot == 21 || slot == 16 || slot == 22;
            assertEq(implementations[slot], f.implementation(slot));
            if (used) {
                assertGt(implementations[slot].code.length, 0);
                assertLe(implementations[slot].code.length, 22118);
                assertEq(hashes[slot], implementations[slot].codehash);
            } else { assertEq(implementations[slot], address(0)); assertEq(hashes[slot], bytes32(0)); }
        }
        assertEq(vm.getNonce(DEPLOYER), nonce + 30);
        assertEq(vm.parseJsonBytes32(manifest, ".versionCodeHash"), f.versionCodeHash());
    }
}
