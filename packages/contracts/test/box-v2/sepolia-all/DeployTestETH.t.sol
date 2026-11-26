// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm, VmSafe} from "forge-std/Vm.sol";
import {TestETH} from "../../../src/test-coins/TestETH.sol";
import {DeploySepoliaV2TestSet} from "../../../script/sepolia-v2/DeploySepoliaV2TestSet.s.sol";
import {ReleaseConstantsV2 as C} from "../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";

contract TestETHRecordingCaller {
    function run(DeploySepoliaV2TestSet script) external returns (address) { return script.runTestETH(); }
}

/// SH-ALPHA-TETH-2/4: genuine CREATE predictions, no network or signing.
contract DeployTestETHTest is Test {
    address private constant DEPLOYER = address(0xF030);
    DeploySepoliaV2TestSet private script;

    function setUp() public {
        vm.chainId(31337);
        vm.setEnv("CORE_V2_DEPLOYER", vm.toString(DEPLOYER));
        vm.setEnv("CORE_V2_BROADCAST", "false");
        script = new DeploySepoliaV2TestSet();
    }

    // vm.setEnv changes process-wide state, so keep these env-dependent cases in one sequential test.
    function test_deploymentPredictionRecordingAndRefusals() public {
        _simulationPredictsAddressAndMintsOnlyToDeployer();
        _onlyDeployerCanRecord();
        _unsignedRecordingUsesDeployerNonce();
        _highPredictedAddressRefusedBeforeBroadcastOrCreate();
        _refusesMainnetOtherChainsAndZeroDeployer();
    }

    function _simulationPredictsAddressAndMintsOnlyToDeployer() private {
        address predicted = vm.computeCreateAddress(DEPLOYER, vm.getNonce(DEPLOYER));
        assertLt(uint160(predicted), C.LISTED_TOKEN_CEILING);
        vm.recordLogs();
        address deployed = script.runTestETH();
        assertEq(deployed, predicted);
        assertEq(TestETH(deployed).balanceOf(DEPLOYER), 1_000_000e18);
        assertEq(TestETH(deployed).totalSupply(), 1_000_000e18);
        _assertClosedWithNoAdmissions(TestETH(deployed), DEPLOYER);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool printed;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != keccak256("TestAsset(address,uint8,address,bytes32)")) continue;
            (address token, uint8 decimals, address recipient, bytes32 codeHash) =
                abi.decode(logs[i].data, (address, uint8, address, bytes32));
            assertEq(token, deployed);
            assertEq(decimals, 18);
            assertEq(recipient, DEPLOYER);
            assertEq(codeHash, deployed.codehash);
            printed = true;
        }
        assertTrue(printed);
    }

    function _unsignedRecordingUsesDeployerNonce() private {
        // A direct caller avoids both prank/broadcast incompatibility and the test transaction's own sender nonce.
        TestETHRecordingCaller caller = new TestETHRecordingCaller();
        address sender = address(caller);
        vm.setEnv("CORE_V2_DEPLOYER", vm.toString(sender));
        vm.setNonce(sender, 42);
        address predicted = vm.computeCreateAddress(sender, 42);
        assertLt(uint160(predicted), C.LISTED_TOKEN_CEILING);
        vm.setEnv("CORE_V2_BROADCAST", "true");
        address deployed = caller.run(script);
        vm.setEnv("CORE_V2_BROADCAST", "false");
        vm.setEnv("CORE_V2_DEPLOYER", vm.toString(DEPLOYER));
        assertEq(deployed, predicted);
        assertEq(vm.getNonce(sender), 43);
        assertEq(TestETH(deployed).balanceOf(sender), 1_000_000e18);
        _assertClosedWithNoAdmissions(TestETH(deployed), sender);
    }

    function _assertClosedWithNoAdmissions(TestETH coin, address recipient) private view {
        assertEq(coin.owner(), recipient);
        assertEq(coin.pendingOwner(), address(0));
        assertEq(coin.admitter(), address(0));
        assertEq(coin.admitterPerDay(), 0);
        assertFalse(coin.open());
        assertFalse(coin.admitted(recipient));
        assertFalse(coin.admitted(address(script)));
        assertFalse(coin.admitted(address(this)));
        assertFalse(coin.admitted(address(0)));
        assertFalse(coin.admitted(address(0xA11CE)));
    }

    function _highPredictedAddressRefusedBeforeBroadcastOrCreate() private {
        // Offline CREATE fixture: this nonce gives 0xFFFFFd516B3b8157f8AA737859d4D9919cF343c3.
        vm.setNonce(DEPLOYER, 6672);
        address predicted = vm.computeCreateAddress(DEPLOYER, 6672);
        assertGe(uint160(predicted), C.LISTED_TOKEN_CEILING);
        for (uint256 i; i < 2; ++i) {
            vm.setEnv("CORE_V2_BROADCAST", i == 0 ? "false" : "true");
            vm.expectRevert(abi.encodeWithSelector(DeploySepoliaV2TestSet.TokenAddressTooHigh.selector, predicted));
            script.runTestETH();
            (VmSafe.CallerMode mode,,) = vm.readCallers();
            assertEq(uint256(mode), uint256(VmSafe.CallerMode.None));
            assertEq(vm.getNonce(DEPLOYER), 6672);
            assertEq(predicted.code.length, 0);
        }
        vm.setEnv("CORE_V2_BROADCAST", "false");
    }

    function _refusesMainnetOtherChainsAndZeroDeployer() private {
        vm.chainId(1);
        vm.expectRevert("testnet only");
        script.runTestETH();
        vm.chainId(10);
        vm.expectRevert("testnet only");
        script.runTestETH();
        vm.chainId(31337);
        vm.setEnv("CORE_V2_DEPLOYER", vm.toString(address(0)));
        vm.expectRevert("sender");
        script.runTestETH();
        vm.setEnv("CORE_V2_DEPLOYER", vm.toString(DEPLOYER));
    }

    function _onlyDeployerCanRecord() private {
        vm.setEnv("CORE_V2_BROADCAST", "true");
        vm.expectRevert("deployer");
        script.runTestETH();
        vm.setEnv("CORE_V2_BROADCAST", "false");
    }
}
