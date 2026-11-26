// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Vm} from "forge-std/Vm.sol";
import {HolderFixture} from "test/box-v2/m2-30/HolderFixture.sol";
import {StarterFixture} from "test/box-v2/m2-33/StarterFixture.sol";

// Real merged implementations with the counterpart doubles documented by their fixture owners.
contract M252HolderEventsTest is HolderFixture {
    function test_paidEventIsGrossIncludingTipAndPausedPEmitsNoPayment() public {
        _move(SYSTEM, ALICE, 100, false);
        _trade(1, 100, false, true); _trade(1, 100, false, false);
        _close(1, 1000);
        vm.recordLogs(); _settle(1, 64);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) if (logs[i].emitter == address(ledger)
            && logs[i].topics[0] == keccak256("BatchSettled(uint256,uint256,uint256,uint256)")) {
            assertEq(logs[i].topics[1], bytes32(uint256(1)));
            assertEq(logs[i].data, abi.encode(uint256(1000), uint256(500), uint256(500))); found = true;
        }
        assertTrue(found);
        p.setPaused(true); vm.recordLogs();
        vm.expectRevert(); ledger.claimFor(1, ALICE);
        logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) assertTrue(logs[i].emitter != address(ledger));
        assertEq(ledger.claimable(1, ALICE), 500);
        p.setPaused(false); vm.recordLogs();
        vm.prank(PUSHER); ledger.claimFor(1, ALICE);
        logs = vm.getRecordedLogs(); found = false;
        for (uint256 i; i < logs.length; ++i) if (logs[i].emitter == address(ledger)
            && logs[i].topics[0] == keccak256("HolderPaid(uint256,address,address,uint256,uint256)")) {
            assertEq(logs[i].topics.length, 4);
            assertEq(logs[i].topics[2], bytes32(uint256(uint160(ALICE))));
            assertEq(logs[i].topics[3], bytes32(uint256(uint160(ALICE))));
            assertEq(logs[i].data, abi.encode(uint256(500), uint256(25))); found = true;
        }
        assertTrue(found); assertEq(p.balanceOf(ALICE), 475); assertEq(p.balanceOf(PUSHER), 25);
    }
}

contract M252StarterEventsTest is StarterFixture {
    function test_progressIsCumulativeAndLoaderNotificationDoesNotImplyChunksOpen() public {
        _make(10, 1000, true, 0, false); vm.recordLogs();
        _seed(); _page(0, 4); _page(4, 6); _complete();
        Vm.Log[] memory logs = vm.getRecordedLogs(); uint256 pages; bool notified; bool funded;
        for (uint256 i; i < logs.length; ++i) {
            bytes32 sig = logs[i].topics[0];
            if (logs[i].emitter == address(loader) && sig == keccak256("StarterProgress(uint32,bytes32)")) {
                (uint32 loaded, bytes32 hash) = abi.decode(logs[i].data, (uint32, bytes32));
                assertEq(loaded, pages == 0 ? 4 : 10); assertEq(hash, suffix[loaded]); ++pages;
            }
            if (logs[i].emitter == address(box) && sig == keccak256("StarterSetLoaded(address)")) {
                assertEq(logs[i].topics[1], bytes32(uint256(uint160(address(loader))))); notified = true;
            }
            if (logs[i].emitter == address(shop) && sig == keccak256("SeedFunded(uint256)")) {
                assertEq(abi.decode(logs[i].data, (uint256)), 1000); funded = true;
            }
        }
        assertEq(pages, 2); assertTrue(notified); assertTrue(funded); assertFalse(box.gateOpen());
        _chunks(); assertTrue(box.gateOpen());
    }
}
