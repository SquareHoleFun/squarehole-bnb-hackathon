// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {BoxVaultV2} from "../../../src/box-v2/BoxVaultV2.sol";
import {CallbackSpike, CappedNotice, BurningNotice} from "./CallbackSpike.sol";

contract M300CallbackGasTest is Test {
    function test_R6_freshRecordsHaveDoubleHeadroom() public {
        uint256 cap = new BoxVaultV2(address(0)).ITEM_LEDGER_GAS();
        CallbackSpike spike = new CallbackSpike();
        uint256 count = spike.CANDIDATE_BATCH();
        uint256 before_ = gasleft(); spike.record(count); uint256 cost = before_ - gasleft();
        emit log_named_uint("fresh record cost", cost);
        assertGe(cap, 2 * cost, "CQ7 M3-3/5/7: reduce batch or resolve stipend");
        // A different deployment ensures the capped invocation also starts with fresh slots.
        CallbackSpike fresh = new CallbackSpike();
        assertTrue(new CappedNotice().notice(address(fresh), count, cap));
        assertEq(fresh.ticketStart(count), 4);
    }
    function test_R6_cappedFailureNoLedgerAndLowGasRollback() public {
        uint256 cap = new BoxVaultV2(address(0)).ITEM_LEDGER_GAS();
        CappedNotice n = new CappedNotice(); BurningNotice burner = new BurningNotice();
        assertFalse(n.notice(address(burner), 1, cap)); assertEq(n.calls(), 1);
        assertTrue(n.notice(address(0), 50, cap)); assertEq(n.calls(), 1);
        vm.expectRevert(); n.notice{gas: 200_000}(address(burner), 1, cap);
        assertEq(n.calls(), 1);
    }
}
