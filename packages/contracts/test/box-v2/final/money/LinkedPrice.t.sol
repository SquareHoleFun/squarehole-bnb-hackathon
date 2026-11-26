// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LifeCustody} from "../../m3-63-fix-create/Fixture.sol";
import {LinkedPriceFixture} from "./LinkedPriceFixture.sol";
import {ClaimCap} from "../../gas/m3/ClaimCap.sol";
import {ItemLedgerV2} from "../../../../src/box-v2/ItemLedgerV2.sol";
import {HolderLedgerV2} from "../../../../src/box-v2/HolderLedgerV2.sol";
import {BoxTokenV2Ledger} from "../../../../src/box-v2/BoxTokenV2Ledger.sol";

/// FINAL-M02/M03: a genuine graduated holder-token becomes another genuine box's listed P.
/// Receiver and item exits use production code; item controls also require half-cap headroom.
contract FinalMoneyLinkedPriceTest is LinkedPriceFixture {
    function test_FINAL_M02_fitOwnerCanExitFeesPaidInAnotherLedgerToken() public {
        _linked(false);
        uint256 owed = receiver.fitOwed();
        uint256 backing = pm.balanceOf(address(receiver), uint160(address(price)));
        uint256 beforeSafe = price.balanceOf(fitSafe);
        vm.prank(fitSafe);
        assertEq(receiver.payFit(), owed, "named payout cap must support an admitted v2 price coin");
        assertEq(price.balanceOf(fitSafe), beforeSafe + owed);
        assertEq(pm.balanceOf(address(receiver), uint160(address(price))), backing - owed);
        assertEq(receiver.fitOwed(), 0);
    }

    function test_FINAL_M02_platformOwnerCanExitFeesPaidInAnotherLedgerToken() public {
        _linked(false);
        uint256 owed = receiver.platformOwed();
        uint256 beforeSafe = price.balanceOf(address(this));
        assertEq(receiver.payPlatform(), owed, "platform's independent exit supports admitted P");
        assertEq(price.balanceOf(address(this)), beforeSafe + owed);
        assertEq(receiver.platformOwed(), 0);
    }

    function test_lowGasPreservesDebtThenProductionRetryPaysOnce() public {
        _linked(false);
        uint256 owed = receiver.fitOwed();
        uint256 backing = pm.balanceOf(address(receiver), uint160(address(price)));
        vm.prank(fitSafe);
        (bool ok,) = address(receiver).call{gas: 100_000}(abi.encodeCall(receiver.payFit, ()));
        assertFalse(ok, "inadequate outer gas rolls back");
        assertEq(receiver.fitOwed(), owed);
        assertEq(pm.balanceOf(address(receiver), uint160(address(price))), backing);
        vm.prank(fitSafe);
        assertEq(receiver.payFit(), owed);
        assertEq(price.balanceOf(fitSafe), owed);
        assertEq(receiver.fitOwed(), 0);
        assertEq(pm.balanceOf(address(receiver), uint160(address(price))), backing - owed);
        vm.prank(fitSafe);
        assertEq(receiver.payFit(), 0, "retry cannot pay twice");
    }

    function test_linkedFailureClaimConservesPAndCannotSpendOriginNativeClaims() public {
        _linked(false);
        uint256 nativeBacking = address(pm).balance;
        uint256 originReceiver = pm.balanceOf(origin.receiver(), 0);
        uint256 originSupply = price.totalSupply();
        vm.warp(box.deadline());
        box.fail();
        uint256 beforeP = price.balanceOf(address(buyer));
        uint256 paid = _claimBuyer();
        assertEq(price.balanceOf(address(buyer)), beforeP + paid);
        assertEq(price.totalSupply(), originSupply, "redeeming B never burns its P, A's T");
        assertEq(address(pm).balance, nativeBacking);
        assertEq(pm.balanceOf(origin.receiver(), 0), originReceiver);
        assertEq(token.totalSupply() + token.totalBurned(), token.initialSupply());
    }

    function test_FINAL_M03_itemOwnerCanExitCreditPaidInAnotherLedgerToken() public {
        (ItemLedgerV2 ledger, uint256 owed) = _linkedItemCredit();
        uint256 backing = pm.balanceOf(address(ledger), uint160(address(price)));
        uint256 beforePM = price.balanceOf(address(pm));
        uint256 supply = price.totalSupply();
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        // Ordinary production owner claim, without a cap double.
        vm.prank(ALICE);
        assertEq(ledger.claim(ids, ALICE), owed, "item payout cap must support an admitted v2 price coin");
        assertEq(price.balanceOf(ALICE), owed);
        assertEq(price.balanceOf(address(pm)), beforePM - owed);
        assertEq(pm.balanceOf(address(ledger), uint160(address(price))), backing - owed);
        assertEq(price.totalSupply(), supply, "claiming B's P never burns A's T");
        (uint256 outsideP, uint256 stashP) = ledger.itemCredit(1);
        assertEq(outsideP + stashP, 0);
    }

    function test_productionItemClaimHasHalfCapHeadroomForFreshOwner() public {
        (ItemLedgerV2 ledger, uint256 owed) = _linkedItemCredit();
        _itemCapControl(ledger, owed, ALICE);
    }

    function test_productionItemClaimHasHalfCapHeadroomForRegisteredContract() public {
        (ItemLedgerV2 ledger, uint256 owed) = _linkedItemCredit();
        address to = address(new LifeCustody());
        BoxTokenV2Ledger history = BoxTokenV2Ledger(address(price));
        uint256 count = history.holderCount();
        HolderLedgerV2 holders = HolderLedgerV2(origin.roleAddress(17));
        vm.prank(to);
        holders.register();
        assertEq(history.holderCount(), count + 1, "contract opts in to A's real holder history");
        assertEq(history.holderAt(count), to);
        _itemCapControl(ledger, owed, to);
    }

    function _itemCapControl(ItemLedgerV2 ledger, uint256 owed, address to) private {
        uint256 cap = ledger.CLAIM_GAS();
        assertEq(price.balanceOf(to), 0);
        uint256 backing = pm.balanceOf(address(ledger), uint160(address(price)));
        uint256 beforePM = price.balanceOf(address(pm));
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        bytes32 untouched = _unclaimedState(ledger);
        uint256 snapshot = vm.snapshotState();
        vm.prank(ALICE);
        assertEq(ledger.claim(ids, to), owed);
        assertEq(price.balanceOf(to), owed);
        assertEq(price.balanceOf(address(pm)), beforePM - owed);
        assertEq(pm.balanceOf(address(ledger), uint160(address(price))), backing - owed);
        assertEq(_unclaimedState(ledger), untouched);
        assertTrue(vm.revertToState(snapshot));

        // Only reduce the getter and payout cap literals; all accounting and admission logic stays real.
        vm.etch(release.implementations[16], ClaimCap.replace(release.implementations[16].code, cap, cap / 2, 2));
        assertEq(ledger.CLAIM_GAS(), cap / 2);
        vm.prank(ALICE);
        assertEq(ledger.claim(ids, to), owed);
        assertEq(price.balanceOf(to), owed);
        assertEq(price.balanceOf(address(pm)), beforePM - owed);
        assertEq(pm.balanceOf(address(ledger), uint160(address(price))), backing - owed);
        (uint256 outsideP, uint256 stashP) = ledger.itemCredit(1);
        assertEq(outsideP + stashP, 0);
        assertEq(_unclaimedState(ledger), untouched, "no other item, supply or origin backing subsidizes this exit");
        vm.prank(ALICE);
        vm.expectRevert(ItemLedgerV2.InvalidClaim.selector);
        ledger.claim(ids, to);
        assertEq(price.balanceOf(to), owed, "retry cannot pay twice");
        assertEq(pm.balanceOf(address(ledger), uint160(address(price))), backing - owed);
    }
}
