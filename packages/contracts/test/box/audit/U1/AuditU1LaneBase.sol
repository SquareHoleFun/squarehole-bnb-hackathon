// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditBox0World} from "../common/AuditBox0World.sol";
import {CoreBox0Kit} from "../../conformance/core/CoreBox0Kit.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxRegistry} from "../../../../src/box/BoxRegistry.sol";
import {BoxFactoryV1Planner} from "../../../../src/box/BoxFactoryV1Planner.sol";
import {FitBuybackExecutor} from "../../../../src/box/FitBuybackExecutor.sol";
import {IBoxFactoryV1} from "../../../../src/box/interfaces/IBoxFactoryV1.sol";
import {BoxBuildV1} from "sh-box-build/BoxBuildV1.sol";

/// @notice Shared audit world stopped immediately before createBox. Uses the shared spec and real deployment kit;
/// no substitute box contracts. Rehearsal scales only the spec's raise, as the kit scales its deployment world.
abstract contract AuditU1LaneBase is AuditBox0World {
    bytes internal encoded;
    BoxRegistry internal registry;
    BoxFactoryV1Planner internal planner;

    function setUp() public virtual override {
        vm.pauseGasMetering();
        kit = new CoreBox0Kit();
        vm.resumeGasMetering();
        kit.setUpWorld();
        factory = kit.factory();
        pm = kit.pm();
        src = kit.source();
        drand = kit.drand();
        BoxSpecV1.BoxSpec memory s = _auditSpec();
        s.raise = BoxBuildV1.RAISE;
        encoded = abi.encode(s);
        kit.prepare(s);
        a = kit.addresses();
        registry = BoxRegistry(factory.registry());
        planner = factory.planner();
        vm.deal(address(kit), 1 ether);
    }

    function _spec() internal view returns (BoxSpecV1.BoxSpec memory) {
        return abi.decode(encoded, (BoxSpecV1.BoxSpec));
    }

    function _create() internal returns (uint256 id, address c, address h) {
        bytes memory code = type(FitBuybackExecutor).creationCode;
        BoxSpecV1.BoxSpec memory s = _spec();
        vm.prank(address(kit));
        return factory.createBox{value: BoxSpecV1.BOOTSTRAP_ETH}(s, a.hookSalt, code);
    }

    function _targets() internal view returns (address[] memory t) {
        t = new address[](15);
        t[0] = a.coordinator;
        t[1] = a.table;
        t[2] = a.token;
        t[3] = a.vault;
        t[4] = a.collection;
        t[5] = a.receiver;
        t[6] = a.launchRouter;
        t[7] = a.executor;
        t[8] = a.tickets;
        t[9] = a.itemStream;
        t[10] = a.royaltyRouter;
        t[11] = a.hook;
        t[12] = address(factory);
        t[13] = address(planner);
        t[14] = address(registry);
    }

    function _nothingCreated() internal view {
        address[] memory t = _targets();
        for (uint256 i; i < 12; ++i) {
            assertEq(t[i].code.length, 0, "no partial deployment");
        }
        assertEq(registry.boxCount(), 0, "no partial registry entry");
        assertEq(vm.getNonce(address(factory)), 2, "factory nonce rollback");
    }

    function _reject(
        BoxSpecV1.BoxSpec memory s,
        address caller,
        uint256 value,
        bytes32 salt,
        bytes memory code,
        bytes memory errorData
    ) internal {
        vm.deal(caller, value);
        vm.prank(caller);
        vm.expectRevert(errorData);
        factory.createBox{value: value}(s, salt, code);
        _nothingCreated();
    }
}
