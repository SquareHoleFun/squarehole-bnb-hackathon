// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Vm, VmSafe} from "forge-std/Vm.sol";
import {AuditU1LaneBase} from "./AuditU1LaneBase.sol";
import {CoreImpls} from "../../conformance/core/CoreBox0Kit.sol";
import {IVmFrameGas} from "../../../../script/lib/CoreV1Deployment.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {FitBuybackExecutor} from "../../../../src/box/FitBuybackExecutor.sol";
import {BoxFactoryV1Planner} from "../../../../src/box/BoxFactoryV1Planner.sol";
import {BoxBuildV1} from "sh-box-build/BoxBuildV1.sol";
import {BoxBuildV1 as Mainnet} from "../../../../src/box/build/mainnet/BoxBuildV1.sol";
import {
    BoxBuildV1 as Rehearsal,
    BoxBuildGuard as RehearsalGuard
} from "../../../../src/box/build/rehearsal/BoxBuildV1.sol";

contract AuditU1LaneRehearsalGuard is RehearsalGuard {}

/// forge-config: default.evm_version = "osaka"
contract AuditU1LaneBuild is AuditU1LaneBase {
    function testProperty_AUDIT_U1_eip170And3860WithTicketsMargin() public {
        _create();
        CoreImpls memory i = kit.impls();
        address[18] memory deployed = [
            i.coordinator,
            i.hook,
            i.hookExtension,
            i.launchRouter,
            i.receiver,
            i.receiverExtension,
            i.collection,
            i.vault,
            i.tickets,
            i.royaltyRouter,
            i.itemStream,
            i.planner,
            i.factory,
            i.registry,
            address(src),
            address(drand),
            a.token,
            a.executor
        ];
        string[18] memory names = [
            "BoxCoordinator",
            "BoxHook",
            "BoxHookExtension",
            "BoxLaunchRouter",
            "BoxReceiver",
            "BoxReceiverExtension",
            "BoxCollection",
            "BoxVault",
            "BoxTickets",
            "BoxRoyaltyRouter",
            "BoxItemStream",
            "BoxFactoryV1Planner",
            "BoxFactoryV1",
            "BoxRegistry",
            "BoxBackedSource",
            "DrandSource",
            "BoxToken",
            "FitBuybackExecutor"
        ];
        for (uint256 k; k < deployed.length; ++k) {
            uint256 runtime = deployed[k].code.length;
            uint256 init = vm.getCode(string.concat(names[k], ".sol:", names[k])).length;
            // Actual constructor ABI is at most 1,024 bytes (factory's is 512; token strings are bounded).
            assertLe(runtime, 24_576, names[k]);
            assertLe(init + 1024, 49_152, names[k]);
            emit log_string(string.concat(
                    "U1-SIZE|",
                    names[k],
                    "|runtime=",
                    vm.toString(runtime),
                    "|initUpper=",
                    vm.toString(init + 1024),
                    "|runtimeMargin=",
                    vm.toString(24_576 - runtime)
                ));
        }
        assertLe(i.tickets.code.length, 24_576 - 1000, "tickets runtime margin");
        assertLe(vm.getCode("BoxTickets.sol:BoxTickets").length + 32, 49_152 - 1000, "tickets init margin");
        address[] memory clones = _targets();
        for (uint256 k; k < 12; ++k) {
            assertLe(clones[k].code.length, 24_576);
        }
    }

    function testProperty_AUDIT_U1_noncePlanAndGasCancun() public {
        _measure("cancun");
    }

    function testProperty_AUDIT_U1_noncePlanAndGasOsaka() public {
        _measure("osaka");
    }

    function testProperty_AUDIT_U1_noncePlanAndGasAmsterdam() public {
        _measure("amsterdam");
    }

    /// BC-064/068: lastFrameGas supplies EIP-8037 state gas separately. Intrinsic calldata upper bound is
    /// 21,000 + 40 per byte (covers EIP-7623's floor too); retained caller-side overhead is conservative.
    function _measure(string memory fork) internal {
        bytes memory data =
            abi.encodeCall(factory.createBox, (_spec(), a.hookSalt, type(FitBuybackExecutor).creationCode));
        vm.setEvmVersion(fork);
        address[] memory all = _targets();
        for (uint256 k; k < all.length; ++k) {
            vm.cool(all[k]);
        }
        vm.cool(address(pm));
        vm.startStateDiffRecording();
        vm.prank(address(kit));
        uint256 gasStart = gasleft();
        (bool ok,) = address(factory).call{value: BoxSpecV1.BOOTSTRAP_ETH}(data);
        uint256 totalGas = gasStart - gasleft();
        IVmFrameGas.Gas memory g = IVmFrameGas(address(vm)).lastFrameGas();
        assertTrue(ok, "createBox succeeds under this fork");
        Vm.AccountAccess[] memory changes = vm.stopAndReturnStateDiff();
        uint256 order;
        for (uint256 k; k < changes.length; ++k) {
            if (changes[k].kind != VmSafe.AccountAccessKind.Create) continue;
            assertLt(order, 12);
            assertEq(changes[k].account, all[order], "CREATE order follows the planner");
            assertFalse(changes[k].reverted);
            ++order;
        }
        assertEq(order, 12, "coordinator, ten nonce children, CREATE2 hook");
        for (uint256 k = 1; k <= 10; ++k) {
            assertEq(all[k], vm.computeCreateAddress(a.coordinator, k));
        }
        assertEq(vm.getNonce(a.coordinator), 12);
        assertEq(vm.getNonce(address(factory)), 3);
        uint256 stateGas = g.gasStateUsed > 0 ? uint256(int256(g.gasStateUsed)) : 0;
        uint256 charge = totalGas - stateGas + 21_000 + data.length * 40;
        assertLe(charge, 16_777_216 - 1_000_000, "execution cap with 1M margin");
        emit log_string(string.concat(
                "U1-GAS|",
                fork,
                "|totalFrame=",
                vm.toString(totalGas),
                "|state=",
                vm.toString(stateGas),
                "|capChargeUpper=",
                vm.toString(charge),
                "|margin=",
                vm.toString(16_777_216 - charge)
            ));
    }

    /// F78: seven box-0 amounts scale exactly; constructors reject chain 1. This checks the real imported guard
    /// in both profiles and the actual planner constructor in the rehearsal profile.
    function testProperty_AUDIT_U1_rehearsalGuardAndSevenAmounts() public {
        assertEq(Rehearsal.RAISE * 10, Mainnet.RAISE);
        assertEq(Rehearsal.BOOTSTRAP_ETH * 10, Mainnet.BOOTSTRAP_ETH);
        assertEq(Rehearsal.FEE_BATCH_MIN_ETH * 10, Mainnet.FEE_BATCH_MIN_ETH);
        assertEq(Rehearsal.FEE_BATCH_TIP_MAX_ETH * 10, Mainnet.FEE_BATCH_TIP_MAX_ETH);
        assertEq(Rehearsal.SWAP_STEP_MIN_Q * 10, Mainnet.SWAP_STEP_MIN_Q);
        assertEq(Rehearsal.DEPTH_CONVERT_MIN_Q * 10, Mainnet.DEPTH_CONVERT_MIN_Q);
        assertEq(Rehearsal.PLATFORM_CAP_WEI * 10, Mainnet.PLATFORM_CAP_WEI);
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(RehearsalGuard.RehearsalBuildRefusesChain.selector, 1));
        new AuditU1LaneRehearsalGuard();
        if (BoxBuildV1.REHEARSAL) {
            vm.expectRevert(abi.encodeWithSelector(RehearsalGuard.RehearsalBuildRefusesChain.selector, 1));
            new BoxFactoryV1Planner();
        }
        vm.chainId(11_155_111);
        new AuditU1LaneRehearsalGuard();
    }
}
