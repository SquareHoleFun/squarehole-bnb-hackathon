// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M260Measure} from "./Measure.sol";
import {BoxSpec} from "../../../../src/box-v2/interfaces/SpecTypes.sol";
import {IHolderLedgerV2, IHolderTokenHistoryV2} from "../../../../src/box-v2/interfaces/IHolderLedgerV2.sol";
import {ReleaseConstantsV2 as C} from "../../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";
import {IBoxHolderBatchNoticeV2} from "../../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {CQATrader} from "../../cq11-a/Fixture.sol";
import {WalletDriver} from "../../m2-31/Trade.t.sol";
import {M260NoticeCaller} from "./NoticeBudget.sol";

contract M260HoldersTest is M260Measure {
    function _holderBox(uint8 decimals) internal {
        BoxSpec memory s = _holders(); s.creatorBuy = s.raise / 100;
        if (decimals != 0) {
            (BoxSpec memory priced,) = _priceSpec(3, 3, decimals);
            s.pricing = priced.pricing; s.raise = priced.raise; s.creatorBuy = s.raise / 100;
        }
        _start(s); ledger = IHolderLedgerV2(box.roleAddress(17));
    }

    function test_firstReceiptTransferAndBurn() public {
        _holderBox(0);
        WalletDriver driver = new WalletDriver(pm, ALICE); vm.deal(address(driver), box.raise());
        _measure("first wallet buy", address(driver), address(this),
            abi.encodeCall(driver.buy, (hook.poolKey(), box.raise() / 100, layout.sqrtPriceEndX96)), 4000000);
        uint256 held = token.balanceOf(ALICE); assertGt(held, 0);
        _measure("first receipt transfer", address(token), ALICE,
            abi.encodeCall(token.transfer, (address(0xb0b), held / 4)), 3000000);
        vm.prank(ALICE); token.approve(address(this), held / 4);
        _measure("transferFrom", address(token), address(this),
            abi.encodeCall(token.transferFrom, (ALICE, address(0xb0b), held / 4)), 3000000);
        _measure("burn", address(token), ALICE, abi.encodeCall(token.burn, (held / 4)), 3000000);
        assertEq(token.balanceOf(ALICE), held - 3 * (held / 4));
    }

    function test_fourSteadyTradeKinds() public {
        _holderBox(0); CQATrader trader = new CQATrader(pm); vm.deal(address(trader), box.raise());
        trader.trade(hook.poolKey(), true, -int256(box.raise() / 100), layout.sqrtPriceEndX96);
        vm.prank(address(trader)); ledger.register();
        for (uint256 i; i < 4; ++i) {
            bool buy = i < 2; bool exactOut = i % 2 == 1;
            uint256 amount = buy ? (exactOut ? token.balanceOf(address(trader)) / 100 : box.raise() / 1000)
                : (exactOut ? box.raise() / 100000 : token.balanceOf(address(trader)) / 100);
            _measure(string.concat(buy ? "buy " : "sale ", exactOut ? "exact out" : "exact in"),
                address(trader), address(this), abi.encodeCall(trader.trade, (hook.poolKey(), buy,
                    exactOut ? int256(amount) : -int256(amount), buy ? layout.sqrtPriceEndX96 : layout.sqrtPriceStartX96)),
                4000000);
        }
        assertGt(hook.tradeBatch(1).tradeUnits, 0); assertGt(hook.tradeBatch(2).tradeUnits, 0);
    }

    function test_strictCallbackHeadroomWithLongHistory() public {
        _holderBox(0);
        vm.pauseGasMetering();
        vm.prank(CREATOR); token.transfer(ALICE, 10000);
        for (uint256 i; i < 1024; ++i) {
            vm.prank(i % 2 == 0 ? ALICE : CREATOR);
            token.transfer(i % 2 == 0 ? CREATOR : ALICE, 1);
        }
        vm.resumeGasMetering();
        IHolderTokenHistoryV2 history = IHolderTokenHistoryV2(address(token));
        uint256 checkpoint = history.holderCheckpoint();
        (, uint256 noticeTx) = _measure("strict first notice 1024 history", address(ledger), address(hook),
            abi.encodeCall(IBoxHolderBatchNoticeV2.onTradeFeeBatch, (101, address(this), true, 1000)), 2000000);
        // Transaction overhead makes this stricter than measuring only the callee frame.
        assertLe(noticeTx * 2, C.HOLDER_NOTICE_GAS, "production notice needs twice strict case");
        emit log_named_uint("production notice cap", C.HOLDER_NOTICE_GAS);
        emit log_named_uint("required notice cap upper bound", noticeTx * 2);
        // Probe half the production allowance against the authenticated real ledger and token.
        vm.etch(address(hook), address(new M260NoticeCaller()).code);
        _cold();
        bytes memory notice = abi.encodeCall(IBoxHolderBatchNoticeV2.onTradeFeeBatch, (103, address(this), true, 1000));
        assertTrue(M260NoticeCaller(address(hook)).notice(address(ledger), notice, C.HOLDER_NOTICE_GAS / 2));
        (, uint256 hintTx) = _measure("strict token hint", address(ledger), address(token),
            abi.encodeCall(ledger.onTokenCheckpoint, (checkpoint, ALICE, CREATOR)), 600000);
        assertLe(hintTx * 2, C.TOKEN_SETTLEMENT_GAS, "token hint needs twice strict case");
    }

    function test_collectSettleClaimAndResidueNative() public { _payout(0); }
    function test_collectSettleClaimAndResidue6Decimals() public { _payout(6); }
    function test_collectSettleClaimAndResidue8Decimals() public { _payout(8); }
    function test_collectSettleClaimAndResidue18Decimals() public { _payout(18); }
    function _payout(uint8 decimals) private {
        _holderBox(decimals); _trade();
        uint256 money = _money();
        _measure("collect two sides", address(receiver), address(this), abi.encodeCall(receiver.collect, (address(0))), 5000000);
        for (uint256 id = 1; id <= 2; ++id) {
            _measure("settle small batch", address(ledger), address(this), abi.encodeCall(ledger.settleBatch, (id, 64)), 5000000);
            uint256 credit = ledger.claimable(id, CREATOR);
            if (id == 1) assertGt(credit, 0); else assertEq(credit, 0);
            uint256 beforeP = _balance(CREATOR);
            if (credit != 0) _measure("holder self claim", address(ledger), CREATOR, abi.encodeCall(ledger.claim, (id, CREATOR)), 1000000);
            assertEq(_balance(CREATOR) - beforeP, credit); assertEq(ledger.claimable(id, CREATOR), 0);
            _measure("flush residue", address(ledger), address(this), abi.encodeCall(ledger.flushResidue, (id)), 1000000);
        }
        assertEq(_pClaims(address(ledger)), 0); assertEq(_money(), money); _booked();
    }

    function test_settlementPages64Holders64Notices1024History() public {
        _holderBox(0); _buy(box.raise() / 5); vm.pauseGasMetering();
        for (uint256 i; i < 63; ++i) { vm.prank(CREATOR); token.transfer(address(uint160(0x10000 + i)), 10000); }
        for (uint256 i; i < 1024; ++i) {
            vm.prank(i % 2 == 0 ? address(0x10000) : CREATOR);
            token.transfer(i % 2 == 0 ? CREATOR : address(0x10000), 1);
        }
        // Retire creation notices; measure a clean batch with exactly 64 new trade notices.
        receiver.collect(address(0)); uint256 id = hook.currentTradeBatch(true);
        for (uint256 i; i < 64; ++i) _buy(box.raise() / 100000);
        receiver.collect(address(0)); assertGt(receiver.holderBatchPaid(id), 0, "backlog must have real funding");
        assertEq(IHolderTokenHistoryV2(address(token)).holderCount(), 64);
        vm.resumeGasMetering();
        uint256 total; uint256 maximum; uint256 pages;
        bool complete;
        while (!complete) {
            (bytes memory result, uint256 used) = _measure("settle 64 pairs", address(ledger), address(this),
                abi.encodeCall(ledger.settleBatch, (id, 64)), 5000000);
            complete = abi.decode(result, (bool)); total += used; ++pages;
            if (used > maximum) maximum = used;
            if (!complete) assertEq(ledger.claimable(id, CREATOR), 0, "no premature payout");
            assertLe(pages, 64);
        }
        assertEq(pages, 64);
        uint256 allocated = ledger.claimable(id, CREATOR);
        for (uint256 i; i < 63; ++i) allocated += ledger.claimable(id, address(uint160(0x10000 + i)));
        (,,, uint256 residue) = ledger.batchState(id);
        assertEq(allocated + residue, receiver.holderBatchPaid(id));
        emit log_named_uint("settlement maximum page", maximum); emit log_named_uint("settlement total 4096 pairs", total);
    }

    function test_settlement64FreshCreditsInOnePage() public { _freshCredits(64, 12000000); }
    function test_keeper16PairPagesWithFreshCredits() public { _freshCredits(16, 3000000); }
    function _freshCredits(uint256 steps, uint256 budget) private {
        _holderBox(0); _buy(box.raise() / 5); // Fill D6 before measuring positive fresh credits.
        uint256 share = token.balanceOf(CREATOR) / 64;
        for (uint256 i; i < 63; ++i) { vm.prank(CREATOR); token.transfer(address(uint160(0x10000 + i)), share); }
        receiver.collect(address(0)); uint256 id = hook.currentTradeBatch(true);
        _buy(box.raise() / 1000); receiver.collect(address(0));
        bool complete; uint256 pages;
        while (!complete) {
            (bytes memory result,) = _measure(steps == 64 ? "settle 64 fresh credits" : "settle 16 fresh credits",
                address(ledger), address(this), abi.encodeCall(ledger.settleBatch, (id, steps)), budget);
            complete = abi.decode(result, (bool)); ++pages; assertLe(pages, 64 / steps);
        }
        assertEq(pages, 64 / steps);
        uint256 allocated = ledger.claimable(id, CREATOR); assertGt(allocated, 0);
        for (uint256 i; i < 63; ++i) {
            uint256 credit = ledger.claimable(id, address(uint160(0x10000 + i))); assertGt(credit, 0); allocated += credit;
        }
        (,,, uint256 residue) = ledger.batchState(id); assertEq(allocated + residue, receiver.holderBatchPaid(id));
    }
}
