// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ShopFixture} from "./ShopFixture.sol";
import {ShopModel} from "../m2-00/ShopModel.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IBoxToken} from "../../../src/box/interfaces/IBoxToken.sol";

contract FailureTest is ShopFixture {
    function _indexes(uint256 n) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](n); for (uint256 i; i < n; ++i) ids[i] = i;
    }
    function test_modelParitySeedPartialLoadClaimsFailureAndRetry() public {
        ShopModel model = new ShopModel(CREATOR, address(this), 10000);
        assertEq(shop.seedReady(), model.seedReady()); assertEq(shop.budgetT(), model.budgetT());
        vm.prank(CREATOR); model.approveSeed(10000); model.fundSeed(); _fund();
        assertEq(shop.seedReady(), model.seedReady()); assertEq(shop.budgetT(), model.budgetT());
        model.commit(keccak256(abi.encode(address(0x721), uint256(1), uint8(0), bytes32(0))), 1);
        model.load(1, 0); _load(1); assertEq(shop.inside(), model.loaded());
        model.addClaims(50); driver.mintClaims(Currency.wrap(address(token)), address(shop), 50);
        model.fail(); _fail(); assertEq(shop.failedT(), model.excluded());
        uint256 before = token.balanceOf(CREATOR);
        assertEq(shop.returnStarter(_indexes(1)), model.returnItems());
        assertEq(nfts[0].ownerOf(1), model.returnedTo()); assertEq(token.balanceOf(CREATOR), before);
        // A refused burn is isolated; no liquid or claims can leave the failed shop.
        vm.mockCallRevert(address(token), abi.encodeWithSelector(IBoxToken.burn.selector), "paused");
        assertEq(shop.burnFailedT(), model.burn(false)); assertEq(shop.failedT(), model.excluded());
        vm.clearMockedCalls(); uint256 supply = token.totalSupply();
        assertEq(shop.burnFailedT(), model.burn(true)); assertEq(shop.failedT(), model.excluded());
        assertEq(token.totalSupply(), supply - 10050); assertEq(shop.burnFailedT(), 0);
        assertEq(token.balanceOf(CREATOR), before); assertEq(model.returnedT(), 0);
    }
    function test_unfundedFailureExcludesNoCommittedSeed() public {
        ShopModel model = new ShopModel(CREATOR, address(this), 10000);
        model.fail(); _fail(); assertEq(shop.failedT(), model.excluded());
        assertFalse(shop.seedReady()); vm.expectRevert(); shop.fundSeed();
    }
    function test_failedReturnsIsolateGasSinksAndLargeRevertsAndRemainRetryable() public {
        _fund(); _load(1);
        nfts[1].mint(CREATOR, 2); vm.prank(LOADER); shop.loadStarter(address(nfts[1]), 2, 0);
        _fail(); nfts[0].hostile(3, address(0), "");
        assertEq(shop.returnStarter{gas: 2300000}(_indexes(2)), 1);
        assertEq(nfts[0].ownerOf(1), address(shop)); assertEq(nfts[1].ownerOf(2), CREATOR);
        assertEq(shop.inside(), 1);
        nfts[0].hostile(4, address(0), ""); assertEq(shop.returnStarter(_indexes(1)), 0);
        nfts[0].hostile(0, address(0), ""); assertEq(shop.returnStarter(_indexes(2)), 1);
        assertEq(shop.returnStarter(_indexes(2)), 0); assertEq(shop.inside(), 0);
        assertEq(shop.failedT(), 10000);
        vm.expectRevert(); shop.returnStarter(_indexes(33));
    }
    function test_burnGasSinkLeavesClaimsBackedAndLiquidRetryable() public {
        _fund(); driver.mintClaims(Currency.wrap(address(token)), address(shop), 77); _fail();
        bytes memory original = address(token).code;
        // Every token call consumes its stipend; burn must isolate even hostile balance/supply reads.
        vm.etch(address(token), hex"fe");
        assertEq(shop.burnFailedT{gas: 1400000}(), 0);
        vm.etch(address(token), original);
        assertEq(shop.failedT(), 10077); assertEq(shop.burnFailedT(), 10077); assertEq(shop.failedT(), 0);
    }
    function test_fundedSeedAndUnauthorizedLifecycleLoaderRefused() public {
        assertFalse(shop.seedReady()); _fund(); assertTrue(shop.seedReady());
        vm.expectRevert(); shop.initialize(); vm.expectRevert(); shop.openGate();
        vm.expectRevert(); shop.enterFailure(); vm.expectRevert(); shop.burnFailedT();
        nfts[0].mint(CREATOR, 1); vm.expectRevert(); shop.loadStarter(address(nfts[0]), 1, 0);
        vm.prank(LOADER); vm.expectRevert(); shop.loadStarter(address(nfts[0]), 1, 1);
        vm.prank(LOADER); shop.loadStarter(address(nfts[0]), 1, 0);
        vm.prank(LOADER); vm.expectRevert(); shop.loadStarter(address(nfts[0]), 1, 0);
        vm.expectRevert(); shop.returnStarter(_indexes(1));
    }
}
