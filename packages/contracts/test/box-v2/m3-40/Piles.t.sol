// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {NoFailureSweep} from "../rc5-a/NoFailureSweep.sol";

import {M340Base} from "./Fixture.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {BoxTokenV2} from "../../../src/box-v2/BoxTokenV2.sol";
import {PileVaultV2} from "../../../src/box-v2/PileVaultV2.sol";
import {IBoxHookV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {IBoxFactoryPileV2, IBoxCoordinatorV2, FailCause} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {BoxLayoutV2} from "../../../src/box-v2/libraries/BoxLayoutV2.sol";
import {PoolDriver} from "../kit/BoxV2TestBase.sol";
import {HostileToken} from "../kit/HostileToken.sol";
import {ListingClass} from "../../../src/box-v2/interfaces/IListingRegistry.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

contract M340PilesTest is M340Base {
    HostileToken private p;
    HostileToken private seed;
    PileVaultV2 private pile;
    uint256 private amount;
    uint256 private liquid;
    uint256 private claims;
    uint256 private outside;
    bool private globalPause;

    address private constant BOB = address(0xB340);
    function test_S5_samePausedPriceAndSeedClosesAndClaimRollsBack() public {
        globalPause = true;
        _failure(1, true, 6);
    }
    function test_S5_samePausedPriceAndSeedHatchCloses() public {
        globalPause = true;
        _failure(3, true, 18);
    }
    function test_S5_deadlineSameAssetSixDecimals() public { _failure(1, true, 6); }
    function test_S5_unopenedSameAssetEightDecimals() public { _failure(2, true, 8); }
    function test_S5_hatchSameAssetEighteenDecimals() public { _failure(3, true, 18); }
    function test_S5_deadlineDistinctAssetEighteenDecimals() public { _failure(1, false, 18); }
    function test_S5_unopenedDistinctAssetSixDecimals() public { _failure(2, false, 6); }
    function test_S5_hatchDistinctAssetEightDecimals() public { _failure(3, false, 8); }

    function _failure(uint8 cause, bool same, uint8 decimals) private {
        BoxSpec memory s;
        (s, p) = _priceSpec(1, 1, decimals);
        seed = p;
        if (!same) {
            seed = new HostileToken("Seed", "SEED", decimals);
            seed.mint(address(this), 10000);
            seed.approve(address(listings), 10000);
            listings.add(address(seed), ListingClass.OTHER, s.raise);
        }
        amount = s.raise * 2;
        seed.mint(CREATOR, amount);
        s.boxType = 5;
        s.contentsParams = abi.encode(address(seed), amount);
        s.creatorBuy = s.raise / 10;
        box = _create(s);
        token = BoxTokenV2(box.token());
        hook = IBoxHookV2(box.hook());
        receiver = IBoxReceiverV2(box.receiver());
        layout = BoxLayoutV2.curve(s.raise, false);
        buyer = new PoolDriver(pm);
        p.mint(address(buyer), s.raise * 10);
        pile = PileVaultV2(payable(box.vault()));
        if (cause != 2) {
            vm.prank(CREATOR);
            seed.approve(address(pile), amount);
            vm.prank(BOB);
            pile.loadSeed();
            vm.warp(box.effectiveOpenAt() + 384);
            if (cause == 3) _fill(); else _buy(s.raise / 5);
        }
        // Explicit adversarial custody: production T permits only the vault's own pull.
        // There is no public pile deposit entry; PM claim gifts are permissionless and fully backed.
        uint256 held = token.balanceOf(CREATOR);
        liquid = held / 5;
        claims = held / 7;
        vm.startPrank(CREATOR);
        token.approve(address(pile), liquid);
        token.transfer(address(buyer), claims);
        vm.stopPrank();
        vm.prank(address(pile));
        token.transferFrom(CREATOR, address(pile), liquid);
        buyer.mintClaims(Currency.wrap(address(token)), address(pile), claims);
        // Unrelated PM T claims are never subtracted as closed-pool inventory.
        outside = token.balanceOf(CREATOR) / 11;
        vm.prank(CREATOR);
        token.transfer(address(buyer), outside);
        buyer.mintClaims(Currency.wrap(address(token)), BOB, outside);
        // Burn refusal must be caught; balances remain backed and supply is unchanged by these attempts.
        vm.mockCallRevert(address(token), abi.encodeWithSignature("burn(uint256)"), "burn refused");
        // The factory and seed balance are not consulted again during closure or P claims.
        vm.mockCallRevert(address(factory), abi.encodeCall(IBoxFactoryPileV2.isPileVault, (address(pile))), "cache required");
        vm.mockCallRevert(address(seed), abi.encodeWithSignature("balanceOf(address)", address(pile)), "seed read refused");
        seed.setBlocked(address(pile), true);
        if (globalPause || !same) seed.setPaused(true);
        uint256 boundary = cause == 1 ? box.deadline() : cause == 2 ? box.openAt() + 14 days : hook.closedAt() + 7 days;
        vm.warp(boundary - 1);
        vm.expectRevert();
        _fail(cause);
        vm.warp(boundary);
        _fail(cause);
        assertEq(uint256(box.failCause()), uint256(cause == 1 ? FailCause.Deadline : cause == 2 ? FailCause.ClosedPastCap : FailCause.GraduationTimedOut));
        (uint256 remaining, uint256 count) = _claimsAndSeed(cause);
        _noSweepAfterAYear(same, remaining, count);
    }

    function _claimsAndSeed(uint8 cause) private returns (uint256 remaining, uint256 count) {
        (uint256 pot, uint256 left) = box.claimState();
        assertEq(left, token.balanceOf(CREATOR) + token.balanceOf(address(buyer)) + outside);
        assertGt(token.balanceOf(address(box)) + token.balanceOf(address(hook)), 0, "refused burns remain in H");
        assertEq(token.balanceOf(address(pile)), liquid);
        assertEq(pm.balanceOf(address(pile), uint160(address(token))), claims);
        if (cause != 2) {
            vm.expectRevert();
            pile.returnSeed();
        } else assertEq(pile.returnSeed(), 0, "unfunded commitment is not a return");
        uint256 claimT = token.balanceOf(CREATOR) / 2;
        uint256 quote = box.quoteClaim(claimT);
        vm.startPrank(CREATOR);
        token.approve(address(box), claimT);
        if (globalPause) {
            vm.expectRevert(bytes4(keccak256("ClaimFailed()")));
            box.claim(claimT, BOB);
            (uint256 unchangedPot, uint256 unchangedLeft) = box.claimState();
            assertEq(unchangedPot, pot);
            assertEq(unchangedLeft, left);
            p.setPaused(false);
        }
        assertEq(box.claim(claimT, BOB), quote, "blocked seed does not block distinct P custody");
        vm.stopPrank();
        (remaining, count) = box.claimState();
        assertEq(remaining, pot - quote);
        assertEq(count, left - claimT);
        vm.clearMockedCalls();
        seed.setBlocked(address(pile), false);
        seed.setPaused(false);
        uint256 beforeSeeder = seed.balanceOf(CREATOR);
        if (cause != 2) {
            vm.prank(BOB);
            assertEq(pile.returnSeed(), amount);
            assertEq(seed.balanceOf(CREATOR), beforeSeeder + amount);
            assertEq(seed.balanceOf(address(pile)), 0);
        }
        (uint256 afterSeed, uint256 afterCount) = box.claimState();
        assertEq(afterSeed, remaining, "seed P is not the pot");
        assertEq(afterCount, count);
        assertEq(token.balanceOf(address(pile)), liquid);
        assertEq(pm.balanceOf(address(pile), uint160(address(token))), claims);
    }

    function _noSweepAfterAYear(bool same, uint256 remaining, uint256 count) private {
        // Fixed-count exit even though a holder burns coins rather than claiming them.
        uint256 burn = token.balanceOf(CREATOR) / 2;
        vm.prank(CREATOR);
        token.burn(burn);
        vm.warp(box.failedAt() + 365 days - 1);
        NoFailureSweep.check(address(box));
        vm.warp(box.failedAt() + 365 days);
        seed.setPaused(true);
        uint256 owed = receiver.fitOwed();
        NoFailureSweep.check(address(box));
        assertEq(receiver.fitOwed(), owed);
        (, uint256 afterCount) = box.claimState();
        assertEq(afterCount, count, "a year after failure leaves the fixed T count unchanged");
        assertEq(box.quoteClaim(count), remaining);
        if (same) assertEq(receiver.payFit(), 0, "paused P payout stays owed");
        seed.setPaused(false);
        uint256 paid = receiver.payFit();
        assertEq(paid, owed);
        assertEq(p.balanceOf(fitSafe), paid);
        NoFailureSweep.check(address(box));
    }

    function _fail(uint8 cause) private {
        if (cause == 2) box.failClosed(); else box.fail();
    }
}
