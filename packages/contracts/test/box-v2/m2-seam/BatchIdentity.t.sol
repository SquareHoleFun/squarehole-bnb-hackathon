// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CQ11AFixture} from "../cq11-a/Fixture.sol";

// Local ABI keeps the red test executable before the additive shapes exist.
interface BatchHook {
    function currentTradeBatch(bool buy) external view returns (uint256);
    function tradeBatch(uint256 id) external view returns (uint256 units, uint256 protocolUnits, uint256 netP, bool closed);
}

contract NoticeProbe {
    bool public refuse;
    uint256 public notices;
    uint256 public lastBatch;
    uint256 public lastUnits;
    function setRefuse(bool value) external { refuse = value; }
    function onTradeFeeBatch(uint256 batchId, address, bool, uint256 units) external {
        require(!refuse, "missed notice");
        ++notices;
        lastBatch = batchId;
        lastUnits = units;
    }
}

contract BatchIdentityTest is CQ11AFixture {
    function test_B1_missedNoticeKeepsUnitsAndBatchIdentity() public {
        NoticeProbe ledger = new NoticeProbe();
        // Optional M2 tail, after the unchanged 211-byte M1 arguments.
        vm.etch(address(hook), bytes.concat(address(hook).code, abi.encodePacked(address(ledger))));
        _open();
        ledger.setRefuse(true);
        _buy(RAISE / 10);
        ledger.setRefuse(false);
        _buy(RAISE / 10);
        assertEq(ledger.notices(), 1, "B1: real hook must call the batch notice");
        BatchHook h = BatchHook(address(hook));
        assertEq(ledger.lastBatch(), h.currentTradeBatch(true));
        (uint256 units,,, bool closed) = h.tradeBatch(ledger.lastBatch());
        assertGt(units, ledger.lastUnits(), "failed notice remains in denominator");
        assertFalse(closed);
        uint256 id = ledger.lastBatch();
        receiver.harvest(hook);
        (uint256 frozen,,, bool done) = h.tradeBatch(id);
        assertTrue(done);
        assertEq(frozen, units);
        assertEq(h.currentTradeBatch(true), id + 2);
    }

    function test_B1_sellerMissAndFailureCloseRetainBothSides() public {
        NoticeProbe ledger = new NoticeProbe();
        vm.etch(address(hook), bytes.concat(address(hook).code, abi.encodePacked(address(ledger))));
        _open(); _buy(RAISE / 3);
        ledger.setRefuse(true);
        trader.trade(key, false, -int256(t.balanceOf(address(trader)) / 10), layout.sqrtPriceStartX96);
        BatchHook h = BatchHook(address(hook));
        (uint256 sold,, uint256 paid, bool done) = h.tradeBatch(2);
        assertGt(sold, 0); assertEq(paid, 0, "curve T fees burn instead of paying P"); assertFalse(done);
        assertEq(ledger.notices(), 1, "seller notice failed, buy succeeded");
        coordinator.exec(address(hook), abi.encodeCall(hook.close, ()));
        (uint256 frozen,, uint256 finalP, bool closed) = h.tradeBatch(2);
        assertEq(frozen, sold); assertEq(finalP, paid); assertTrue(closed);
        (,,, bool buyersClosed) = h.tradeBatch(1); assertTrue(buyersClosed);
        uint256 next = h.currentTradeBatch(false);
        coordinator.exec(address(hook), abi.encodeCall(hook.close, ()));
        assertEq(h.currentTradeBatch(false), next, "late close does not manufacture another batch");
        receiver.harvest(hook);
        (uint256 afterUnits,, uint256 afterP,) = h.tradeBatch(2);
        assertEq(afterUnits, frozen); assertEq(afterP, finalP);
    }

    function test_B1_bootstrapDoesNotHideTheFollowingCreatorBuy() public {
        NoticeProbe ledger = new NoticeProbe();
        vm.etch(address(hook), bytes.concat(address(hook).code, abi.encodePacked(address(ledger))));
        router.trade(key, true, -int256(RAISE / 10000), layout.sqrtPriceEndX96);
        assertEq(ledger.notices(), 0, "bootstrap is protocol money");
        router.trade(key, true, -int256(RAISE / 1000), layout.sqrtPriceEndX96);
        assertEq(ledger.notices(), 1, "subsequent creator buy is a user trade");
        (uint256 users, uint256 protocol,,) = BatchHook(address(hook)).tradeBatch(1);
        assertGt(users, 0); assertGt(protocol, 0);
    }

    function test_B3_migrationAndDeepenPreserveSourceReceipts() public {
        NoticeProbe ledger = new NoticeProbe();
        vm.etch(address(hook), bytes.concat(address(hook).code, abi.encodePacked(address(ledger))));
        _migrate();
        BatchHook h = BatchHook(address(hook));
        (uint256 units,, uint256 netP, bool closed) = h.tradeBatch(1);
        assertTrue(closed, "migration closes the curve batch");
        assertGt(units, 0);
        assertEq(netP, _claims(address(receiver)), "fees survive migration checkpoint reset");
        uint256 before = _claims(address(receiver));
        vm.roll(block.number + 1);
        receiver.trade(key, true, -int256(RAISE / 100), uint160(1 << 80));
        vm.roll(block.number + 1);
        hook.deepen(address(0));
        receiver.harvest(hook);
        (uint256 userUnits, uint256 protocolUnits, uint256 paid, bool done) = h.tradeBatch(3);
        assertTrue(done);
        assertEq(userUnits, 0, "receiver buy-back never credits holders");
        assertGt(protocolUnits, 0);
        assertEq(paid, _claims(address(receiver)) - before, "deepen fees belong to original batch");
    }
}
