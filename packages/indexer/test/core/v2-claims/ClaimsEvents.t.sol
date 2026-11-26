// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {HolderFixture} from "test/box-v2/m2-30/HolderFixture.sol";
import {ItemAccountingBase} from "test/box-v2/m3-20/Accounting.t.sol";
import {ReceiverFixture} from "test/box-v2/cq11-b/ReceiverFixture.sol";
import {FailureTestBase} from "test/box-v2/m1-31/FailureTestBase.sol";

// Capture real implementation payments, with the upstream fixtures' counterpart doubles.
// The named bytes are decoded into events.json by capture-events.mjs; no filesystem cheatcodes.
contract ClaimsHolderEventsTest is HolderFixture {
    function test_captureHolder() public {
        _move(SYSTEM, ALICE, 100, false);
        _trade(1, 100, false, true);
        _close(1, 1000);
        _settle(1, 64);
        vm.recordLogs();
        vm.prank(ALICE);
        assertEq(ledger.claim(1, BOB), 1000);
        emit log_named_bytes("holder", abi.encode(vm.getRecordedLogs()));
        assertEq(p.balanceOf(BOB), 1000);
        assertEq(ledger.claimable(1, ALICE), 0);
    }
}

contract ClaimsItemEventsTest is ItemAccountingBase {
    function test_captureItem() public {
        j.fund(1, 2, 0, 40);
        j.graduate();
        bytes32 key = _key(1);
        j.request(key);
        j.deliver(key, 1, ALICE);
        _page(32);
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        uint256 beforeP = BOB.balance;
        vm.recordLogs();
        vm.prank(ALICE);
        assertEq(ledger.claim(ids, BOB), 10);
        emit log_named_bytes("item", abi.encode(vm.getRecordedLogs()));
        assertEq(BOB.balance - beforeP, 10);
    }
}

contract ClaimsCreatorEventsTest is ReceiverFixture {
    function test_captureCreator() public {
        _fees(1500, 0);
        r.collect(address(0));
        coord.graduation(r);
        uint256 amount = r.creatorP();
        assertGt(amount, 0);
        vm.recordLogs();
        vm.prank(PAYEE);
        assertEq(r.claimCreator(address(p), address(0xB0B)), amount);
        emit log_named_bytes("creator", abi.encode(vm.getRecordedLogs()));
        assertEq(p.balanceOf(address(0xB0B)), amount);
    }
}

contract ClaimsFailureEventsTest is FailureTestBase {
    function test_captureFailure() public {
        _fail(101, 100);
        vm.recordLogs();
        assertEq(_claim(ALICE, 33, BOB), 33);
        emit log_named_bytes("failure", abi.encode(vm.getRecordedLogs()));
        assertEq(_pot(), 68);
        assertEq(_left(), 67);
    }

    function test_captureNoBuyer() public {
        _fail(101, 0);
        _fund(p, address(box), 19);
        assertEq(box.quoteClaim(0), 101);
        vm.recordLogs();
        assertEq(_claim(CREATOR, 0, BOB), 101);
        emit log_named_bytes("no_buyer", abi.encode(vm.getRecordedLogs()));
        assertEq(_pot(), 19);
    }
}
