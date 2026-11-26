// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxCollection} from "../../../../src/box/BoxCollection.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxFactoryV1} from "../../../../src/box/BoxFactoryV1.sol";
import {BoxFactoryV1Planner} from "../../../../src/box/BoxFactoryV1Planner.sol";
import {BoxHook} from "../../../../src/box/BoxHook.sol";
import {BoxHookExtension} from "../../../../src/box/BoxHookExtension.sol";
import {BoxItemStream} from "../../../../src/box/BoxItemStream.sol";
import {BoxLaunchRouter} from "../../../../src/box/BoxLaunchRouter.sol";
import {BoxReceiver} from "../../../../src/box/BoxReceiver.sol";
import {BoxReceiverExtension} from "../../../../src/box/BoxReceiverExtension.sol";
import {BoxRegistry} from "../../../../src/box/BoxRegistry.sol";
import {BoxRoyaltyRouter} from "../../../../src/box/BoxRoyaltyRouter.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxTickets} from "../../../../src/box/BoxTickets.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";
import {BoxVault} from "../../../../src/box/BoxVault.sol";
import {FitBuybackExecutor} from "../../../../src/box/FitBuybackExecutor.sol";
import {BoxBackedSource} from "../../../../src/box/randomness/BoxBackedSource.sol";
import {DrandSource} from "../../../../src/box/randomness/DrandSource.sol";
import {IVmFrameGas} from "../../../../script/lib/CoreV1Deployment.sol";
import {AuditU1FablePreWorld} from "./AuditU1FableBase.sol";

/// @notice SH-AUDIT-B0 U1 (Fable), L5 P1.9 and L8 P1.14 on each EVM the unit's gas and address rules could depend on:
/// box 0's creation (the world's spec: N 1,969, the 3,341-byte table, seven add-ons) fits EIP-7825's transaction cap
/// with the 1,000,000-gas margin BC-068 asks for on Cancun and Osaka, and its execution gas (the total less EIP-8037's
/// state gas) fits the cap on Amsterdam; the nonce plan equals the coordinator's CREATE order on all three. Sizes
/// (BC-069): every implementation, extension and full contract within EIP-170, the tickets with at least 1,000 bytes
/// to spare, every creation code within EIP-3860, every clone's init code too (the mainnet build; the rehearsal
/// build is a separate profile, see the evidence's Limitations).
abstract contract AuditU1FableGasBase is AuditU1FablePreWorld {
    uint256 internal constant TX_GAS_CAP = 16_777_216;
    uint256 internal constant MARGIN = 1_000_000;

    function _evm() internal view returns (string memory) {
        return vm.getEvmVersion();
    }

    /// @dev The creation measured in the kit's frame (`creationGas` is the caller's gasleft delta around createBox,
    /// which under EIP-8037 includes the state gas) and its frame's state gas (`lastFrameGas`).
    function _measure() internal returns (uint256 total, uint256 stateGas, uint256 intrinsic) {
        bytes memory callData = abi.encodeCall(factory.createBox, (_preSpec(), kit.hookSalt(), _executorCode()));
        intrinsic = 21_000 + _calldataGas(callData);
        kit.create();
        IVmFrameGas.Gas memory g = IVmFrameGas(address(vm)).lastFrameGas();
        total = kit.creationGas();
        stateGas = g.gasStateUsed > 0 ? uint256(uint64(g.gasStateUsed)) : 0;
        _bindHandles();
        emit log_named_string("U1|gas|evm", _evm());
        emit log_named_uint("U1|gas|createBox total (caller frame)", total);
        emit log_named_uint("U1|gas|createBox state gas (EIP-8037, 0 before it)", stateGas);
        emit log_named_uint("U1|gas|createBox intrinsic (21,000 + calldata)", intrinsic);
        emit log_named_uint("U1|gas|createBox execution + intrinsic", total - stateGas + intrinsic);
    }

    function _creationFits(bytes memory code, string memory name) internal pure {
        assertLe(code.length, 49_152, string.concat("EIP-3860: ", name));
    }

    function _calldataGas(bytes memory data) internal pure returns (uint256 g) {
        for (uint256 i; i < data.length; ++i) {
            g += data[i] == 0 ? 4 : 16;
        }
    }

    function _assertNoncePlan() internal view {
        address c = a.coordinator;
        assertEq(c, vm.computeCreateAddress(address(factory), 2), "coordinator: the factory's nonce 2");
        assertEq(address(registry), vm.computeCreateAddress(address(factory), 1), "registry: nonce 1");
        assertEq(collection.metadataTable(), vm.computeCreateAddress(c, 1), "table: nonce 1");
        assertEq(coordinator.token(), vm.computeCreateAddress(c, 2), "T: nonce 2");
        assertEq(coordinator.vault(), vm.computeCreateAddress(c, 3), "vault: nonce 3");
        assertEq(coordinator.collection(), vm.computeCreateAddress(c, 4), "collection: nonce 4");
        assertEq(coordinator.receiver(), vm.computeCreateAddress(c, 5), "receiver: nonce 5");
        assertEq(coordinator.launchRouter(), vm.computeCreateAddress(c, 6), "launch router: nonce 6");
        assertEq(coordinator.executor(), vm.computeCreateAddress(c, 7), "FIT's executor: nonce 7");
        assertEq(coordinator.tickets(), vm.computeCreateAddress(c, 8), "tickets: nonce 8");
        assertEq(coordinator.itemStream(), vm.computeCreateAddress(c, 9), "per-item stream: nonce 9");
        assertEq(coordinator.royaltyRouter(), vm.computeCreateAddress(c, 10), "royalty router: nonce 10");
        assertEq(vm.getNonce(c), 12, "ten CREATEs by the coordinator, then the hook's CREATE2 (a nonce too)");
        assertEq(vm.getNonce(address(factory)), 3, "two CREATEs by the factory");
        assertEq(coordinator.hook(), a.hook, "the hook at the mined CREATE2 address");
        assertEq(a.hook, vm.computeCreate2Address(kit.hookSalt(), factory.hookInitCodeHash(_preSpec().openAt), c));
    }
}

/// forge-config: default.evm_version = "osaka"
contract AuditU1FableGasOsakaTest is AuditU1FableGasBase {
    /// P1.9 (Osaka): the creation's total gas plus its intrinsic cost stays under the cap with 1,000,000 to spare.
    function testProperty_AUDIT_U1_createBoxFitsTheTransactionCapOsaka() public {
        (uint256 total,, uint256 intrinsic) = _measure();
        assertLe(total + intrinsic, TX_GAS_CAP - MARGIN, "under EIP-7825 with 1M to spare");
        _assertNoncePlan();
    }

    /// P1.9 (BC-069, mainnet build): runtime sizes within EIP-170 (the tickets with 1,000 bytes of margin), creation
    /// codes within EIP-3860, every clone's init code and runtime within both.
    function testProperty_AUDIT_U1_sizesWithinEip170AndEip3860() public {
        _createNow();
        address[11] memory list = [
            impls.coordinator,
            impls.hook,
            impls.hookExtension,
            impls.launchRouter,
            impls.receiver,
            impls.receiverExtension,
            impls.collection,
            impls.vault,
            impls.tickets,
            impls.royaltyRouter,
            impls.itemStream
        ];
        for (uint256 i; i < list.length; ++i) {
            assertLe(list[i].code.length, 24_576, "EIP-170: an implementation");
        }
        assertLe(impls.tickets.code.length, 24_576 - 1_000, "the tickets keep 1,000 bytes of margin");
        assertLe(address(factory).code.length, 24_576, "factory");
        assertLe(address(planner).code.length, 24_576, "planner");
        assertLe(address(registry).code.length, 24_576, "registry");
        assertLe(a.token.code.length, 24_576, "T");
        assertLe(a.executor.code.length, 24_576, "FIT's executor");
        assertLe(address(src).code.length, 24_576, "BoxBackedSource");
        assertLe(address(drand).code.length, 24_576, "DrandSource");
        assertLe(a.table.code.length, 24_576, "the table");
        _creationFits(type(BoxCoordinator).creationCode, "BoxCoordinator");
        _creationFits(type(BoxHook).creationCode, "BoxHook");
        _creationFits(type(BoxHookExtension).creationCode, "BoxHookExtension");
        _creationFits(type(BoxLaunchRouter).creationCode, "BoxLaunchRouter");
        _creationFits(type(BoxReceiver).creationCode, "BoxReceiver");
        _creationFits(type(BoxReceiverExtension).creationCode, "BoxReceiverExtension");
        _creationFits(type(BoxCollection).creationCode, "BoxCollection");
        _creationFits(type(BoxVault).creationCode, "BoxVault");
        _creationFits(type(BoxTickets).creationCode, "BoxTickets");
        _creationFits(type(BoxRoyaltyRouter).creationCode, "BoxRoyaltyRouter");
        _creationFits(type(BoxItemStream).creationCode, "BoxItemStream");
        _creationFits(type(BoxFactoryV1).creationCode, "BoxFactoryV1");
        _creationFits(type(BoxFactoryV1Planner).creationCode, "BoxFactoryV1Planner");
        _creationFits(type(BoxRegistry).creationCode, "BoxRegistry");
        _creationFits(type(BoxToken).creationCode, "BoxToken");
        _creationFits(type(FitBuybackExecutor).creationCode, "FitBuybackExecutor");
        _creationFits(type(DrandSource).creationCode, "DrandSource");
        _creationFits(type(BoxBackedSource).creationCode, "BoxBackedSource");
        bytes[] memory codes = kit.codes();
        for (uint256 i; i < codes.length; ++i) {
            assertLe(codes[i].length, 49_152, "EIP-3860: a code the coordinator CREATEs");
        }
        address[11] memory clones = [
            a.coordinator,
            a.hook,
            a.launchRouter,
            a.receiver,
            a.collection,
            a.vault,
            a.tickets,
            a.royaltyRouter,
            a.itemStream,
            a.token,
            a.executor
        ];
        for (uint256 i; i < clones.length; ++i) {
            assertLe(clones[i].code.length, 24_576, "EIP-170: a box 0 contract");
        }
        emit log_named_uint("U1|size|tickets implementation", impls.tickets.code.length);
        emit log_named_uint("U1|size|hook implementation", impls.hook.code.length);
        emit log_named_uint("U1|size|receiver implementation", impls.receiver.code.length);
        emit log_named_uint("U1|size|factory", address(factory).code.length);
        emit log_named_uint("U1|size|planner", address(planner).code.length);
        emit log_named_uint("U1|size|collection clone", a.collection.code.length);
    }
}

/// forge-config: default.evm_version = "cancun"
contract AuditU1FableGasCancunTest is AuditU1FableGasBase {
    /// P1.9, P1.14 (Cancun, the compiler's target and the chain before Prague): the same cap with the same margin,
    /// the same nonce plan.
    function testProperty_AUDIT_U1_createBoxFitsTheTransactionCapCancun() public {
        (uint256 total,, uint256 intrinsic) = _measure();
        assertLe(total + intrinsic, TX_GAS_CAP - MARGIN, "under EIP-7825 with 1M to spare");
        _assertNoncePlan();
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU1FableGasAmsterdamTest is AuditU1FableGasBase {
    /// P1.9, P1.14 (Amsterdam, Foundry 1.8.3's Glamsterdam with EIP-8037's state gas): the creation's execution gas
    /// (its total less the state gas, which the cap excludes) plus the intrinsic cost stays under the cap; the state
    /// gas is most of the total (code deposits at 1,530 a byte); the nonce plan is the same.
    function testProperty_AUDIT_U1_createBoxFitsTheTransactionCapAmsterdam() public {
        (uint256 total, uint256 stateGas, uint256 intrinsic) = _measure();
        assertGt(stateGas, total / 2, "state gas dominates under EIP-8037");
        assertLe(total - stateGas + intrinsic, TX_GAS_CAP, "execution gas under EIP-7825");
        _assertNoncePlan();
    }
}
