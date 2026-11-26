// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {StarterFixture, StarterPart} from "./StarterFixture.sol";
import {IBoxCoordinatorV2, ChunkPart} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";

contract StarterTest is StarterFixture {
    function test_creationPullsNothingAndExactSetPlusSeedRequiresExplicitCompletion() public {
        _make(10, 400, false, 0, false);
        _assertProgress(0, false); _assertState();
        assertEq(nft.balanceOf(CREATOR), 10); assertEq(token.balanceOf(address(shop)), 0);
        _page(0, 10); vm.expectRevert(); loader.complete();
        vm.prank(CREATOR); token.approve(address(shop), 400);
        vm.expectRevert(); loader.complete(); // approval alone is not seed custody
        _seed(); assertFalse(box.gateOpen()); _complete(); _assertProgress(10, true);
        assertEq(box.effectiveOpenAt(), block.timestamp + 1);
        assertEq(StarterPart(box.hook()).open(), box.effectiveOpenAt());
        assertEq(StarterPart(box.launchRouter()).open(), box.effectiveOpenAt());
        vm.expectRevert(); loader.complete(); vm.expectRevert(); this.loadPage(0, 1);
    }
    function test_chunksAndStarterBothOrdersPreserveScheduledOrNextSecondOpen() public {
        _make(10, 400, true, 2_000_000, false); _seed();
        _chunks(); assertFalse(box.gateOpen()); _page(0, 10); _complete();
        assertEq(box.effectiveOpenAt(), 2_000_000);
        _make(10, 400, true, 0, false); _seed();
        _page(0, 10); _complete(); assertFalse(box.gateOpen());
        vm.warp(block.timestamp + 50); _chunks(); assertEq(box.effectiveOpenAt(), block.timestamp + 1);
    }
    function test_seedOnlyStillRequiresReceivedSeedAndNotifiesOnce() public {
        _make(0, 400, false, 0, false); _assertProgress(0, false);
        vm.expectRevert(); loader.complete(); _seed(); _complete(); _assertProgress(0, true);
        vm.expectRevert(); loader.complete();
        _make(0, 400, false, 0, false); _seed(); _complete(); _assertProgress(0, true);
    }
    function test_failedNotificationRollsBackLoaderAndCoordinatorThenRetries() public {
        _make(10, 400, false, 0, false); _seed(); _page(0, 10);
        vm.mockCallRevert(box.launchRouter(), abi.encodeWithSignature("setOpen(uint256)", block.timestamp + 1), "no open");
        vm.expectRevert(); loader.complete(); _assertProgress(10, false); _assertState();
        assertTrue(box.starterSetPending()); assertEq(StarterPart(box.hook()).open(), 0);
        vm.clearMockedCalls(); _complete(); assertFalse(box.starterSetPending());
    }
    function test_creatorOnlyLoadAndLoaderOnlyNotification() public {
        _make(10, 400, false, 0, false); _seed();
        (address[] memory cs, uint256[] memory ids, uint8[] memory tiers) = _args(0, 1);
        vm.expectRevert(); loader.load(cs, ids, tiers, suffix[1]);
        vm.expectRevert(); shop.loadStarter(cs[0], ids[0], 0);
        vm.prank(CREATOR); vm.expectRevert(abi.encodeWithSelector(IBoxCoordinatorV2.NotStarterSetLoader.selector, CREATOR));
        box.starterSetLoaded(); _assertProgress(0, false);
        vm.expectRevert(); loader.complete(); _page(0, 9); vm.expectRevert(); loader.complete();
        _page(9, 1); _complete();
    }
    function test_wrongOrderHashTierCollectionAndMissingItemAreAtomic() public {
        _make(10, 400, false, 0, false); _seed();
        (address[] memory cs, uint256[] memory ids, uint8[] memory tiers) = _args(0, 3);
        ids[0] = 2; ids[1] = 1;
        vm.prank(CREATOR); vm.expectRevert(); loader.load(cs, ids, tiers, suffix[3]);
        ids[0] = 1; ids[1] = 2; tiers[1] = 1;
        vm.prank(CREATOR); vm.expectRevert(); loader.load(cs, ids, tiers, suffix[3]); tiers[1] = 0;
        cs[1] = address(second);
        vm.prank(CREATOR); vm.expectRevert(); loader.load(cs, ids, tiers, suffix[3]); cs[1] = address(nft);
        vm.prank(CREATOR); vm.expectRevert(); loader.load(cs, ids, tiers, bytes32(uint256(1)));
        nft.seize(2, OTHER); vm.expectRevert(); this.loadPage(0, 3);
        assertEq(nft.ownerOf(1), CREATOR); _assertProgress(0, false);
        nft.seize(2, CREATOR); _page(0, 3);
    }
    function test_missingApprovalOrBlockedMiddleItemRollsBackWholePage() public {
        _make(10, 400, false, 0, false); _seed();
        vm.prank(CREATOR); nft.setApprovalForAll(address(shop), false);
        vm.expectRevert(); this.loadPage(0, 3); _assertProgress(0, false);
        vm.prank(CREATOR); nft.setApprovalForAll(address(shop), true);
        nft.setBlocked(2, true); vm.expectRevert(); this.loadPage(0, 3);
        assertEq(nft.ownerOf(1), CREATOR); assertEq(shop.inside(), 0); _assertProgress(0, false);
        nft.setBlocked(2, false); _page(0, 3);
    }
    function test_duplicateCommitmentRefusesWithinPageAndAcrossPages() public {
        _make(10, 400, false, 0, true); _seed();
        vm.expectRevert(); this.loadPage(0, 2); assertEq(nft.ownerOf(1), CREATOR); _assertProgress(0, false);
        _page(0, 1); vm.expectRevert(); this.loadPage(1, 1); _assertProgress(1, false);
    }
    function test_boundsAndLengthMismatchCannotMoveNFTs() public {
        _make(40, 400, false, 0, false); _seed();
        vm.expectRevert(); this.loadPage(0, 0); vm.expectRevert(); this.loadPage(0, 33);
        (address[] memory cs, uint256[] memory ids,) = _args(0, 2);
        vm.prank(CREATOR); vm.expectRevert(); loader.load(cs, ids, new uint8[](1), suffix[2]);
        vm.prank(CREATOR); vm.expectRevert(); loader.load(new address[](1), ids, new uint8[](2), suffix[2]);
        _assertProgress(0, false); _page(0, 32); _page(32, 8); _complete();
    }
    function testFuzz_arbitraryPagePartitionsMatchFrozenModel(uint8 rawCount, bytes32 entropy) public {
        uint256 n = 10 + uint256(rawCount) % 61; _make(n, 400, true, 0, false); _seed();
        for (uint256 i; i < n;) {
            entropy = keccak256(abi.encode(entropy)); uint256 width = 1 + uint256(entropy) % 32;
            if (width > n - i) width = n - i; _page(i, width); i += width;
            assertEq(nft.balanceOf(address(shop)), i); assertEq(nft.balanceOf(CREATOR), n - i);
        }
        _complete(); _chunks(); _assertProgress(n, true);
        assertEq(token.balanceOf(CREATOR) + shop.budgetT(), 500);
    }
}
