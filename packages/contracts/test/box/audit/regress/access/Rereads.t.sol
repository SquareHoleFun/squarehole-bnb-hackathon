// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxS7Base} from "../../../s7/BoxS7Base.sol";
import {BoxFactoryV1Exposed} from "../../../s7/BoxFactoryV1Rereads.t.sol";
import {S7ImpostorPlanner} from "../../../s7/BoxFactoryV1PlannerTrust.t.sol";
import {BoxFactoryV1Planner} from "../../../../../src/box/BoxFactoryV1Planner.sol";
import {BoxSpecV1} from "../../../../../src/box/BoxSpecV1.sol";
import {IBoxFactoryV1} from "../../../../../src/box/interfaces/IBoxFactoryV1.sol";

/// @notice Reuses only the existing exposed factory helper. All probes below are this review's.
/// forge-config: default.evm_version = "osaka"
contract AuditRegressRereadsReviewTest is BoxS7Base {
    bytes internal encodedPlan;

    function _factoryCreationCode() internal pure override returns (bytes memory) {
        return type(BoxFactoryV1Exposed).creationCode;
    }

    function setUp() public override {
        super.setUp();
        bytes32 salt = _salt(_box0Spec());
        _create(_box0Spec());
        encodedPlan = abi.encode(
            planner.plan(_box0Spec(), factory.version(), address(this), salt, keccak256(abi.encode(_box0Spec())))
        );
    }

    function verify() external view {
        BoxFactoryV1Exposed(address(factory))
            .exposedVerify(_box0Spec(), abi.decode(encodedPlan, (BoxFactoryV1Planner.Plan)));
    }

    // Flip precisely one bit in an existing getter's answer. Even a zero-valued field must be re-read.
    function _probe(address target, string memory signature, uint256 check) internal {
        bytes memory data = abi.encodeWithSignature(signature);
        (bool ok, bytes memory actual) = target.staticcall(data);
        assertTrue(ok);
        assertEq(actual.length, 32);
        actual[31] ^= 0x01;
        vm.mockCall(target, data, actual);
        vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV1.Miswired.selector, check));
        this.verify();
        vm.clearMockedCalls();
    }

    function test_AR05_everyTrustBearingRoleIsReread() public {
        IBoxFactoryV1.Box0Addresses memory a = factory.box0Addresses();
        this.verify();
        string[16] memory coord = [
            "token()",
            "vault()",
            "collection()",
            "receiver()",
            "launchRouter()",
            "tickets()",
            "royaltyRouter()",
            "randomness()",
            "specHash()",
            "kind()",
            "hook()",
            "itemStream()",
            "raise()",
            "creator()",
            "executor()",
            "poolManager()"
        ];
        // poolManager is immutable in the implementation and checked by the factory constructor, not _verify.
        for (uint256 i; i < 15; ++i) {
            _probe(a.coordinator, coord[i], i == 14 ? 3 : 1);
        }
        address h = abi.decode(encodedPlan, (BoxFactoryV1Planner.Plan)).hook;
        string[7] memory hookReads =
            ["coordinator()", "token()", "deployBlock()", "openAt()", "phase()", "receiver()", "priceAverage()"];
        for (uint256 i; i < hookReads.length; ++i) {
            _probe(h, hookReads[i], 2);
        }
        string[6] memory executorReads =
            ["poolManager()", "token()", "launchPhase()", "hooks()", "receiver()", "latestSampleTick()"];
        for (uint256 i; i < executorReads.length; ++i) {
            _probe(a.executor, executorReads[i], 3);
        }
        string[12] memory vaultReads = [
            "inside()",
            "hiddenCount()",
            "pendingTickets()",
            "gateOpen()",
            "escrowPrincipal()",
            "ticketAdapter()",
            "observer()",
            "token()",
            "collection()",
            "drawFeeBps()",
            "pickFeeBps()",
            "returnFeeBps()"
        ];
        for (uint256 i; i < vaultReads.length; ++i) {
            _probe(a.vault, vaultReads[i], 6);
        }
        string[11] memory collectionReads = [
            "owner()",
            "metadataTable()",
            "metadataTableHash()",
            "revealRoot()",
            "transferObserver()",
            "revealUnlocker()",
            "revealTriggers()",
            "royaltyRouter()",
            "vault()",
            "token()",
            "receiver()"
        ];
        for (uint256 i; i < collectionReads.length; ++i) {
            _probe(a.collection, collectionReads[i], 7);
        }
        string[5] memory routerReads = ["bootstrapped()", "totalTaxCollected()", "openAt()", "hook()", "token()"];
        for (uint256 i; i < routerReads.length; ++i) {
            _probe(a.launchRouter, routerReads[i], 8);
        }
        string[7] memory receiverReads =
            ["kind()", "platformSafe()", "executor()", "swapModule()", "hook()", "itemStream()", "token()"];
        for (uint256 i; i < receiverReads.length; ++i) {
            _probe(a.receiver, receiverReads[i], 9);
        }
        string[6] memory streamReads = ["coordinator()", "receiver()", "vault()", "collection()", "hook()", "started()"];
        for (uint256 i; i < streamReads.length; ++i) {
            _probe(a.itemStream, streamReads[i], 11);
        }
        string[7] memory ticketReads =
            ["source()", "openAt()", "vault()", "collection()", "token()", "collectionSize()", "firstId()"];
        for (uint256 i; i < ticketReads.length; ++i) {
            _probe(a.tickets, ticketReads[i], 12);
        }
        _probe(a.royaltyRouter, "coordinator()", 13);
        _probe(a.royaltyRouter, "receiver()", 13);
        _probe(a.royaltyRouter, "weth()", 13);
        this.verify();
    }

    function test_AR05_cloneCodeMustNameTheVersionEvenIfGettersWouldAgree() public {
        IBoxFactoryV1.Box0Addresses memory a = factory.box0Addresses();
        address h = abi.decode(encodedPlan, (BoxFactoryV1Planner.Plan)).hook;
        address[8] memory targets =
            [h, a.launchRouter, a.receiver, a.collection, a.vault, a.tickets, a.itemStream, a.royaltyRouter];
        address[8] memory impls = [
            version.impls.hook,
            version.impls.launchRouter,
            version.impls.receiver,
            version.impls.collection,
            version.impls.vault,
            version.impls.tickets,
            version.impls.itemStream,
            version.impls.royaltyRouter
        ];
        uint256[8] memory checks = [uint256(2), 8, 9, 7, 6, 12, 11, 13];
        for (uint256 i; i < targets.length; ++i) {
            address twin = address(uint160(0xD000 + i));
            vm.etch(twin, impls[i].code);
            bytes memory original = targets[i].code;
            bytes memory different = bytes.concat(original);
            uint256 implementationOffset = i == 7 ? 16 : 10;
            for (uint256 j; j < 20; ++j) {
                different[implementationOffset + j] = bytes20(twin)[j];
            }
            vm.etch(targets[i], different);
            vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV1.Miswired.selector, checks[i]));
            this.verify();
            vm.etch(targets[i], original);
        }
        this.verify();
    }

    function test_AR05_shortAndRevertingGetterCannotPassRereads() public {
        address tickets = factory.box0Addresses().tickets;
        bytes memory getter = abi.encodeWithSignature("source()");
        vm.mockCall(tickets, getter, hex"01");
        vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV1.Miswired.selector, 12));
        this.verify();
        vm.clearMockedCalls();
        vm.mockCallRevert(tickets, getter, hex"00");
        vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV1.Miswired.selector, 12));
        this.verify();
        vm.clearMockedCalls();
        this.verify();
    }
}

/// forge-config: default.evm_version = "osaka"
contract AuditRegressAtomicPlannerReviewTest is BoxS7Base {
    function _plannerCreationCode() internal pure override returns (bytes memory) {
        return type(S7ImpostorPlanner).creationCode;
    }

    function test_AR06_wrongSourceInPlannerRollsBackWholeCreation() public {
        S7ImpostorPlanner(address(planner)).set(10, address(0xBAD));
        BoxSpecV1.BoxSpec memory s = _box0Spec();
        bytes32 salt = _salt(s);
        vm.deal(address(this), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV1.Miswired.selector, 12));
        factory.createBox{value: BoxSpecV1.BOOTSTRAP_ETH}(s, salt, _executorCode());
        _assertNothingCreated();
        assertEq(address(factory).balance, 0);
        S7ImpostorPlanner(address(planner)).set(0, address(0));
        _create(s);
        assertEq(registry.boxCount(), 1);
    }
}
