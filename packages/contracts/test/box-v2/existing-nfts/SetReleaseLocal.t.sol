// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {SetLocalERC721, SetLocalFactorySlot, SetReleaseLocal} from "../../../script/local/SetReleaseLocal.s.sol";

contract SetReleaseLocalTest is Test {
    function testLocalCollectionSupportsSparseIdsAndDeferredRetry() public {
        SetLocalERC721 nft = new SetLocalERC721();
        uint256[] memory ids = new uint256[](3); ids[1] = type(uint256).max; ids[2] = 100003;
        nft.mintBatch(address(this), ids);
        assertEq(nft.ownerOf(0), address(this)); assertEq(nft.ownerOf(type(uint256).max), address(this));
        nft.setBlocked(0, true);
        vm.expectRevert("local deferred"); nft.transferFrom(address(this), address(17), 0);
        nft.setBlocked(0, false); nft.transferFrom(address(this), address(17), 0);
        assertEq(nft.ownerOf(0), address(17));
        vm.prank(address(18)); vm.expectRevert("issuer only"); nft.setBlocked(0, true);
    }
    function testFactorySlotIsSingleUseAndSenderBound() public {
        SetLocalFactorySlot slot = new SetLocalFactorySlot();
        vm.prank(address(18)); vm.expectRevert("local factory slot"); slot.deploy(type(SetLocalERC721).creationCode);
        address expected = vm.computeCreateAddress(address(slot), 1);
        assertEq(slot.deploy(type(SetLocalERC721).creationCode), expected);
        vm.expectRevert("local factory slot"); slot.deploy(type(SetLocalERC721).creationCode);
    }
}
