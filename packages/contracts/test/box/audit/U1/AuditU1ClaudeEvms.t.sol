// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxFactoryV1Planner} from "../../../../src/box/BoxFactoryV1Planner.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";
import {FitBuybackExecutor} from "../../../../src/box/FitBuybackExecutor.sol";
import {IBoxFactoryV1} from "../../../../src/box/interfaces/IBoxFactoryV1.sol";
import {BoxClones} from "../../../../src/box/libraries/BoxClones.sol";
import {CoreBoxAddresses} from "../../conformance/core/CoreBox0Kit.sol";
import {S0StateDiff} from "../../../spikes/S0StateDiff.sol";
import {AuditU1ClaudeKitBase} from "./AuditU1ClaudeBase.sol";

/// @title AuditU1ClaudeEvmsBase
/// @notice SH-AUDIT-B0 U1, lenses L8 (P1.14) and L5 (P1.9, creation gas), run under three EVMs by the contracts below.
abstract contract AuditU1ClaudeEvmsBase is AuditU1ClaudeKitBase {
    uint256 internal constant TX_GAS_CAP = 16_777_216;
    /// @dev EIP-8037's state gas (Foundry 1.8.3's amsterdam), as BoxFactoryV1Gas.t.sol counts it.
    uint256 internal constant STATE_GAS_PER_SLOT = 97_920;
    uint256 internal constant STATE_GAS_PER_ACCOUNT = 183_600;
    uint256 internal constant STATE_GAS_PER_CODE_BYTE = 1_530;

    /// P1.14 (`BoxFactoryV1Planner.sol:31-34`, `:48-57`; BC-064; IBoxFactoryV1 step 2): the coordinator CREATEs, in this
    /// order and nothing else, the table at nonce 1, T 2, vault 3, collection 4, receiver 5, launch router 6, FIT's
    /// executor 7, tickets 8, stream 9 and royalty router 10, then CREATE2s the hook; every address is the planner's
    /// `addresses(coordinator)` and CREATE(coordinator, nonce); each is the code it should be (the table 0x00 ++ table,
    /// T's and FIT's executor's reviewed code, each clone its implementation's proxy); the coordinator names each role
    /// at its nonce, and its own nonce ends at 12. The coordinator itself is the factory's CREATE at nonce 2.
    function _assertNoncePlan() internal {
        kit.prepare(_spec());
        CoreBoxAddresses memory a = kit.addresses();
        IBoxFactoryV1.Box0Addresses memory b = factory.box0Addresses();
        vm.startStateDiffRecording();
        kit.create();
        VmSafe.AccountAccess[] memory acc = vm.stopAndReturnStateDiff();
        _assertCreateOrder(a, b, acc);
        _assertCodes(a, b);
        _assertCoordinatorNonces(a);
    }

    function _assertCreateOrder(
        CoreBoxAddresses memory a,
        IBoxFactoryV1.Box0Addresses memory b,
        VmSafe.AccountAccess[] memory acc
    ) internal view {
        address[11] memory expected = [
            b.table,
            b.token,
            b.vault,
            b.collection,
            b.receiver,
            b.launchRouter,
            b.executor,
            b.tickets,
            b.itemStream,
            b.royaltyRouter,
            a.hook
        ];
        uint256 k;
        for (uint256 i; i < acc.length; ++i) {
            if (acc[i].kind != VmSafe.AccountAccessKind.Create || acc[i].reverted) continue;
            if (acc[i].accessor != a.coordinator) continue;
            assertLt(k, 11, "eleven creations by the coordinator");
            assertEq(acc[i].account, expected[k], string.concat("creation in plan order #", vm.toString(k)));
            if (k < 10) {
                assertEq(acc[i].account, vm.computeCreateAddress(a.coordinator, k + 1), "CREATE(coordinator, nonce)");
            }
            ++k;
        }
        assertEq(k, 11, "the plan's ten CREATEs and the hook's CREATE2");
        assertEq(vm.getNonce(a.coordinator), 12, "the coordinator's nonce ends at 12");
        assertEq(a.coordinator, vm.computeCreateAddress(address(factory), 2), "the coordinator: factory nonce 2");
        IBoxFactoryV1.Box0Addresses memory p = planner.addresses(a.coordinator, true);
        assertEq(keccak256(abi.encode(p)), keccak256(abi.encode(b)), "the planner's addresses");
    }

    function _assertCodes(CoreBoxAddresses memory a, IBoxFactoryV1.Box0Addresses memory b) internal {
        assertEq(b.table.code, bytes.concat(hex"00", _spec().metadataTable), "nonce 1: the table");
        assertEq(BoxToken(b.token).vault(), b.vault, "nonce 2: T");
        assertEq(BoxToken(b.token).initialHolder(), a.coordinator);
        assertEq(b.executor.codehash, keccak256(_executorRuntime(b)), "nonce 7: FIT's executor's reviewed code");
        address[7] memory clones = [b.vault, b.collection, b.receiver, b.launchRouter, b.tickets, b.itemStream, a.hook];
        address[7] memory implOf = [
            impls.vault,
            impls.collection,
            impls.receiver,
            impls.launchRouter,
            impls.tickets,
            impls.itemStream,
            impls.hook
        ];
        for (uint256 i; i < 7; ++i) {
            assertEq(bytes20(_slice(clones[i].code, 10, 20)), bytes20(implOf[i]), "each clone's implementation");
        }
        assertEq(bytes20(_slice(b.royaltyRouter.code, 16, 20)), bytes20(impls.royaltyRouter), "nonce 10: router");
    }

    function _assertCoordinatorNonces(CoreBoxAddresses memory a) internal view {
        BoxCoordinator c = BoxCoordinator(a.coordinator);
        uint8[9] memory nonces = [
            planner.NONCE_TOKEN(),
            planner.NONCE_VAULT(),
            planner.NONCE_COLLECTION(),
            planner.NONCE_RECEIVER(),
            planner.NONCE_ROUTER(),
            planner.NONCE_TICKETS(),
            planner.NONCE_ROYALTY(),
            planner.NONCE_STREAM(),
            planner.NONCE_EXECUTOR()
        ];
        for (uint8 role; role < 9; ++role) {
            assertEq(c.nonceOf(role), nonces[role], "the coordinator names each role at the planner's nonce");
        }
    }

    function _executorRuntime(IBoxFactoryV1.Box0Addresses memory b) internal returns (bytes memory) {
        // The runtime FIT's executor's creation code returns for box 0's arguments, rebuilt at another address.
        bytes memory init = bytes.concat(
            type(FitBuybackExecutor).creationCode,
            abi.encode(pm, b.token, b.coordinator, kit.addresses().hook, b.receiver, kit.curve().tickLower)
        );
        address at;
        assembly ("memory-safe") {
            at := create(0, add(init, 0x20), mload(init))
        }
        // Its immutables hold only its arguments (and the pool id they fix), so the runtime is the same anywhere.
        return at.code;
    }

    function _slice(bytes memory b, uint256 from, uint256 n) internal pure returns (bytes memory out) {
        out = new bytes(n);
        for (uint256 i; i < n; ++i) {
            out[i] = b[from + i];
        }
    }

    /// P1.9 (BC-068, EIP-7825; S7 finding 2 already records Glamsterdam's schedule): box 0's createBox, measured cold,
    /// fits the 16,777,216 transaction cap: today (cancun, osaka) its whole gas with its intrinsic cost, under amsterdam
    /// its execution gas (EIP-8037 keeps state gas outside the cap: slots × 97,920 + accounts × 183,600 + code bytes ×
    /// 1,530). The measured figures and margins are logged (`U1-GAS|<evm>|...`) and pinned within 1%: 7,127,719 on
    /// cancun and osaka (6,817,459 in the frame + 310,260 intrinsic; 9,649,497 to spare), 2,215,545 execution gas on
    /// amsterdam (39,602,955 in the frame, 37,697,670 of it state gas; 14,561,671 to spare). Under amsterdam the whole
    /// transaction needs a gas limit near 40M, above the cap: whether the fork lets state gas exceed it is the open
    /// schedule question S7's finding 2 already records.
    struct Gas {
        uint256 frame;
        uint256 intrinsic;
        uint256 state;
        uint256 capped;
        S0StateDiff.Counts counts;
    }

    function _assertCreationGas(string memory evm, uint256 pinned) internal {
        kit.prepare(_spec());
        bytes memory callData = abi.encodeCall(factory.createBox, (_spec(), kit.hookSalt(), _executorCode()));
        vm.cool(address(factory));
        vm.cool(address(registry));
        vm.cool(address(planner));
        vm.cool(address(pm));
        vm.startStateDiffRecording();
        kit.create();
        Gas memory gas;
        gas.counts = S0StateDiff.count(vm.stopAndReturnStateDiff());
        gas.frame = kit.creationGas();
        gas.intrinsic = 21_000 + _calldataGas(callData);
        gas.state = gas.counts.newSlots * STATE_GAS_PER_SLOT + gas.counts.accounts * STATE_GAS_PER_ACCOUNT
            + gas.counts.codeBytes * STATE_GAS_PER_CODE_BYTE;
        bool glamsterdam = keccak256(bytes(evm)) == keccak256("amsterdam");
        gas.capped = glamsterdam ? gas.frame - gas.state + gas.intrinsic : gas.frame + gas.intrinsic;
        _logGas(evm, gas);
        assertLe(gas.capped, TX_GAS_CAP - 1_000_000, "within EIP-7825 with 1,000,000 to spare");
        assertApproxEqRel(gas.capped, pinned, 0.01e18, "the measured figure");
    }

    function _logGas(string memory evm, Gas memory gas) internal {
        string memory head = string.concat(
            "U1-GAS|",
            evm,
            "|frame=",
            vm.toString(gas.frame),
            "|intrinsic=",
            vm.toString(gas.intrinsic),
            "|state=",
            vm.toString(gas.state)
        );
        string memory tail = string.concat(
            "|capped=",
            vm.toString(gas.capped),
            "|margin=",
            vm.toString(TX_GAS_CAP - gas.capped),
            "|accounts=",
            vm.toString(gas.counts.accounts),
            "|codeBytes=",
            vm.toString(gas.counts.codeBytes),
            "|newSlots=",
            vm.toString(gas.counts.newSlots)
        );
        emit log(string.concat(head, tail));
    }

    /// P1.5 / BC-114, the receiving proxy (`BoxClones.sol:15-21`, ADR-0016 § 2): box 0's royalty router, a receiving
    /// clone, takes a payment with exactly the 2,300-gas stipend (Solidity `transfer`) and with 0 wei, and writes no
    /// storage; the same payment to a standard clone (box 0's receiver, whose `receive` refuses strangers) fails. Run on
    /// every EVM: the stipend is spent before any DELEGATECALL could cost 2,600 (3,000 after EIP-8038), so the wave-1
    /// Amsterdam observation (a value call to a 7702-delegated account leaves about 3,000 gas less) has no bearing here:
    /// no ETH send of U1 (creator → factory → coordinator → launch router → PoolManager) carries a stipend.
    function _assertReceivingProxyTakesAStipend() internal {
        CoreBoxAddresses memory a = _create();
        vm.deal(address(this), 1 ether);
        vm.startStateDiffRecording();
        payable(a.royaltyRouter).transfer(1);
        (bool zero,) = a.royaltyRouter.call{value: 0, gas: 2_300}("");
        VmSafe.AccountAccess[] memory acc = vm.stopAndReturnStateDiff();
        assertTrue(zero, "0 wei with the stipend");
        assertEq(a.royaltyRouter.balance, 1, "the stipend payment arrived");
        for (uint256 i; i < acc.length; ++i) {
            for (uint256 j; j < acc[i].storageAccesses.length; ++j) {
                assertFalse(
                    acc[i].storageAccesses[j].account == a.royaltyRouter && acc[i].storageAccesses[j].isWrite,
                    "the receiving proxy writes nothing"
                );
            }
        }
        (bool ok,) = a.receiver.call{value: 1, gas: 2_300}("");
        assertFalse(ok, "a standard clone without an open receive refuses the stipend payment");
    }

    function _calldataGas(bytes memory data) internal pure returns (uint256 g) {
        for (uint256 i; i < data.length; ++i) {
            g += data[i] == 0 ? 4 : 16;
        }
    }
}

/// forge-config: default.evm_version = "cancun"
contract AuditU1ClaudeEvmsCancunTest is AuditU1ClaudeEvmsBase {
    function testProperty_AUDIT_U1_noncePlanIsTheCreateOrder_cancun() public {
        _assertNoncePlan();
    }

    function testProperty_AUDIT_U1_createBoxWithinTheTransactionCap_cancun() public {
        _assertCreationGas("cancun", 7_127_719);
    }

    function testProperty_AUDIT_U1_receivingProxyTakesAStipend_cancun() public {
        _assertReceivingProxyTakesAStipend();
    }
}

/// forge-config: default.evm_version = "osaka"
contract AuditU1ClaudeEvmsOsakaTest is AuditU1ClaudeEvmsBase {
    function testProperty_AUDIT_U1_noncePlanIsTheCreateOrder_osaka() public {
        _assertNoncePlan();
    }

    function testProperty_AUDIT_U1_createBoxWithinTheTransactionCap_osaka() public {
        _assertCreationGas("osaka", 7_127_719);
    }

    function testProperty_AUDIT_U1_receivingProxyTakesAStipend_osaka() public {
        _assertReceivingProxyTakesAStipend();
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU1ClaudeEvmsAmsterdamTest is AuditU1ClaudeEvmsBase {
    function testProperty_AUDIT_U1_noncePlanIsTheCreateOrder_amsterdam() public {
        _assertNoncePlan();
    }

    function testProperty_AUDIT_U1_createBoxWithinTheTransactionCap_amsterdam() public {
        _assertCreationGas("amsterdam", 2_215_545);
    }

    function testProperty_AUDIT_U1_receivingProxyTakesAStipend_amsterdam() public {
        _assertReceivingProxyTakesAStipend();
    }
}
