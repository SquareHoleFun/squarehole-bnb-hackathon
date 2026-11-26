// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IBoxVaultV2} from "../../../../src/box-v2/interfaces/IBoxVaultV2.sol";
import {BoxCollectionV2} from "../../../../src/box-v2/BoxCollectionV2.sol";
import {ItemLedgerV2} from "../../../../src/box-v2/ItemLedgerV2.sol";

import {M363Base} from "../../m3-63-fix-create/Fixture.sol";
import {SparseBoxTree} from "../../../box/items/BoxItemsKit.sol";
import {BoxSpec} from "../../../../src/box-v2/interfaces/SpecTypes.sol";
import {Branch} from "../../../../src/box-v2/interfaces/RecipeTypes.sol";
import {ListingClass} from "../../../../src/box-v2/interfaces/IListingRegistry.sol";
import {BoxTokenV2} from "../../../../src/box-v2/BoxTokenV2.sol";
import {BoxCoordinatorV2} from "../../../../src/box-v2/BoxCoordinatorV2.sol";
import {ChunkPart} from "../../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {IBoxHookV2} from "../../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {IBoxReceiverV2} from "../../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {BoxLayoutV2} from "../../../../src/box-v2/libraries/BoxLayoutV2.sol";

/// Real graduated holder-token A is listed and spent as the price coin of box B.
abstract contract LinkedPriceFixture is M363Base {
    address internal constant ALICE = address(0xA11CE);
    BoxTokenV2 internal price;
    BoxCoordinatorV2 internal origin;

    function _linked(bool items) internal {
        BoxSpec memory first = _spec();
        first.buyers.a = Branch(1, 6, "", abi.encode(uint8(1)));
        first.sellers.a = Branch(1, 6, "", abi.encode(uint8(1)));
        _start(first);
        _fill();
        box.graduate();
        origin = box;
        price = token;
        assertTrue(origin.roleAddress(17) != address(0), "P is the real history-writing token");
        vm.startPrank(address(buyer));
        price.transfer(address(this), 10_000);
        price.transfer(CREATOR, 1000 ether);
        vm.stopPrank();
        price.approve(address(listings), 10_000);
        uint32 id = listings.add(address(price), ListingClass.OTHER, 100 ether);
        BoxSpec memory second = items ? _items(1, 1) : _menu(1, 1);
        if (items) {
            second.n = 10;
            second.firstId = 1;
            (uint256[] memory positions, bytes32[] memory leaves) = _itemTree();
            second.revealRoot = SparseBoxTree.root(4, positions, leaves);
        }
        second.pricing.token = address(price);
        second.pricing.listingId = id;
        second.raise = 100 ether;
        vm.prank(CREATOR);
        price.approve(address(factory), 1000 ether);
        box = _create(second);
        if (!box.gateOpen()) box.loadChunk(ChunkPart.Table, second.metadataTable, 0);
        assertTrue(box.gateOpen(), "linked box is open after its committed table loads");
        token = BoxTokenV2(box.token());
        hook = IBoxHookV2(box.hook());
        receiver = IBoxReceiverV2(box.receiver());
        layout = BoxLayoutV2.curve(second.raise, false);
        vm.warp(box.effectiveOpenAt() + 384);
        vm.roll(block.number + 1);
        // The same swap actor now spends A's T as B's P. Funding is transferred, never minted for B.
        _buy(20 ether);
        receiver.collect(address(0));
        assertGt(receiver.fitOwed(), 0);
        assertGt(receiver.platformOwed(), 0);
        _booked();
    }

    function _itemTree() internal pure returns (uint256[] memory positions, bytes32[] memory leaves) {
        positions = new uint256[](10);
        leaves = new bytes32[](10);
        for (uint256 i; i < 10; ++i) {
            positions[i] = i;
            leaves[i] = SparseBoxTree.leaf(i + 1, 0, bytes32(i + 1), 0, 0, 0);
        }
    }

    function _linkedItemCredit() internal returns (ItemLedgerV2 ledger, uint256 owed) {
        _linked(true);
        _fill();
        box.graduate();
        receiver.collect(address(0));
        (uint256[] memory positions, bytes32[] memory leaves) = _itemTree();
        BoxCollectionV2(box.collection())
            .reveal(1, 0, bytes32(uint256(1)), 0, 0, 0, SparseBoxTree.proof(4, 0, positions, leaves));
        address vault = box.vault();
        uint256 held = token.balanceOf(address(buyer));
        vm.prank(address(buyer));
        token.transfer(ALICE, held);
        vm.startPrank(ALICE);
        token.approve(vault, type(uint256).max);
        IBoxVaultV2(vault).withdraw(1, type(uint256).max, block.timestamp);
        vm.stopPrank();
        assertEq(BoxCollectionV2(box.collection()).ownerOf(1), ALICE);
        assertEq(price.balanceOf(ALICE), 0, "fresh owner has never received linked P");
        ledger = ItemLedgerV2(box.roleAddress(16));
        ledger.sync(32);
        (uint256 outsideP, uint256 stashP) = ledger.itemCredit(1);
        owed = outsideP + stashP;
        assertEq(owed, 60673400673400673, "item 1 owns one tenth of the real graduation funding");
        assertEq(pm.balanceOf(address(ledger), uint160(address(price))), owed * 10);
    }

    function _unclaimedState(ItemLedgerV2 ledger) internal view returns (bytes32 state) {
        state = keccak256(
            abi.encode(
                price.totalSupply(),
                address(pm).balance,
                pm.balanceOf(origin.receiver(), 0),
                token.totalSupply(),
                token.totalBurned()
            )
        );
        for (uint256 id = 2; id <= 10; ++id) {
            (uint256 outsideP, uint256 stashP) = ledger.itemCredit(id);
            state = keccak256(abi.encode(state, outsideP, stashP));
        }
    }

    function _creditState(ItemLedgerV2 ledger) internal view returns (bytes32) {
        (uint256 outsideP, uint256 stashP) = ledger.itemCredit(1);
        return keccak256(abi.encode(outsideP, stashP));
    }
}
