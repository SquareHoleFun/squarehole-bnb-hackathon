// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AlchemistFixture} from "./Fixture.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {BoxRoyaltyRouterV2} from "../../../src/box-v2/BoxRoyaltyRouterV2.sol";
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {IFeeModulesV21} from "../../../src/box-v2/interfaces/IFeeModulesV21.sol";
import {IPileVaultV2} from "../../../src/box-v2/interfaces/IPileVaultV2.sol";
import {Vm} from "forge-std/Vm.sol";

contract AlchemistInboxTest is AlchemistFixture {
    uint256 private constant UNIT = 1e12;
    address private constant DONOR = address(0xD070);
    address private constant STRANGER = address(0xBEEF);

    struct Books {
        uint256 buyers;
        uint256 sellers;
        uint256 fit;
        uint256 platform;
        uint256 depth;
        uint256 backing;
        uint256 buyBack;
    }

    function _startInboxBox(bool sellersOnly) private {
        BoxSpec memory s = _alchemistSpec(1 ether, !sellersOnly, sellersOnly);
        _start(s);
        fees = IFeeModulesV21(address(receiver));
        (address buyersModule,) = fees.sideModule(false);
        (address sellersModule,) = fees.sideModule(true);
        assertEq(buyersModule, sellersOnly ? address(0) : module);
        assertEq(sellersModule, sellersOnly ? module : address(0));
    }

    function _graduateInboxBox(bool sellersOnly) private {
        _startInboxBox(sellersOnly);
        _fill();
        box.graduate();
        receiver.collect(address(0));
        // Clear the real buys' module budget so the next receipt must start its own wait.
        if (!sellersOnly) {
            uint256 pending = fees.modulePendingP(false);
            assertGt(pending, 0);
            assertEq(fees.executeModule(false), pending);
        }
        assertEq(fees.modulePendingP(false), 0);
        assertEq(fees.modulePendingP(true), 0);
        vm.warp(block.timestamp + 1 days);
    }

    function _books() private view returns (Books memory b) {
        b.buyers = fees.modulePendingP(false);
        b.sellers = fees.modulePendingP(true);
        b.fit = receiver.fitOwed();
        b.platform = receiver.platformOwed();
        b.depth = hook.depthBudget();
        b.backing = pm.balanceOf(address(receiver), uint160(address(p)));
        b.buyBack = receiver.buyBackP();
    }

    function _inboxP(uint256 amount) private {
        address inbox = box.royaltyRouter();
        p.mint(DONOR, amount);
        vm.prank(DONOR);
        p.transfer(inbox, amount);
        assertEq(p.balanceOf(inbox), amount, "P enters the inbox first");
        vm.expectCall(address(receiver), abi.encodeCall(IBoxReceiverV2.fundRoyalty, (address(p), amount)), 1);
        assertEq(BoxRoyaltyRouterV2(payable(inbox)).sweepPriceCoin(), amount);
        assertEq(p.balanceOf(inbox), 0, "inbox delivered the whole receipt");
        assertEq(p.allowance(inbox, address(receiver)), 0, "no standing receiver allowance");
    }

    function _assertSplit(Books memory before_, uint256 unit, bool sellersOnly) private view {
        Books memory after_ = _books();
        assertEq(after_.buyers - before_.buyers, sellersOnly ? 0 : 10 * unit, "buyers module gets 10 parts");
        assertEq(after_.sellers, before_.sellers, "royalties never fund sellers");
        assertEq(after_.buyBack - before_.buyBack, sellersOnly ? 10 * unit : 0, "buyers choice owns the 10 parts");
        assertEq(after_.fit - before_.fit, 2 * unit, "FIT gets 2 parts");
        assertEq(after_.platform - before_.platform, unit, "platform gets 1 part");
        assertEq(after_.depth - before_.depth, 2 * unit, "depth gets 2 parts");
        assertEq(after_.backing - before_.backing, 13 * unit, "retained debts have exact P claims");
        assertEq(receiver.royaltyHeldP(), 0);
        assertEq(p.balanceOf(box.royaltyRouter()), 0);
        assertEq(p.balanceOf(address(receiver)), 0);
        _booked();
    }

    function _assertWait(uint256 since) private {
        uint256 pending = fees.modulePendingP(false);
        assertGt(pending, 0);
        vm.warp(since + 7 days - 1);
        vm.prank(STRANGER);
        vm.expectRevert(bytes4(keccak256("ConversionTriggerOnly()")));
        fees.executeModule(false);
        assertEq(fees.modulePendingP(false), pending, "early caller cannot spend");
        vm.warp(since + 7 days);
        vm.prank(STRANGER);
        assertEq(fees.executeModule(false), pending, "fallback opens exactly seven days after booking");
        assertEq(fees.modulePendingP(false), 0);
        _noResidue();
        _booked();
    }

    function test_ALCH01_inboxAfterGraduationSplitsBuyersFeesAndStartsWait() public {
        _graduateInboxBox(false);
        Books memory before_ = _books();
        uint256 since = block.timestamp;
        _inboxP(15 * UNIT);
        _assertSplit(before_, UNIT, false);
        _assertWait(since);
    }

    function testFuzz_ALCH01_inboxSplitConservesAcrossReceipts(uint64 rawUnit, uint8 rawFirst) public {
        _graduateInboxBox(false);
        uint256 unit = bound(uint256(rawUnit), 1, 1e16);
        uint256 first = bound(uint256(rawFirst), 1, 14);
        Books memory before_ = _books();
        // This world carries raw remainders between receipts. Two uneven receipts totaling
        // 15 * unit preserve the initial trade-fee carry and must allocate exactly unit lots.
        _inboxP(first);
        _inboxP(15 * unit - first);
        _assertSplit(before_, unit, false);
    }

    function test_ALCH02_inboxHeldBeforeGraduationBooksOnlyAtGraduation() public {
        _startInboxBox(false);
        _fill();
        receiver.collect(address(0));
        uint256 receivedAt = block.timestamp;
        uint256 graduatedAt = receivedAt + 2 days;
        // Same chain state without royalties isolates graduation's ordinary trade-fee settlement.
        uint256 snapshot = vm.snapshotState();
        vm.warp(graduatedAt);
        box.graduate();
        receiver.collect(address(0));
        Books memory withoutRoyalty = _books();
        assertTrue(vm.revertToState(snapshot));

        Books memory before_ = _books();
        _inboxP(15 * UNIT);
        assertEq(receiver.royaltyHeldP(), 15 * UNIT, "whole receipt held before graduation");
        assertEq(fees.modulePendingP(false), before_.buyers);
        assertEq(fees.modulePendingP(true), before_.sellers);
        assertEq(receiver.fitOwed(), before_.fit);
        assertEq(receiver.platformOwed(), before_.platform);
        assertEq(hook.depthBudget(), before_.depth);
        assertEq(pm.balanceOf(address(receiver), uint160(address(p))), before_.backing + 15 * UNIT);
        receiver.collect(address(0));
        assertEq(receiver.royaltyHeldP(), 15 * UNIT, "collect cannot book held royalties early");
        vm.warp(graduatedAt);
        box.graduate();
        receiver.collect(address(0));
        _assertSplit(withoutRoyalty, UNIT, false);
        vm.warp(receivedAt + 7 days);
        vm.prank(STRANGER);
        vm.expectRevert(bytes4(keccak256("ConversionTriggerOnly()")));
        fees.executeModule(false);
        _assertWait(graduatedAt);
    }

    function test_ALCH03_sellersOnlyAlchemistNeverReceivesInboxP() public {
        _graduateInboxBox(true);
        Books memory before_ = _books();
        _inboxP(15 * UNIT);
        _assertSplit(before_, UNIT, true);
        assertEq(fees.executeModule(true), 0);
    }

    function test_ALCH04_failureSendsHeldAndLateInboxPToClaimPot() public {
        _startInboxBox(false);
        _buy(box.raise() / 10);
        receiver.collect(address(0));
        uint256 snapshot = vm.snapshotState();
        vm.warp(box.deadline());
        box.fail();
        (uint256 potWithoutRoyalty, uint256 sharesWithoutRoyalty) = box.claimState();
        Books memory withoutRoyalty = _books();
        assertTrue(vm.revertToState(snapshot));

        _inboxP(15 * UNIT);
        assertEq(receiver.royaltyHeldP(), 15 * UNIT);
        vm.warp(box.deadline());
        box.fail();
        (uint256 pot, uint256 shares) = box.claimState();
        assertEq(pot, potWithoutRoyalty + 15 * UNIT, "whole held P joins claim pot");
        assertEq(shares, sharesWithoutRoyalty);
        assertEq(receiver.royaltyHeldP(), 0);
        assertEq(fees.modulePendingP(false), 0);
        assertEq(fees.modulePendingP(true), 0);
        assertEq(receiver.fitOwed(), withoutRoyalty.fit);
        assertEq(receiver.platformOwed(), withoutRoyalty.platform);
        _inboxP(30 * UNIT);
        (uint256 latePot,) = box.claimState();
        assertEq(latePot, pot + 30 * UNIT, "late inbox P also joins claim pot unsplit");
        assertEq(receiver.royaltyHeldP(), 0);
        assertEq(fees.modulePendingP(false), 0);
        assertEq(fees.modulePendingP(true), 0);
        assertEq(receiver.fitOwed(), withoutRoyalty.fit);
        assertEq(receiver.platformOwed(), withoutRoyalty.platform);
        assertEq(gold.balanceOf(box.vault()), 0);
        assertEq(_claimBuyer(), latePot, "the holder can actually claim the added P");
        _noResidue();
        _booked();
    }

    function test_ALCH05_executeBuyersInboxBudgetConvertsRouteAndEmitsPileConverted() public {
        _graduateInboxBox(false);
        _inboxP(15 * UNIT);
        uint256 pending = fees.modulePendingP(false);
        assertEq(pending, 10 * UNIT);
        Books memory before_ = _books();
        uint256 inputBefore = p.balanceOf(address(v3));
        uint256 middleBefore = w.balanceOf(address(v2));
        uint256 middleSourceBefore = w.balanceOf(address(v3));
        uint256 outputBefore = gold.balanceOf(address(v2));
        uint256 pileBefore = gold.balanceOf(box.vault());
        vm.recordLogs();
        assertEq(fees.executeModule(false), pending);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 converted = gold.balanceOf(box.vault()) - pileBefore;
        assertGt(converted, 0);
        assertEq(p.balanceOf(address(v3)) - inputBefore, pending, "P paid into first hop");
        assertGt(w.balanceOf(address(v2)) - middleBefore, 0, "intermediate coin reaches second hop");
        assertEq(w.balanceOf(address(v2)) - middleBefore, middleSourceBefore - w.balanceOf(address(v3)));
        assertEq(outputBefore - gold.balanceOf(address(v2)), converted, "last hop funds exact pile increase");
        uint256 events;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != keccak256("PileConverted(address,address,address,uint256,uint256)")) continue;
            ++events;
            assertEq(logs[i].emitter, module);
            assertEq(logs[i].topics.length, 4);
            assertEq(logs[i].topics[1], bytes32(uint256(uint160(address(receiver)))));
            assertEq(logs[i].topics[2], bytes32(uint256(uint160(box.vault()))));
            assertEq(logs[i].topics[3], bytes32(uint256(uint160(address(gold)))));
            assertEq(logs[i].data, abi.encode(pending, converted));
        }
        assertEq(events, 1, "one exact PileConverted receipt");
        assertEq(fees.modulePendingP(false), 0);
        assertEq(pm.balanceOf(address(receiver), uint160(address(p))), before_.backing - pending);
        assertEq(receiver.fitOwed(), before_.fit);
        assertEq(receiver.platformOwed(), before_.platform);
        assertEq(hook.depthBudget(), before_.depth);
        assertEq(fees.executeModule(false), 0, "no second spend");
        assertEq(gold.balanceOf(box.vault()), pileBefore + converted);
        _noResidue();
        _booked();
    }

    function test_ALCH06_directPileCoinGiftJoinsRedeemablePileWithoutInbox() public {
        _graduateInboxBox(false);
        IPileVaultV2 pile = IPileVaultV2(box.vault());
        Books memory before_ = _books();
        uint256 pileBefore = gold.balanceOf(address(pile));
        uint256 burn = token.balanceOf(address(buyer)) / 2;
        uint256 quoteBefore = pile.quoteRedeem(burn);
        uint256 gift = 17 ether;
        gold.mint(DONOR, gift);
        vm.prank(DONOR);
        gold.transfer(address(pile), gift);
        assertEq(gold.balanceOf(address(pile)), pileBefore + gift);
        uint256 expected = (pileBefore + gift) * burn / token.totalSupply() * 9500 / 10000;
        assertEq(pile.quoteRedeem(burn), expected, "gift is included in the pro-rata quote");
        assertGt(expected, quoteBefore);
        assertEq(gold.balanceOf(box.royaltyRouter()), 0);
        assertEq(p.balanceOf(box.royaltyRouter()), 0);
        assertEq(abi.encode(_books()), abi.encode(before_), "gift changes no receiver or depth debt");
        assertEq(receiver.royaltyHeldP(), 0);
        vm.startPrank(address(buyer));
        token.approve(address(pile), burn);
        assertEq(pile.redeem(burn, expected, address(buyer)), expected);
        vm.stopPrank();
        assertEq(gold.balanceOf(address(buyer)), expected);
        assertEq(gold.balanceOf(address(pile)), pileBefore + gift - expected);
    }
}
