// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FactoryLife} from "../kit/FactoryLife.sol";
import {HostileToken} from "../kit/HostileToken.sol";
import {BoxLaunchRouterV2} from "../../../src/box-v2/BoxLaunchRouterV2.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {IBoxReceiverV2, FeeBatchV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {ReceiverArgs, BoxReceiverV2Args} from "../../../src/box-v2/libraries/BoxReceiverV2Args.sol";

contract PausedPriceTest is FactoryLife {
    function test_pausedPriceClosesAndFailedClaimRollsBackThenRetries() public {
        (BoxSpec memory s, HostileToken p) = _priceSpec(2, 1, 6);
        _start(s);
        uint256 money = _money();
        _buy(s.raise / 3);
        p.setPaused(true);
        {
            FeeBatchV2 memory batch = receiver.collect(address(this));
            assertGt(batch.buyersP, factory.boxQParameters(s.pricing.listingId, s.raise).batchMinQ);
            assertEq(batch.tip, 0);
            assertGt(
                pm.balanceOf(address(receiver), uint160(address(p))),
                receiver.booked(address(p)),
                "refused collect tip remains unbooked and recoverable"
            );
        }
        vm.warp(box.deadline());
        uint256 closer = p.balanceOf(address(this));
        box.fail();
        assertTrue(box.failed());
        assertEq(p.balanceOf(address(this)), closer, "refused closer tip stays in pot");
        (uint256 pot, uint256 left) = box.claimState();
        assertEq(left, token.balanceOf(address(buyer)));
        uint256 supply = token.totalSupply();
        vm.prank(address(buyer));
        token.approve(address(box), left);
        vm.expectRevert();
        vm.prank(address(buyer));
        box.claim(left, address(buyer));
        (uint256 afterPot, uint256 afterLeft) = box.claimState();
        assertEq(afterPot, pot);
        assertEq(afterLeft, left);
        assertEq(token.totalSupply(), supply);
        assertEq(token.balanceOf(address(buyer)), left);
        uint256 owed = receiver.fitOwed();
        assertGt(owed, 0);
        assertEq(receiver.payFit(), 0);
        assertEq(receiver.fitOwed(), owed);
        p.setPaused(false);
        _claimBuyer();
        // A blocked FIT payout cannot block the independent platform payout.
        p.setBlocked(fitSafe, true);
        assertEq(receiver.payFit(), 0);
        uint256 platform = receiver.platformOwed();
        assertGt(platform, 0);
        assertEq(receiver.payPlatform(), platform);
        p.setBlocked(fitSafe, false);
        assertEq(receiver.payFit(), owed);
        assertEq(p.balanceOf(fitSafe), owed);
        assertEq(_money(), money);
        _booked();
    }

    function test_pausedPriceHatchStillClosesAndClaimRetries() public {
        (BoxSpec memory s, HostileToken p) = _priceSpec(1, 2, 18);
        _start(s);
        _fill();
        p.setPaused(true);
        vm.warp(hook.closedAt() + 7 days);
        box.fail();
        assertTrue(box.failed());
        p.setPaused(false);
        _claimBuyer();
    }

    function test_pausedRouterTaxWaitsThenJoinsClaimBeforeItsQuote() public {
        (BoxSpec memory s, HostileToken p) = _priceSpec(2, 2, 8);
        // Buy through the actual launch window (the generic life helper otherwise advances past it).
        _startAt(s, 12);
        BoxLaunchRouterV2 router = BoxLaunchRouterV2(payable(box.launchRouter()));
        vm.startPrank(address(buyer));
        p.approve(address(router), s.raise / 10);
        router.buy(s.raise / 10, 1, address(buyer), block.timestamp);
        vm.stopPrank();
        uint256 tax = p.balanceOf(address(router));
        assertGt(tax, 0);
        p.setPaused(true);
        vm.warp(box.deadline());
        box.fail();
        assertEq(p.balanceOf(address(router)), tax);
        (uint256 pot, uint256 left) = box.claimState();
        p.setPaused(false);
        vm.startPrank(address(buyer));
        token.approve(address(box), left);
        assertEq(box.claim(left, address(buyer)), pot + tax, "claim sweeps tax before computing its share");
        vm.stopPrank();
        assertEq(p.balanceOf(address(router)), 0);
    }

    function test_creatorAndCoordinatorCallerRules() public {
        _start(_menu(1, 2));
        _buy(box.raise() / 5);
        receiver.collect(address(0));
        uint256 owed = receiver.creatorP();
        assertGt(owed, 0);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiverV2.NotPayee.selector, address(this)));
        receiver.claimCreator(address(0), address(this));
        vm.expectRevert(IBoxReceiverV2.NotGraduated.selector);
        vm.prank(CREATOR);
        receiver.claimCreator(address(0), CREATOR);
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiverV2.NotCoordinator.selector, address(this)));
        receiver.enterFailure();
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiverV2.NotCoordinator.selector, address(this)));
        receiver.onGraduation();
        assertEq(receiver.creatorP(), owed);
        _fill();
        box.graduate();
        receiver.collect(address(0));
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiverV2.NotPayee.selector, address(this)));
        receiver.claimCreator(address(0), address(this));
        owed = receiver.creatorP();
        vm.prank(CREATOR);
        assertEq(receiver.claimCreator(address(0), CREATOR), owed);
        vm.prank(CREATOR);
        assertEq(receiver.claimCreator(address(0), CREATOR), 0);
    }

    function test_zeroLedgersRefuseFutureChoicesAndOrdinaryBoxKeepsItsExit() public {
        _start(_menu(1, 2));
        assertEq(receiver.holderLedger(), address(0));
        assertEq(receiver.itemLedger(), address(0));
        // The factory refuses M2/M3 choices in M1 before any funds or clones can be created.
        BoxSpec memory s = _menu(1, 2);
        s.buyers.a.dest = 6;
        s.buyers.a.destParams = abi.encode(uint8(1));
        assertGt(factory.refusal(s, CREATOR).length, 0);
        // Also test the real receiver's defensive initialization, independently of factory validation.
        ReceiverArgs memory a;
        a.coordinator = address(box);
        a.hook = address(hook);
        a.p = address(0);
        a.t = address(token);
        a.launchRouter = box.launchRouter();
        a.registry = address(registry);
        a.creatorPayee = CREATOR;
        a.batchMinQ = 1;
        a.stepMinQ = 1;
        a.sellersChoice = 1;
        for (uint8 choice = 4; choice <= 5; ++choice) {
            a.buyersChoice = choice;
            IBoxReceiverV2 invalid = IBoxReceiverV2(
                BoxClones.create(BoxClones.initCode(release.implementations[5], BoxReceiverV2Args.encode(a)))
            );
            vm.expectRevert(IBoxReceiverV2.InvalidChoice.selector);
            vm.prank(address(box));
            invalid.initialize();
            assertEq(pm.balanceOf(address(invalid), 0), 0);
        }
        _buy(box.raise() / 10);
        receiver.collect(address(0));
        assertEq(pm.balanceOf(address(0), 0), 0);
        vm.warp(box.deadline());
        box.fail();
        _claimBuyer();
    }
}
