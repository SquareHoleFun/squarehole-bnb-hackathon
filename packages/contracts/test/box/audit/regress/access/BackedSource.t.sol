// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditRegressEventChecks} from "./EventChecks.sol";
import {CoreBox0BackupBase} from "../../../backup/CoreBox0BackupBase.sol";
import {BoxBackedSource} from "../../../../../src/box/randomness/BoxBackedSource.sol";
import {BackedSourcePins} from "../../../../../src/box/randomness/BackedSourcePins.sol";
import {PinnedBackedSource} from "../../../randomness/utils/PinnedBackedSource.sol";

/// F143 extends the original AR-10/AR-21 inventory: box 0 now reads the pinned backed source.
/// The original DrandSource tests remain; these exercise its wrapper and all three added events.
/// Header/hash injection supplies the chain proof, not the source's state or event output.
/// forge-config: default.evm_version = "osaka"
contract AuditRegressBackedSourceTest is CoreBox0BackupBase, AuditRegressEventChecks {
    function test_AR10_F143_backedSourcePinsAddressRuntimeAndChain() public {
        vm.chainId(1);
        assertEq(keccak256(type(BoxBackedSource).creationCode), BackedSourcePins.INIT_CODE_HASH);
        assertEq(address(src), PinnedBackedSource.predict());
        assertEq(tickets.source(), address(src));
        assertEq(address(src.DRAND()), address(drand));
        assertTrue(BackedSourcePins.isPinned(address(src)));
        address twin = address(0xB0B);
        vm.etch(twin, address(src).code);
        assertFalse(BackedSourcePins.isPinned(twin));
        vm.chainId(11_155_111);
        assertTrue(BackedSourcePins.isPinned(address(src)));
        vm.chainId(31337);
        assertFalse(BackedSourcePins.isPinned(address(src)));
        vm.chainId(1);
        vm.etch(address(src), hex"ef01000000000000000000000000000000000000000001");
        assertFalse(BackedSourcePins.isPinned(address(src)));
    }

    function test_AR21_E78_E79_E80_F143_backedRequestStartAndFixEvents() public {
        address consumer = address(0xA11CE);
        address starter = address(0xB0B);
        address fixer = address(0xCA401);
        vm.warp(src.roundTime(r0) - 12);
        vm.deal(consumer, 7);
        vm.recordLogs();
        vm.prank(consumer);
        assertEq(src.request{value: 7}(17), r0);
        _event(
            vm.getRecordedLogs(),
            address(src),
            "Requested(address,uint256,uint256,uint256)",
            abi.encode(consumer, uint256(17)),
            abi.encode(r0, uint256(7))
        );
        assertEq(address(src).balance, 0);
        assertEq(drand.bountyOf(r0), 7);
        vm.warp(_startable(r0));
        vm.roll(block.number + 1);
        vm.recordLogs();
        uint256 target = _start(r0, starter);
        _event(
            vm.getRecordedLogs(),
            address(src),
            "BackupStarted(uint256,uint256,address)",
            abi.encode(r0, starter),
            abi.encode(target)
        );
        assertEq(target, block.number + 256);
        (uint64 startedAt, uint64 storedTarget, uint64 fixedAt,) = src.backupOf(r0);
        assertEq(startedAt, block.timestamp);
        assertEq(storedTarget, target);
        assertEq(fixedAt, 0);
        _advance(257);
        bytes32 mix = keccak256("audit regression backup mix");
        bytes memory header = _mine(target, mix);
        vm.recordLogs();
        vm.prank(fixer);
        src.fixBackup(r0, header);
        _event(
            vm.getRecordedLogs(),
            address(src),
            "BackupFixed(uint256,uint256,bytes32,address)",
            abi.encode(r0, fixer),
            abi.encode(target, mix)
        );
        (bytes32 word, uint64 readyAt) = src.wordOf(consumer, 17);
        assertEq(word, keccak256(abi.encode(src.BACKUP_TAG(), mix, keccak256(abi.encode(consumer, uint256(17))))));
        assertEq(readyAt, block.timestamp);
        vm.recordLogs();
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.BackupAlreadyFixed.selector, r0));
        src.fixBackup(r0, header);
        _noEvent(vm.getRecordedLogs(), address(src), "BackupFixed(uint256,uint256,bytes32,address)");
    }
}
