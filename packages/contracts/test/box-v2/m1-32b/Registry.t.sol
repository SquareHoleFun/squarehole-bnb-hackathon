// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M132aBase} from "../m1-32a/M132aBase.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {IBoxRegistryV2} from "../../../src/box-v2/interfaces/IBoxRegistryV2.sol";
import {Vm} from "forge-std/Vm.sol";

contract RegistryCQ11Test is M132aBase {
    function test_recordsEveryRoleAndHashAndEmitsTheExactSpecOnce() public {
        BoxSpec memory s = _hiddenSpec();
        vm.recordLogs();
        BoxCoordinatorV2 c = _create(s);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 specs;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(registry) && logs[i].topics[0] == keccak256("BoxSpec(uint256,bytes)")) {
                ++specs;
                assertEq(abi.decode(logs[i].data, (bytes)), abi.encode(s));
            }
        }
        assertEq(specs, 1);
        IBoxRegistryV2.BoxRecordV2 memory record = registry.recordOf(0);
        (, uint256 block_, bytes32 template, bytes32 hash, bytes32 recordHash) = registry.entry(0);
        assertEq(recordHash, keccak256(abi.encode(record)));
        assertEq(block_, block.number);
        assertEq(template, factory.templateIdOf(s));
        assertEq(hash, keccak256(abi.encode(s)));
        assertEq(record.creator, CREATOR);
        assertEq(record.raise, s.raise);
        for (uint256 role; role < 24; ++role) {
            assertEq(record.contracts[role], c.roleAddress(role));
            assertEq(registry.roleOf(0, role), c.roleAddress(role));
            bytes32 codeHash = c.roleAddress(role) == address(0) ? bytes32(0) : c.roleAddress(role).codehash;
            assertEq(record.codeHashes[role], codeHash);
        }
    }

    function test_onlyFactoryAndNeverTwice() public {
        BoxSpec memory s = _spec();
        BoxCoordinatorV2 c = _create(s);
        vm.expectRevert(abi.encodeWithSelector(IBoxRegistryV2.NotFactory.selector, address(this)));
        registry.record(address(c), 0, abi.encode(s));
        vm.expectRevert(abi.encodeWithSelector(IBoxRegistryV2.AlreadyRecorded.selector, address(c)));
        vm.prank(address(factory));
        registry.record(address(c), 0, abi.encode(s));
        assertEq(registry.boxCount(), 1);
    }

    function test_unknownIdsRolesAndDirectoryRefuse() public {
        vm.expectRevert(abi.encodeWithSelector(IBoxRegistryV2.UnknownBox.selector, 0));
        registry.coordinatorOf(0);
        assertEq(registry.registryAt(0), address(registry));
        vm.expectRevert(abi.encodeWithSelector(IBoxRegistryV2.UnknownRegistry.selector, uint8(1)));
        registry.registryAt(1);
        _create(_spec());
        vm.expectRevert(abi.encodeWithSelector(IBoxRegistryV2.UnknownRole.selector, 24));
        registry.roleOf(0, 24);
    }
}
