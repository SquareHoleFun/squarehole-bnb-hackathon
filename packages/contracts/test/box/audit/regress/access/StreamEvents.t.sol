// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {AuditRegressEventChecks, Vm} from "./EventChecks.sol";
import {S8World, BoxItemStreamHarness} from "../../../s8/BoxS8World.sol";

/// Real stream methods; S8World supplies deterministic custody and pending-fee views (150 raw T -> 13/item).
contract AuditRegressStreamEventsReviewTest is AuditRegressEventChecks {
    S8World internal w;
    BoxItemStreamHarness internal s;
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant CAROL = address(0xCA401);

    function setUp() public {
        w = new S8World(10, 1);
        w.boot();
        s = w.stream();
    }

    function test_AR21_E61_E65_E66_E67_streamFundingStartBurnAndRefusalEvents() public {
        w.fee(150);
        vm.recordLogs();
        w.collect();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        _event(logs, address(s), "Funded(uint256)", "", abi.encode(uint256(130)));
        _event(logs, address(s), "Burned(uint256)", "", abi.encode(uint256(130)));
        assertEq(w.token().totalSupply(), 0);
        vm.recordLogs();
        w.graduate(keccak256("stream.word"));
        _event(vm.getRecordedLogs(), address(s), "Started(uint256)", "", abi.encode(uint256(130)));
        assertEq(s.startValue(), 130);
        w.gift(37);
        w.token().setRefuseBurns(true);
        vm.recordLogs();
        s.burn();
        logs = vm.getRecordedLogs();
        _event(logs, address(s), "BurnRefused(uint256)", "", abi.encode(uint256(37)));
        _noEvent(logs, address(s), "Burned(uint256)");
        assertEq(w.token().balanceOf(address(s)), 37);
        w.token().setRefuseBurns(false);
        vm.recordLogs();
        s.burn();
        _event(vm.getRecordedLogs(), address(s), "Burned(uint256)", "", abi.encode(uint256(37)));
    }

    function test_AR21_E62_E64_E68_creditRepairAndClaimEvents() public {
        w.graduate(keccak256("stream.word"));
        w.draw();
        uint256 id = w.openDraw(ALICE);
        w.fee(1500);
        w.transferSkippingObserver(ALICE, BOB, id);
        vm.recordLogs();
        w.transfer(BOB, CAROL, id);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        _event(logs, address(s), "CheckpointRepaired(uint256,address,address)", abi.encode(id), abi.encode(ALICE, BOB));
        _event(logs, address(s), "Credited(address,uint256,uint256)", abi.encode(ALICE, id), abi.encode(uint256(130)));
        assertEq(s.owedOf(ALICE), 130);
        assertEq(s.owedOf(BOB), 0);
        w.collect();
        vm.recordLogs();
        vm.prank(ALICE);
        uint256 paid = s.claim(new uint256[](0), CAROL);
        _event(
            vm.getRecordedLogs(),
            address(s),
            "Claimed(address,address,uint256)",
            abi.encode(ALICE, CAROL),
            abi.encode(uint256(129))
        );
        assertEq(paid, 129);
        assertEq(w.token().balanceOf(CAROL), 129);
        assertEq(s.owedOf(ALICE), 1);
        vm.recordLogs();
        s.claimFor(ALICE, new uint256[](0));
        _noEvent(vm.getRecordedLogs(), address(s), "Claimed(address,address,uint256)");
    }

    function test_AR21_E63_terminalTicketCreditEvent() public {
        w.take(2);
        w.graduate(keccak256("stream.word"));
        w.fee(1500);
        w.enterTerminal(false);
        vm.recordLogs();
        w.releaseTickets(ALICE, 2);
        _event(
            vm.getRecordedLogs(),
            address(s),
            "TicketsCredited(address,uint256,uint256)",
            abi.encode(ALICE),
            abi.encode(uint256(2), uint256(260))
        );
        assertEq(s.owedOf(ALICE), 260);
        assertEq(s.outsideCount(), 0);
    }
}
