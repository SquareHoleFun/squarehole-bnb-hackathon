// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M244Base} from "../../m2-44/Fixture.sol";
import {IShopVaultV2} from "../../../../src/box-v2/interfaces/IShopVaultV2.sol";
import {BoxSpec} from "../../../../src/box-v2/interfaces/SpecTypes.sol";
import {IBoxFactoryV2} from "../../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {HostileCollection} from "../../kit/m2/ShopDoubles.sol";

/// Every voluntarily funded shop budget needs an eventual permitted spending path.
contract M263ShopExitTest is M244Base {
    function _drainStarter(uint256 seed) private {
        _createShop(0, seed, true, true);
        _fill(); box.graduate();
        vm.prank(address(buyer)); token.approve(address(shop), type(uint256).max);
        for (uint256 id; id < 9; ++id) {
            vm.prank(address(buyer));
            assertEq(shop.pick(address(nft), id, 1.5 ether, ALICE), 1.5 ether);
        }
        nft.mint(ALICE, 10);
        vm.prank(ALICE); nft.setApprovalForAll(address(shop), true);
        vm.warp(vm.getBlockTimestamp() + 365 days);
    }

    function test_fundedGraduatedShopCannotReachNoGiveNoPickState() public {
        nft = new HostileCollection();
        bytes32 root;
        for (uint256 i = 10; i != 0;) {
            --i; nft.mint(CREATOR, i);
            root = keccak256(abi.encode(address(nft), i, uint8(0), root));
        }
        BoxSpec memory s = _shop(address(nft), root, 10, 1 ether);
        bytes memory refusal = abi.encodeWithSelector(IBoxFactoryV2.InvalidSpec.selector, uint16(4), uint16(30));
        assertEq(factory.refusal(s, CREATOR), refusal, "unsafe seed must be refused before custody");
        uint256 creatorP = CREATOR.balance;
        uint256 factoryP = address(factory).balance;
        vm.prank(CREATOR); vm.expectRevert(refusal);
        factory.createBox{value: 1 ether}(s, 0, 0);
        assertEq(CREATOR.balance, creatorP); assertEq(address(factory).balance, factoryP);
        for (uint256 i; i < 10; ++i) assertEq(nft.ownerOf(i), CREATOR);
    }

    function test_local40TSeedAdmissionProposalKeepsGiveAndPickExits() public {
        // Historical 40 T control remains live; F132 also admits the smaller two-give seed.
        _drainStarter(40 ether);
        assertEq(shop.budgetT(), 53.5 ether);
        vm.prank(ALICE); assertEq(shop.give(address(nft), 10, 1 ether), 1 ether);
        assertEq(token.balanceOf(ALICE), 1 ether);
        assertEq(shop.inside(), 2);
        vm.prank(address(buyer)); assertEq(shop.pick(address(nft), 9, 1.5 ether, ALICE), 1.5 ether);
        assertEq(shop.inside(), 1);
        assertEq(shop.budgetT(), 54 ether);
        assertEq(token.balanceOf(address(shop)), shop.budgetT());
    }
}
