// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {NoFailureSweep} from "../rc5-a/NoFailureSweep.sol";

import {M340Base} from "./Fixture.sol";
import {LifeCustody} from "../kit/FactoryLife.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {IBoxCoordinatorV2} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {IBoxReceiverItemsV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {HolderLedgerV2} from "../../../src/box-v2/HolderLedgerV2.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

contract M340SweepTest is M340Base {
    function test_R40A_pileClaimsStayOpenAYearAfterFillAndFailure() public {
        _start(_pile(address(0), 0));
        _fill();
        uint256 filled = hook.closedAt();
        vm.warp(filled + 7 days);
        box.fail();
        assertEq(box.failedAt(), filled + 7 days);
        (uint256 pot, uint256 left) = box.claimState();
        assertGt(left, 0);
        vm.warp(filled + 365 days);
        NoFailureSweep.check(address(box));
        vm.warp(box.failedAt() + 365 days);
        NoFailureSweep.check(address(box));
        (, uint256 afterYear) = box.claimState();
        assertEq(afterYear, left);
    }

    function test_R40A_itemsNoBuyerReturnIsFixedAndNeverSwept() public { _noBuyer(_items(1, 2)); }
    function test_R40A_pileNoBuyerReturnIsFixedAndNeverSwept() public { _noBuyer(_pile(address(0), 0)); }

    function _noBuyer(BoxSpec memory s) private {
        _start(s);
        _gift(address(receiver), 1500); receiver.collect(address(0));
        vm.warp(box.deadline()); box.fail();
        (uint256 fixedPot, uint256 left) = box.claimState();
        assertEq(left, 0); assertGt(fixedPot, 0);
        _gift(address(box), 43);
        vm.warp(box.failedAt() + 1000 days);
        LifeCustody(payable(fitSafe)).setRefusing(true);
        uint256 fit = receiver.fitOwed();
        NoFailureSweep.check(address(box));
        assertEq(receiver.fitOwed(), fit);
        assertEq(box.quoteClaim(0), fixedPot);
        vm.expectRevert(); box.claim(0, address(this));
        vm.prank(CREATOR); assertEq(box.claim(0, CREATOR), fixedPot);
        vm.expectRevert(); vm.prank(CREATOR); box.claim(0, CREATOR);
        LifeCustody(payable(fitSafe)).setRefusing(false);
        assertEq(receiver.payFit(), fit);
        _gift(address(hook), 7); _gift(address(box), 11);
        NoFailureSweep.check(address(box));
        (uint256 retained,) = box.claimState(); assertEq(retained, 54);
        assertEq(pm.balanceOf(address(hook), uint160(box.q())), 7);
    }

    function test_R40A_curveSellerFeesBurnWhileItemsPJoinsFailurePot() public {
        BoxSpec memory s = _items(1, 0);
        s.sellers.a.leg = 1;
        s.sellers.a.dest = 6;
        s.sellers.a.destParams = abi.encode(uint8(1));
        s.creatorBuy = s.raise / 10;
        _start(s);
        HolderLedgerV2 ledger = HolderLedgerV2(box.roleAddress(17));
        _buy(s.raise / 5);
        buyer.swap(hook.poolKey(), false, token.balanceOf(address(buyer)) / 10, layout.sqrtPriceStartX96);
        receiver.collect(address(0));
        assertGt(receiver.itemsHeldP(), 0);
        assertTrue(ledger.settleBatch(2, 64));
        uint256 earned = ledger.claimable(2, CREATOR);
        assertEq(earned, 0, "curve T fees burn rather than fund seller P claims");
        uint256 funding = pm.balanceOf(address(ledger), 0);
        vm.warp(box.deadline());
        box.fail();
        assertEq(pm.balanceOf(address(ledger), 0), funding);
        assertEq(IBoxReceiverItemsV2(address(receiver)).itemFundingCount(), 0);
        (uint256 pot, uint256 left) = box.claimState();
        assertGt(left, 0);
        vm.warp(box.failedAt() + 365 days);
        NoFailureSweep.check(address(box));
        assertEq(ledger.claimable(2, CREATOR), earned);
        uint256 before = CREATOR.balance;
        vm.prank(CREATOR); vm.expectRevert();
        ledger.claim(2, CREATOR);
        assertEq(CREATOR.balance, before + earned);
        assertEq(pm.balanceOf(address(ledger), 0), funding - earned);
    }

    function testFuzz_S5_fixedPileCountAndClaimConservation(uint128 rawLiquid, uint128 rawClaims) public {
        _start(_pile(address(0), 0));
        _buy(box.raise() / 5);
        uint256 held = token.balanceOf(address(buyer));
        uint256 liquid = uint256(rawLiquid) % (held / 3 + 1);
        uint256 claims = uint256(rawClaims) % (held / 3 + 1);
        address pile = box.vault();
        vm.prank(address(buyer));
        token.approve(pile, liquid);
        vm.prank(pile);
        token.transferFrom(address(buyer), pile, liquid);
        buyer.mintClaims(Currency.wrap(address(token)), pile, claims);
        vm.warp(box.deadline());
        box.fail();
        (uint256 pot, uint256 left) = box.claimState();
        assertEq(left, held - liquid - claims);
        uint256 before = address(buyer).balance;
        vm.startPrank(address(buyer));
        token.approve(address(box), left);
        uint256 first = left / 3;
        uint256 paid = box.claim(first, address(buyer));
        paid += box.claim(left - first, address(buyer));
        vm.stopPrank();
        assertEq(paid, pot);
        assertEq(address(buyer).balance, before + pot);
        (pot, left) = box.claimState();
        assertEq(pot, 0);
        assertEq(left, 0);
        assertEq(token.balanceOf(pile), liquid);
        assertEq(pm.balanceOf(pile, uint160(address(token))), claims);
    }
}
