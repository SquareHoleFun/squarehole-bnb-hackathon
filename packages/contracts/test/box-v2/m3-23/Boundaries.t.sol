// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BookingFixture} from "./Fixture.sol";
import {ReceiverArgs} from "../cq11-b/ReceiverFixture.sol";
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

contract ItemBookingBoundariesTest is BookingFixture {
    function _fresh() private {
        ReceiverArgs memory a = _args(5, 1, 1, address(p)); a.itemLedger = address(items); r = _clone(a);
    }

    function test_initializerRefusesMismatchedPoliciesRoleAndMissingSourceJournal() public {
        _items(5, 1, 1, 0);
        for (uint8 b; b < 5; ++b) {
            for (uint8 s; s < 3; ++s) {
                if (b >= 1 && b <= 3 && s == 0) continue;
                vm.mockCall(address(items), abi.encodeWithSignature("insidePolicies()"), abi.encode(b, s));
                _fresh(); vm.expectRevert(IBoxReceiverV2.InvalidChoice.selector); coord.initialize(r);
            }
        }
        vm.mockCall(address(items), abi.encodeWithSignature("insidePolicies()"), abi.encode(uint8(1), uint8(0)));
        vm.mockCall(address(coord), abi.encodeWithSignature("roleAddress(uint256)", 16), abi.encode(address(0)));
        _fresh(); vm.expectRevert(IBoxReceiverV2.InvalidChoice.selector); coord.initialize(r);
        vm.mockCall(address(coord), abi.encodeWithSignature("roleAddress(uint256)", 16), abi.encode(address(items)));
        vm.mockCall(address(hook), abi.encodeWithSignature("currentTradeBatch(bool)", true), abi.encode(uint256(0)));
        _fresh(); vm.expectRevert(IBoxReceiverV2.InvalidChoice.selector); coord.initialize(r);
    }

    function test_initializerRefusesEmptyOrOversizeCollection() public {
        _items(5, 1, 1, 0);
        vault.counts(0, 0, 0); _fresh(); vm.expectRevert(IBoxReceiverV2.InvalidChoice.selector); coord.initialize(r);
        vault.counts(uint256(type(uint32).max) + 1, 0, 0);
        _fresh(); vm.expectRevert(IBoxReceiverV2.InvalidChoice.selector); coord.initialize(r);
    }

    function test_invalidReceiptAndCountsCannotPublishOrLoseBacking() public {
        _items(5, 1, 1, 0);
        vm.expectRevert(IBoxReceiverV2.InvalidChoice.selector); funding.itemFunding(0);
        vm.expectRevert(IBoxReceiverV2.InvalidChoice.selector); funding.itemFunding(1);
        _source(1, 150, 150); r.collect(address(0));
        vault.counts(4, 5, 4);
        vm.expectRevert(IBoxReceiverV2.InvalidChoice.selector); coord.graduation(r);
        assertFalse(r.graduationSettled()); assertEq(r.itemsHeldP(), 100); assertEq(funding.itemFundingCount(), 0);
        vault.counts(4, 3, 4);
        vm.expectRevert(IBoxReceiverV2.InvalidChoice.selector); coord.graduation(r);
        vault.counts(4, 4, 4); coord.graduation(r); _record(1, 1, 3, 0, 100, 100);
    }

    function test_deficitClipsHeldSidesTogetherAndLaterMoneyCannotRepairReceipt() public {
        _items(5, 5, 1, 2); _source(1, 150, 150); _source(2, 300, 300); r.collect(address(0));
        vm.prank(address(r)); pm.transfer(address(0xBAD), uint160(address(p)), 210);
        coord.graduation(r);
        _record(1, 1, 3, 0, 41, 41); _record(2, 2, 3, 0, 84, 0);
        assertEq(r.itemsHeldP(), 0); assertEq(r.buyBackP(), 84); _booked();
        driver.mintClaims(Currency.wrap(address(p)), address(r), 150); r.collect(address(0));
        _record(1, 1, 3, 0, 41, 41); _record(2, 2, 3, 0, 84, 0); _record(3, 1, 2, 0, 100, 100);
        items.sync(32); assertEq(items.flushResidue(), 1); _booked();
    }

    function test_pausedPriceCoinCannotStopGraduationAndCollect() public {
        _items(5, 5, 1, 2); _source(1, 1500, 1500); _source(2, 1500, 1500);
        p.setPaused(true); r.collect(TIP); assertEq(r.itemsHeldP(), 2000);
        coord.graduation(r); assertEq(r.buyBackP(), 1000); assertEq(_balance(address(items)), 1000);
        items.sync(32); _booked();
    }

    function test_policiesAreReadOnlyOnceAndNoItemCallOccursAtFailure() public {
        _items(5, 4, 1, 0);
        vm.mockCallRevert(address(items), abi.encodeWithSignature("insidePolicies()"), bytes("must be cached"));
        _source(1, 150, 150); _source(2, 150, 150); coord.failure(r);
        assertEq(_balance(address(coord)), 140); assertEq(_balance(holders), 100);
        assertEq(funding.itemFundingCount(), 0); assertEq(r.itemsHeldP(), 0); _booked();
    }

    function testFuzz_bothPoliciesEveryItemAndAllDestinationsConserve(
        uint64 rawB, uint64 rawS, uint8 outside, bool burnB, bool burnS, bool refusedTip
    ) public {
        _items(5, 5, burnB ? 2 : 1, burnS ? 2 : 1);
        uint256 out = outside % 5;
        for (uint256 i = 1; i <= out; ++i) vault.request(bytes32(i));
        coord.graduation(r);
        uint256 b = uint256(rawB); uint256 s = uint256(rawS);
        _source(1, b, b); _source(2, s, s); p.setBlocked(TIP, refusedTip);
        uint256 tip = !refusedTip && b >= 1000 ? b / 20 : 0; if (tip > 100) tip = 100;
        assertEq(r.collect(TIP).tip, tip);
        uint256 ub = (b - tip) / 15; uint256 us = s / 15;
        uint256 perB = 10 * ub / 4; uint256 perS = 10 * us / 4;
        uint256 retained = (4 - out) * ((burnB ? perB : 0) + (burnS ? perS : 0));
        assertEq(r.buyBackP(), retained); assertEq(r.fitOwed(), 2 * (ub + us));
        assertEq(r.platformOwed(), ub + us);
        assertEq(_balance(address(items)), 10 * (ub + us) - retained);
        assertEq(_balance(address(r)) + _balance(address(items)) + _balance(address(hook)) + tip, b + s);
        for (uint256 i = 1; i <= 4; ++i) {
            if (i <= out) vault.deliver(bytes32(i), i, ALICE); else vault.pick(i, ALICE);
        }
        items.sync(32);
        _credits(out, perB, perS, burnB, burnS);
        assertEq(items.flushResidue(), 10 * ub % 4 + 10 * us % 4); _booked();
    }

    function _credits(uint256 out, uint256 perB, uint256 perS, bool burnB, bool burnS) private view {
        for (uint256 i = 1; i <= 4; ++i) {
            (uint256 credit, uint256 stash) = items.itemCredit(i);
            assertEq(credit, i <= out ? perB + perS : 0);
            assertEq(stash, i <= out ? 0 : (burnB ? 0 : perB) + (burnS ? 0 : perS));
        }
    }

    function test_allReceiverPartsRespectTheReleaseGate() public view {
        assertLe(address(implementation).code.length, 22_118);
        assertLe(vm.getDeployedCode("out/ReceiverViews.sol/ReceiverViews.json").length, 22_118);
    }
}
