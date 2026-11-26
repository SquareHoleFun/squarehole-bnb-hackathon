// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {StarterFixture} from "./StarterFixture.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IBoxCoordinatorV2, ChunkPart} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";

contract StarterRecoveryTest is StarterFixture {
    function _fail() private {
        vm.warp(box.openAt() + box.GATE_CAP()); box.failClosed(); model.fail(); _assertState();
    }
    function test_partialLoadFailureQuarantinesTAndReturnsOnlyCreatorNFTs() public {
        _make(10, 400, true, 0, false); _seed(); _page(0, 3);
        driver.mintClaims(Currency.wrap(address(token)), address(shop), 40); model.addClaims(40);
        vm.warp(box.openAt() + box.GATE_CAP() - 1);
        vm.expectRevert(); box.failClosed(); assertFalse(box.failed());
        // M2 money rule 9: the shop's liquid and claims T join H, so they are outside tLeft (INT-FIX9).
        _fail(); (,uint256 left) = box.claimState(); assertEq(left, 100);
        vm.expectRevert(); this.loadPage(3, 1); vm.expectRevert(); loader.complete();
        vm.prank(address(loader)); vm.expectRevert(IBoxCoordinatorV2.AlreadyFailed.selector); box.starterSetLoaded();
        box.loadChunk(ChunkPart.Table, hex"00", 0); assertFalse(box.gateOpen());
        nft.setBlocked(2, true);
        uint256[] memory indexes = new uint256[](3); indexes[1] = 1; indexes[2] = 2;
        vm.prank(OTHER); assertEq(shop.returnStarter(indexes), 2);
        assertEq(nft.ownerOf(1), CREATOR); assertEq(nft.ownerOf(2), address(shop)); assertEq(nft.ownerOf(3), CREATOR);
        nft.setBlocked(2, false); assertEq(shop.returnStarter(indexes), 1); assertEq(shop.returnStarter(indexes), 0);
        model.returnItems(); assertEq(nft.balanceOf(CREATOR), 10); assertEq(shop.inside(), 0);
        assertEq(token.balanceOf(CREATOR), 100); assertEq(shop.failedT(), 440);
        vm.mockCallRevert(address(token), abi.encodeWithSignature("burn(uint256)"), "burn refused");
        assertEq(shop.burnFailedT(), 0); _assertState(); vm.clearMockedCalls();
        assertEq(shop.burnFailedT(), model.burn(true)); _assertState();
        assertEq(token.balanceOf(CREATOR), 100); (,uint256 afterBurn) = box.claimState(); assertEq(afterBurn, left);
        _assertProgress(3, false);
    }
    function test_failureBeforeFundingKeepsApprovalOutOfCustody() public {
        _make(0, 400, false, 0, false); vm.prank(CREATOR); token.approve(address(shop), 400);
        _fail(); assertEq(shop.failedT(), 0); assertEq(shop.burnFailedT(), 0);
        vm.expectRevert(); shop.fundSeed(); vm.expectRevert(); loader.complete();
        assertEq(token.balanceOf(CREATOR), 500); _assertProgress(0, false);
    }
    function test_NFTCallbackCannotCompleteDuringPageOrReenterLoad() public {
        _make(10, 400, false, 0, false); _seed();
        nft.arm(address(loader), abi.encodeCall(loader.complete, ()));
        vm.expectRevert(); this.loadPage(0, 10); _assertProgress(0, false); assertEq(nft.ownerOf(1), CREATOR);
        (address[] memory cs, uint256[] memory ids, uint8[] memory tiers) = _args(0, 1);
        nft.arm(address(loader), abi.encodeCall(loader.load, (cs, ids, tiers, suffix[1])));
        vm.expectRevert(); this.loadPage(0, 10); _assertProgress(0, false);
        nft.arm(address(0), ""); _page(0, 10); _complete();
    }
    function test_gasBurningOrSeizingCollectionLeavesReturnsRetryable() public {
        _make(10, 400, true, 0, false); _seed(); _page(0, 2); _fail();
        uint256[] memory indexes = new uint256[](2); indexes[1] = 1;
        nft.setSink(true); assertEq(shop.returnStarter(indexes), 0);
        assertEq(nft.ownerOf(1), address(shop)); nft.setSink(false);
        nft.seize(1, OTHER); assertEq(shop.returnStarter(indexes), 1); assertEq(nft.ownerOf(2), CREATOR);
        nft.seize(1, address(shop)); assertEq(shop.returnStarter(indexes), 1); assertEq(shop.inside(), 0);
    }
}
