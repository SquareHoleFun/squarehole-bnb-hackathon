// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {NoFailureSweep} from "../rc5-a/NoFailureSweep.sol";
import {BoxV2TestBase} from "./BoxV2TestBase.sol";
import {IListingRegistry, ListingClass} from "../../../src/box-v2/interfaces/IListingRegistry.sol";
import {IBoxHookV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {IBoxReceiverV2, FeeBatchV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";

contract CQ11KitTest is BoxV2TestBase {
    function test_collectThroughFrozenInterfaceReturnsFourWordsAndDrainsOnce() public {
        hook.scriptSaleFee(15);
        IBoxReceiverV2 frozen = IBoxReceiverV2(address(receiver));
        FeeBatchV2 memory batch = frozen.collect(alice);
        assertEq(batch.buyersP, 0);
        assertEq(batch.sellersP, 15);
        assertEq(batch.qToReserve, 0);
        assertEq(batch.tip, 0);
        assertEq(hook.saleFeesPending(), 0);
        assertEq(p.balanceOf(address(receiver)), 15);
        batch = frozen.collect(alice);
        assertEq(batch.buyersP + batch.sellersP + batch.qToReserve + batch.tip, 0);
    }
    function test_saleFeeIsAlreadyAtReceiverAndCounterDrainsOnce() public {
        hook.scriptSaleFee(15);
        assertEq(p.balanceOf(address(receiver)), 15);
        assertEq(hook.saleFeesPending(), 15);
        vm.prank(address(receiver));
        (uint256 buyers, uint256 sellers, uint256 reserve) = hook.harvest();
        assertEq(buyers, 0); assertEq(sellers, 15); assertEq(reserve, 0);
        assertEq(hook.saleFeesPending(), 0);
        assertEq(p.balanceOf(address(receiver)), 15);
    }
    function test_sharedStepMark() public {
        hook.scriptProtocolStep();
        vm.expectRevert(IBoxHookV2.ProtocolStepTaken.selector);
        hook.scriptProtocolStep();
        vm.roll(block.number + 1);
        hook.scriptProtocolStep();
        assertEq(hook.lastProtocolBlock(), block.number);
    }
    function test_singleListingUpdatesOnlyFutureBoxSnapshots() public {
        uint32 id = listings.add(address(p), ListingClass.STABLE, 1e6);
        uint256 oldBoxRaise = listings.listing(id).raise;
        listings.updateRaise(id, 2e6);
        assertEq(oldBoxRaise, 1e6);
        assertEq(listings.listing(id).raise, 2e6);
        (bool found, uint32 sameId) = listings.newestListingOf(address(p));
        assertTrue(found); assertEq(sameId, id);
        vm.expectRevert(abi.encodeWithSelector(IListingRegistry.AlreadyListed.selector, address(p), id));
        listings.add(address(p), ListingClass.STABLE, 3e6);
    }
    function test_closeClaimRoundingAndLateMoneyStaysPut() public {
        t.mint(alice, 3);
        p.mint(address(hook), 10);
        box.fail();
        vm.startPrank(alice);
        t.approve(address(box), 3);
        assertEq(box.claim(1, alice), 3);
        assertEq(box.claim(2, alice), 7);
        vm.stopPrank();
        (uint256 pot, uint256 left) = box.claimState();
        assertEq(pot, 0); assertEq(left, 0);
        p.mint(address(box), 4);
        NoFailureSweep.check(address(box));
        assertEq(p.balanceOf(fitSafe), 0);
        assertEq(p.balanceOf(address(box)), 4);
    }
    function test_hatchCountsSevenDaysSinceFill() public {
        hook.scriptFill();
        vm.expectRevert(); box.fail();
        vm.warp(block.timestamp + 7 days);
        box.fail();
        assertTrue(box.failed());
    }
}
