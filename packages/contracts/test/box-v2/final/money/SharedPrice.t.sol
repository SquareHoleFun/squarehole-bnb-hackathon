// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {NoFailureSweep} from "../../rc5-a/NoFailureSweep.sol";

import {M363Base} from "../../m3-63-fix-create/Fixture.sol";
import {BoxSpec} from "../../../../src/box-v2/interfaces/SpecTypes.sol";
import {Branch} from "../../../../src/box-v2/interfaces/RecipeTypes.sol";
import {BoxCoordinatorV2} from "../../../../src/box-v2/BoxCoordinatorV2.sol";
import {BoxTokenV2} from "../../../../src/box-v2/BoxTokenV2.sol";
import {IBoxReceiverV2, IBoxReceiverItemsV2} from "../../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {HolderLedgerV2} from "../../../../src/box-v2/HolderLedgerV2.sol";
import {HostileToken} from "../../kit/HostileToken.sol";
import {PoolDriver} from "../../kit/BoxV2TestBase.sol";

/// Two production boxes share a PoolManager and the same P. A fails; B graduates.
/// Their identically numbered source batches, holder earnings and item bases remain independent.
contract FinalMoneySharedPriceTest is M363Base {
    address private constant ALICE = address(0xA11CE);
    BoxCoordinatorV2 private a;
    BoxTokenV2 private ta;
    IBoxReceiverV2 private ra;
    PoolDriver private buyerA;
    HolderLedgerV2 private ha;

    function test_sameNativePriceMixedDestinationsRemainIsolatedThroughPermanentClaims() public { _scenario(0); }
    function test_sameSixDecimalPriceMixedDestinationsRemainIsolatedThroughPermanentClaims() public { _scenario(6); }
    function test_sameEighteenDecimalPriceMixedDestinationsRemainIsolatedThroughPermanentClaims() public { _scenario(18); }

    function _scenario(uint8 decimals) private {
        BoxSpec memory s = _items(1, 2);
        if (decimals != 0) {
            (BoxSpec memory priced, HostileToken p) = _priceSpec(1, 1, decimals);
            s.pricing = priced.pricing; s.raise = priced.raise;
            p.mint(CREATOR, 3 * s.raise);
            vm.prank(CREATOR); p.approve(address(factory), type(uint256).max);
        }
        s.buyers.a = Branch(1, 6, "", abi.encode(uint8(1)));
        _start(s); _buy(s.raise / 5);
        uint256 toAlice = token.balanceOf(address(buyer)) / 3;
        vm.prank(address(buyer)); token.transfer(ALICE, toAlice);
        vm.roll(block.number + 1); _buy(s.raise / 10);
        receiver.collect(address(0));
        a = box; ta = token; ra = receiver; buyerA = buyer;
        ha = HolderLedgerV2(a.roleAddress(17));
        assertGt(ra.holderBatchPaid(1), 0);

        BoxSpec memory second = _items(2, 1);
        second.pricing = s.pricing; second.raise = s.raise;
        _start(second); _fill(); box.graduate(); receiver.collect(address(0));
        assertTrue(box.graduated());
        assertGt(IBoxReceiverItemsV2(address(receiver)).itemFundingCount(), 0);
        uint256 money = _allMoney();
        bytes32 protected = _otherBoxState();
        uint256 earnedBacking = pm.balanceOf(address(ha), uint160(box.q()));
        vm.warp(a.deadline()); a.fail();
        assertEq(pm.balanceOf(address(ha), uint160(box.q())), earnedBacking);
        uint256 held = ta.balanceOf(address(buyerA));
        uint256 quote = a.quoteClaim(held);
        uint256 beforeP = _balance(address(buyerA));
        vm.startPrank(address(buyerA));
        ta.approve(address(a), held);
        assertEq(a.claim(held, address(buyerA)), quote);
        vm.stopPrank();
        assertEq(_balance(address(buyerA)), beforeP + quote);
        (uint256 pot, uint256 left) = a.claimState();
        assertEq(left, ta.balanceOf(ALICE));
        assertEq(a.quoteClaim(left), pot, "last holder is entitled to all rounding remainder");
        uint256 oldFit = ra.fitOwed();
        vm.warp(uint256(a.failedAt()) + 365 days);
        NoFailureSweep.check(address(a));
        assertEq(ra.fitOwed(), oldFit);
        assertEq(_otherBoxState(), protected, "failure and claims with no year sweep cannot spend B's P or item base");
        assertEq(a.quoteClaim(left), pot);
        vm.warp(block.timestamp + 365 days);
        _earnedExit();
        assertEq(_otherBoxState(), protected, "late holder settlement cannot borrow B's source funding");
        assertEq(_allMoney(), money);
        assertEq(ta.totalSupply() + ta.totalBurned(), ta.initialSupply());
        assertEq(token.totalSupply() + token.totalBurned(), token.initialSupply());
    }

    function _earnedExit() private {
        uint256 totalPaid;
        for (uint256 id = 1; id <= 4; ++id) {
            assertTrue(ha.settleBatch(id, 64));
            uint256 credit = ha.claimable(id, ALICE);
            (,,, uint256 residue) = ha.batchState(id);
            assertEq(credit + residue, ra.holderBatchPaid(id));
            if (credit != 0) {
                vm.prank(ALICE); assertEq(ha.claim(id, ALICE), credit);
                totalPaid += credit;
            }
            assertEq(ha.flushResidue(id), residue);
        }
        assertGt(totalPaid, 0, "earned owner-only holder claims still exit a year after failure with no pot sweep");
        assertEq(pm.balanceOf(address(ha), uint160(box.q())), 0);
    }

    function _otherBoxState() private view returns (bytes32) {
        return keccak256(abi.encode(
            pm.balanceOf(box.hook(), uint160(box.q())),
            pm.balanceOf(address(receiver), uint160(box.q())),
            pm.balanceOf(box.roleAddress(16), uint160(box.q())),
            receiver.booked(box.q()),
            IBoxReceiverItemsV2(address(receiver)).itemFundingCount(),
            token.totalSupply(), token.totalBurned()
        ));
    }

    function _allMoney() private view returns (uint256) {
        return _money() + _balance(address(buyerA)) + _balance(address(a))
            + _balance(a.launchRouter()) + _balance(address(ra)) + _balance(ALICE);
    }
}
