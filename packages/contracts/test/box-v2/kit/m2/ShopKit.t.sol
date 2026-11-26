// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ShopKit} from "./ShopKit.sol";

contract ShopKitTest is ShopKit {
    function test_seedAndChunksNeverSubstituteForExplicitCompletion() public {
        _shopBox(10, 100); assertEq(shop.budgetT(), 0); assertEq(nft.balanceOf(CREATOR), 10);
        gate.chunksReady(); shopModel.chunksReady(); _page(0, 10);
        vm.expectRevert(); loader.complete(); assertFalse(gate.gateOpen());
        _seed(); assertFalse(gate.gateOpen());
        loader.complete(); shopModel.complete(); _assertShop();
        assertEq(gate.effectiveOpenAt(), block.timestamp + 1);
        vm.expectRevert(); loader.complete();
    }
    function test_seedOnlyAndBothGateOrdersAndRetry() public {
        _shopBox(0, 100); _seed(); gate.setRefuseOpen(true);
        loader.complete(); shopModel.complete(); assertFalse(gate.gateOpen());
        vm.expectRevert(); gate.chunksReady(); assertFalse(gate.gateOpen());
        gate.setRefuseOpen(false); gate.chunksReady(); shopModel.chunksReady(); _assertShop();
        _shopBox(10, 0); gate.chunksReady(); shopModel.chunksReady(); _page(0, 10);
        gate.setRefuseOpen(true); vm.expectRevert(); loader.complete();
        (,, bool done) = loader.progress(); assertFalse(done);
        gate.setRefuseOpen(false); loader.complete(); shopModel.complete(); _assertShop();
    }
    function test_pageRevertsAtomicallyForBadHashMissingApprovalAndHostileNFT() public {
        _shopBox(10, 0);
        vm.prank(CREATOR); nft.setApprovalForAll(address(shop), false);
        vm.expectRevert(); this.loadPage(0, 3); _assertLoaded(0);
        vm.prank(CREATOR); nft.setApprovalForAll(address(shop), true);
        nft.setBlocked(2, true); vm.expectRevert(); this.loadPage(0, 3); _assertLoaded(0);
        assertEq(nft.ownerOf(1), CREATOR); nft.setBlocked(2, false);
        bytes32 valid = suffix[3]; suffix[3] = bytes32(uint256(1));
        vm.expectRevert(); this.loadPage(0, 3); _assertLoaded(0); suffix[3] = valid;
        _page(0, 3); _assertLoaded(3);
    }
    function test_boundsAuthorizationAndPartialFailure() public {
        _shopBox(40, 100);
        vm.expectRevert(); this.loadPage(0, 33); _assertLoaded(0);
        vm.expectRevert(); gate.starterSetLoaded();
        vm.expectRevert(); shop.loadStarter(address(nft), 1, 0);
        _seed(); _page(0, 7); gate.fail(); shopModel.fail(); _assertShop();
        vm.expectRevert(); this.loadPage(7, 1); vm.expectRevert(); loader.complete();
        uint256[] memory indexes = new uint256[](7); for (uint256 i; i < 7; ++i) indexes[i] = i;
        nft.setBlocked(2, true); assertEq(shop.returnStarter(indexes), 6);
        assertEq(nft.ownerOf(2), address(shop)); assertEq(nft.ownerOf(1), CREATOR);
        nft.setBlocked(2, false); assertEq(shop.returnStarter(indexes), 1); shopModel.returnItems();
        assertEq(nft.balanceOf(CREATOR), 40); assertEq(shop.returnStarter(indexes), 0);
        assertEq(t.balanceOf(CREATOR), 0); assertEq(shop.failedT(), 100);
    }
    function test_seedApprovalAndTransferRollback() public {
        _shopBox(0, 100);
        vm.expectRevert(); shop.fundSeed(); assertFalse(shop.seedReady());
        vm.prank(CREATOR); t.approve(address(shop), 100); t.setPaused(true);
        vm.expectRevert(); shop.fundSeed(); assertEq(shop.budgetT(), 0); assertEq(t.balanceOf(CREATOR), 100);
        t.setPaused(false); _seed(); vm.expectRevert(); shop.fundSeed(); _assertShop();
    }
    function test_claimsAndLiquidQuarantineBurnRetryNeverReturnsT() public {
        _shopBox(10, 100); _seed(); _page(0, 3); _shopClaims(40);
        gate.fail(); shopModel.fail(); _assertShop();
        vm.mockCallRevert(address(t), abi.encodeWithSignature("burn(uint256)", 140), "blocked burn");
        assertEq(shop.burnFailedT(), 0); assertEq(shopModel.burn(false), 0);
        assertEq(shop.failedT(), 140); assertEq(t.balanceOf(address(shop)), 100);
        assertEq(pm.balanceOf(address(shop), uint256(uint160(address(t)))), 40);
        vm.clearMockedCalls(); assertEq(shop.burnFailedT(), shopModel.burn(true));
        assertEq(shop.failedT(), 0); assertEq(t.balanceOf(CREATOR), 0); assertEq(t.totalSupply(), 0);
        assertEq(shop.burnFailedT(), 0); vm.expectRevert(); loader.complete();
    }
    function testFuzz_arbitraryPagesPreserveTheOrderedCommitment(uint8 rawCount, uint8 rawPage) public {
        uint256 count = 10 + uint256(rawCount) % 61; uint256 width = 1 + uint256(rawPage) % 32;
        _shopBox(count, 0);
        for (uint256 i; i < count;) { uint256 n = count - i < width ? count - i : width; _page(i, n); i += n; }
        loader.complete(); shopModel.complete(); gate.chunksReady(); shopModel.chunksReady(); _assertShop();
        assertEq(nft.balanceOf(address(shop)), count); _assertLoaded(count);
    }
    // External test frame permits expectRevert around a helper that also drives actor pranks.
    function loadPage(uint256 start, uint256 n) external { _page(start, n); }
}
