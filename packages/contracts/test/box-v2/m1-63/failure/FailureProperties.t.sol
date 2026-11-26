// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {NoFailureSweep} from "../../rc5-a/NoFailureSweep.sol";

import {MoneyFixture} from "../../m1-61/MoneyFixture.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {IBoxCoordinatorV2} from "../../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";

/// @notice Real receiver/coordinator/token/PoolManager; scripted hook/router/vault boundaries.
contract FailureMoneyPropertiesTest is MoneyFixture {
    function testFuzz_M01_reservePrincipalAndAllM1ChoicesConserve(uint8 buySeed, uint8 sellSeed) public {
        uint8 buyers = uint8(bound(buySeed, 1, 3));
        uint8 sellers = uint8(bound(sellSeed, 1, 3));
        _realBox(buyers, sellers, 1, true, address(priceToken));
        _give(ALICE, 100);
        _feed(60, 45);
        _royaltyP(101);
        _fund(p, address(hook), 1009);
        hook.configure(30, 15, 5); // 964 principal; 45 total buyers' fees, including D6.
        _tax(7);
        _expire();
        box.fail();
        assertEq(fees.fitOwed(), 20);
        assertEq(fees.platformOwed(), 10);
        assertEq(_pot(), 1187);
        assertEq(_balance(address(this)), 5);
        assertEq(_pot() + fees.fitOwed() + fees.platformOwed() + 5, 1222);
        assertEq(fees.creatorP() + fees.buyBackP() + fees.royaltyHeldP() + fees.poolHeldP() + fees.growHeldP(), 0);
        _assertBooked();
        fees.payFit();
        fees.payPlatform();
        assertEq(_claim(ALICE, 100, BOB), 1187);
        assertEq(_balance(FIT) + _balance(PLATFORM) + _balance(BOB) + 5, 1222);
        vm.expectRevert(IBoxCoordinatorV2.AlreadyFailed.selector);
        box.fail();
    }

    function test_M02_carriesJoinPotAndBlockedSafeDoesNotBlockOther() public {
        _give(ALICE, 1);
        _feed(31, 46); // five units, plus one carry on each side.
        _expire();
        box.fail();
        assertEq(fees.fitOwed(), 10);
        assertEq(fees.platformOwed(), 5);
        assertEq(_pot(), 62);
        priceToken.setBlocked(FIT, true);
        assertEq(fees.payFit(), 0);
        assertEq(fees.payPlatform(), 5);
        assertEq(_claim(ALICE, 1, ALICE), 62);
        assertEq(fees.fitOwed(), 10);
        priceToken.setBlocked(FIT, false);
        assertEq(fees.payFit(), 10);
    }

    function test_M03_pausedPriceBlockedConversionAndBurnFloorDoNotBlockHatch() public {
        _give(ALICE, 100);
        _fund(p, address(hook), 100);
        _tax(10);
        hook.configure(0, 0, 5);
        vault.configure(SUPPLY, 0, false);
        foreignCoin.setBlocked(CONVERSION, true);
        _royaltyForeign(17);
        priceToken.setPaused(true);
        hook.fill();
        vm.warp(hook.closedAt() + 7 days);
        box.fail();
        assertEq(_pot(), 100);
        assertEq(_left(), 100);
        assertEq(_balance(address(router)), 10);
        assertEq(_balance(address(this)), 0);
        vm.expectRevert();
        vm.prank(ALICE);
        box.claim(100, ALICE);
        assertEq(_left(), 100);
        assertEq(t.balanceOf(ALICE), 100);
        priceToken.setPaused(false);
        assertEq(_claim(ALICE, 100, BOB), 110);
        assertEq(t.balanceOf(address(box)), SUPPLY); // refused burns cannot block payout or count twice.
        foreignCoin.setBlocked(CONVERSION, false);
        // F136 (SH-V21-RC5-INT fix round): the lot that waited through the failure stays in the box for good.
        assertEq(foreignCoin.balanceOf(CONVERSION), 0);
        assertEq(foreignCoin.balanceOf(address(this)), 17);
    }

    function test_M04_receiverReceiptsAfterFailureJoinPotEvenBeforeLastClaim() public {
        _fail(100, 100);
        _fund(p, address(fees), 7);
        fees.collect(address(0));
        _royaltyP(11); // same entry used by converted royalties.
        assertEq(fees.fitOwed(), 0);
        assertEq(_pot(), 118);
        assertEq(_claim(ALICE, 100, ALICE), 118);
        _royaltyP(13);
        assertEq(fees.payFit(), 0);
        assertEq(_balance(FIT), 0);
    }

    function test_M05_noBuyerReturnIsFixedAndUnpaidTipStaysInIt() public {
        _fund(p, address(hook), 101);
        hook.configure(0, 0, 5);
        priceToken.setBlocked(address(this), true);
        _expire();
        box.fail();
        assertEq(box.quoteClaim(0), 101);
        priceToken.setBlocked(address(this), false);
        _fund(p, address(box), 19);
        NoFailureSweep.check(address(box));
        assertEq(box.quoteClaim(0), 101);
        vm.expectRevert(IBoxCoordinatorV2.InvalidClaim.selector);
        box.claim(0, BOB);
        _tax(7);
        assertEq(_claim(CREATOR, 0, BOB), 101);
        NoFailureSweep.check(address(box));
        assertEq(fees.fitOwed(), 0);
        vm.expectRevert(IBoxCoordinatorV2.InvalidClaim.selector);
        vm.prank(CREATOR);
        box.claim(0, CREATOR);
    }

    function test_M06_exactDenominatorIncludesPlaceholderBacking() public {
        _give(ALICE, 100);
        _vaultTokens(27);
        _give(address(hook), 3);
        _give(address(fees), 5);
        _fundT(address(box), 7);
        _fundT(address(hook), 11);
        _fundT(address(fees), 13);
        vault.configure(SUPPLY, 17, false); // retained burns belong to H; 10 vault T still claimable.
        _expire();
        box.fail();
        assertEq(_left(), 110);
        vm.prank(address(vault));
        t.transfer(ALICE, 10);
        assertEq(t.balanceOf(ALICE), _left());
        _claim(ALICE, 110, ALICE);
        assertEq(_left(), 0);
    }

    function test_M07_kAboveVaultBalanceCannotUnderflowDenominator() public {
        _give(ALICE, 100);
        _vaultTokens(27);
        vault.configure(SUPPLY, 1000, false);
        _expire();
        box.fail();
        assertEq(_left(), 100);
    }

    function test_M08_noClaimExpiryAndLargeLastPayout() public {
        uint256 part = uint256(uint128(type(int128).max));
        _give(ALICE, 3);
        _fund(p, address(hook), part);
        _fund(p, address(hook), part);
        _expire();
        box.fail();
        vm.warp(block.timestamp + 1000 days);
        assertEq(_claim(ALICE, 3, BOB), 2 * part);
        assertEq(_pot(), 0);
    }

    function test_M10_claimCannotSpendAnotherHolderOrInvalidAmount() public {
        _fail(100, 100);
        vm.expectRevert(IBoxCoordinatorV2.InvalidClaim.selector);
        box.claim(0, ALICE);
        vm.expectRevert(IBoxCoordinatorV2.InvalidClaim.selector);
        box.claim(101, ALICE);
        vm.expectRevert(IBoxCoordinatorV2.InvalidClaim.selector);
        box.claim(1, address(0));
        vm.expectRevert();
        vm.prank(BOB);
        box.claim(100, BOB); // Alice's approval cannot be used by Bob through claim.
        assertEq(_pot(), 100);
        assertEq(_left(), 100);
        assertEq(t.balanceOf(ALICE), 100);
        assertEq(_claim(ALICE, 100, BOB), 100);
    }

    function testFuzz_M09_partitionConservationAndFullPrecision(uint128 seed, uint96 coinsSeed, uint96 firstSeed)
        public
    {
        uint256 pot = uint256(seed) % uint256(uint128(type(int128).max));
        uint256 coins = bound(coinsSeed, 2, 1e28);
        uint256 first = bound(firstSeed, 1, coins - 1);
        _fail(pot, coins);
        uint256 paid = _claim(ALICE, first, BOB);
        assertEq(paid, FullMath.mulDiv(pot, first, coins));
        assertGe(FullMath.mulDiv(_pot(), coins, _left()), pot);
        paid += _claim(ALICE, coins - first, ALICE);
        assertEq(paid, pot);
        assertEq(_left(), 0);
        assertEq(_pot(), 0);
    }
}
