// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ShopKit} from "./ShopKit.sol";
import {ShopDouble, StarterLoaderDouble, ShopGateDouble, HostileCollection} from "./ShopDoubles.sol";

contract ShopEdgesTest is ShopKit {
    function test_returnCannotReportSuccessWhenCollectionSeizesDuringTransfer() public {
        _shopBox(10, 0); _page(0, 1); gate.fail(); shopModel.fail();
        nft.arm(address(nft), abi.encodeCall(nft.seize, (1, address(0xdead))));
        uint256[] memory indexes = new uint256[](1);
        assertEq(shop.returnStarter(indexes), 0); assertEq(nft.ownerOf(1), address(shop));
        nft.arm(address(0), ""); assertEq(shop.returnStarter(indexes), 1); assertEq(nft.ownerOf(1), CREATOR);
    }
    function test_returnGasSinkAndSeizureCanRetryOtherItemsIndependently() public {
        _shopBox(10, 0); _page(0, 2); gate.fail(); shopModel.fail();
        uint256[] memory indexes = new uint256[](2); indexes[1] = 1;
        nft.setSink(true); assertEq(shop.returnStarter(indexes), 0); assertEq(nft.ownerOf(1), address(shop));
        nft.setSink(false); nft.seize(1, address(0xdead)); assertEq(shop.returnStarter(indexes), 1);
        assertEq(nft.ownerOf(2), CREATOR); nft.seize(1, address(shop)); assertEq(shop.returnStarter(indexes), 1);
    }
    function test_validCommitmentStillRejectsDuplicateItemsBeforeAnyPull() public {
        _shopBox(10, 0);
        ShopGateDouble duplicateGate = new ShopGateDouble(CREATOR, block.timestamp);
        ShopDouble duplicateShop = new ShopDouble(duplicateGate, t, pm, 0);
        bytes32[] memory hashes = new bytes32[](11);
        for (uint256 i = 10; i != 0;) { --i; hashes[i] = keccak256(abi.encode(address(nft), uint256(1), uint8(0), hashes[i + 1])); }
        StarterLoaderDouble duplicate = new StarterLoaderDouble(duplicateGate, duplicateShop, hashes[0], 10);
        duplicateGate.wire(duplicateShop, address(duplicate));
        vm.prank(CREATOR); nft.setApprovalForAll(address(duplicateShop), true);
        address[] memory collections = new address[](2); collections[0] = address(nft); collections[1] = address(nft);
        uint256[] memory ids = new uint256[](2); ids[0] = 1; ids[1] = 1; uint8[] memory tiers = new uint8[](2);
        vm.prank(CREATOR); vm.expectRevert(); duplicate.load(collections, ids, tiers, hashes[2]);
        assertEq(nft.ownerOf(1), CREATOR); (uint32 n,,) = duplicate.progress(); assertEq(n, 0);
    }
    function test_loaderBoundsCallerAndReentryCannotPartiallyPull() public {
        _shopBox(10, 0);
        vm.expectRevert(); new StarterLoaderDouble(gate, shop, bytes32(uint256(1)), 0);
        vm.expectRevert(); new StarterLoaderDouble(gate, shop, bytes32(uint256(1)), 9);
        vm.expectRevert(); new StarterLoaderDouble(gate, shop, bytes32(uint256(1)), 10001);
        address[] memory collections = new address[](1); collections[0] = address(nft);
        uint256[] memory ids = new uint256[](1); ids[0] = 1; uint8[] memory tiers = new uint8[](1);
        vm.expectRevert(); loader.load(collections, ids, tiers, suffix[1]);
        nft.arm(address(loader), abi.encodeCall(loader.complete, ()));
        vm.prank(CREATOR); vm.expectRevert(); loader.load(collections, ids, tiers, suffix[1]);
        _assertLoaded(0); assertEq(nft.ownerOf(1), CREATOR);
        nft.arm(address(0), ""); _page(0, 1); _assertLoaded(1);
    }
    function test_failureBeforeSeedNeverCountsAnApprovalAsCustody() public {
        _shopBox(0, 100); vm.prank(CREATOR); t.approve(address(shop), 100);
        gate.fail(); shopModel.fail(); _assertShop(); assertEq(shop.failedT(), 0);
        vm.expectRevert(); shop.fundSeed(); vm.expectRevert(); loader.complete();
        assertEq(t.balanceOf(CREATOR), 100); assertEq(shop.burnFailedT(), 0);
    }
}
