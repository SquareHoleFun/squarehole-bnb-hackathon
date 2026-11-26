// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {RoyaltyRelease} from "../../kit/RoyaltyRelease.sol";
import {NoFailureSweep} from "../../rc5-a/NoFailureSweep.sol";

import {MoneyFixture} from "../../m1-61/MoneyFixture.sol";
import {SweepFixture} from "../../r40a/SweepFixture.sol";
import {CQ11ARealFixture} from "../../cq11-a/RealFixture.sol";
import {BoxClones} from "../../../../src/box/libraries/BoxClones.sol";
import {RoyaltyDestination} from "../../../../src/box/interfaces/BoxTypes.sol";
import {BoxRoyaltyRouterV2} from "../../../../src/box-v2/BoxRoyaltyRouterV2.sol";
import {BoxRoyaltyRouterV2Args} from "../../../../src/box-v2/libraries/BoxRoyaltyRouterV2Args.sol";
import {ListingRegistry} from "../../../../src/box-v2/ListingRegistry.sol";

/// @notice M1-63 F01: R40A fixes the count; F136 keeps claims open without a one-year sweep.
contract FailureDenominatorFindingsTest is SweepFixture {
    function test_F01_burnedOutstandingShareAndLateMoneyStayLocked() public {
        _fail(100, 100);
        vm.prank(ALICE);
        t.burn(40);
        uint256 paid = _claim(ALICE, 60, ALICE);
        assertEq(t.balanceOf(ALICE), 0);
        assertEq(t.totalSupply(), 0);
        _fund(p, address(box), 7);
        assertEq(paid, 60);
        assertEq(_left(), 40);
        _retainedAtYear(47);
        _assertClaimsOpen(ALICE, 1);
        _fund(p, address(box), 11);
        NoFailureSweep.check(address(box));
        fees.payFit();
        assertEq(_pot(), 58);
        assertEq(paid + _pot(), 118, "all original and late P stays with claimants or the pot");
    }

    function test_F01_giftToExcludedPartKeepsCountAndClaimsStayOpen() public {
        _fail(100, 100);
        vm.prank(ALICE);
        t.transfer(address(box), 40);
        _claim(ALICE, 60, ALICE);
        assertEq(t.balanceOf(ALICE), 0);
        assertEq(t.balanceOf(address(box)), 40);
        assertEq(_left(), 40);
        _retainedAtYear(40);
        _assertClaimsOpen(ALICE, 1);
    }
}

contract FailureRouterFindingsTest is CQ11ARealFixture {
    function test_F02_windowTaxAboveInt128MustHaveSweepExit() public {
        _make(LARGE);
        // Run the real admission arithmetic, including the full-range graduation layout.
        ListingRegistry listings = new ListingRegistry(address(this), address(box), address(pm), address(0xA3));
        listings.checkLayout(LARGE);
        vm.warp(box.effectiveOpenAt());
        vm.roll(block.number + 1);
        vm.startPrank(address(trader));
        p.approve(address(router), type(uint256).max);
        router.buy(1e38, 0, address(trader), block.timestamp);
        router.buy(1e38, 0, address(trader), block.timestamp);
        vm.stopPrank();
        uint256 tax = p.balanceOf(address(router));
        assertEq(tax, 1863948e32, "two ordinary step-zero buys retain 931974 ppm each");
        assertGt(tax, uint256(uint128(type(int128).max)));
        assertFalse(hook.closed());
        vm.warp(box.deadline());
        box.fail();
        assertTrue(box.failed(), "a refused sweep must not prevent closure");
        // The healthy-token sweep must now fit failure's named allowance, without an uncapped retry.
        assertGe(_claims(address(box)), tax - hook.deepenTipCap());
        assertEq(p.balanceOf(address(router)), 0);
    }
}

contract FailureRoyaltyFindingsTest is MoneyFixture {
    function test_F02_accumulatedPriceRoyaltiesAboveInt128MustHaveSweepExit() public {
        _fail(100, 100);
        BoxRoyaltyRouterV2 royalty = BoxRoyaltyRouterV2(
            payable(BoxClones.create(
                    BoxClones.initCodeReceiving(
                        address(new BoxRoyaltyRouterV2(RoyaltyRelease.config())),
                        RoyaltyRelease.args(
                            address(box), address(fees), address(0xA3), RoyaltyDestination.FeeHandling, p
                        )
                    )
                ))
        );
        uint256 amount = uint256(uint128(type(int128).max)) + 1;
        // Each incoming payment fits int128; only their accumulated balance exceeds it.
        priceToken.mint(address(royalty), amount / 2);
        priceToken.mint(address(royalty), amount / 2);
        (bool swept,) = address(royalty).call(abi.encodeCall(royalty.sweep, (p)));
        assertTrue(swept, "F02: healthy P royalties cannot leave the router through the real receiver");
        assertEq(priceToken.balanceOf(address(royalty)), 0);
        assertEq(fees.fitOwed(), 0);
        assertEq(_pot(), amount + 100);
    }
}
