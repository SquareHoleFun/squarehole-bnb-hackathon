// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC721Holder} from "v4-core/lib/openzeppelin-contracts/contracts/token/ERC721/utils/ERC721Holder.sol";
import {TestTradingCards} from "../../src/test-coins/TestTradingCards.sol";
import {TestTradingCardsCatalog as Catalog} from "../../src/test-coins/TestTradingCardsCatalog.sol";
import {BoxEncoding} from "../../src/box/libraries/BoxEncoding.sol";

// Models only a holder's ERC721 receiver (the creator's Safe or a test wallet contract).
contract CardHolder is ERC721Holder {}

/// SH-262: the card shop's four stand-in collections, one per rarity tier.
contract TestTradingCardsTest is Test {
    address private constant OWNER = address(0xCA4D);
    CardHolder private holder;
    TestTradingCards[4] private cards;

    function setUp() public {
        vm.chainId(97);
        holder = new CardHolder();
        for (uint8 tier; tier < 4; ++tier) {
            cards[tier] = new TestTradingCards(OWNER, tier);
            vm.startPrank(OWNER);
            for (uint8 picture = 1; picture <= 4; ++picture) cards[tier].mint(address(holder), picture, picture);
            vm.stopPrank();
        }
    }

    function test_SH262_fourTiersNamedWithFourCardsEachAndEmbeddedMetadata() public view {
        string[4] memory names = ["Test Trading Cards Common", "Test Trading Cards Uncommon", "Test Trading Cards Rare",
            "Test Trading Cards Legendary"];
        string[4] memory symbols = ["tCARDC", "tCARDU", "tCARDR", "tCARDL"];
        string[4] memory rarities = ["Common", "Uncommon", "Rare", "Legendary"];
        string[4] memory first = ["Pebble", "Lantern", "Comet", "Sun Crown"];
        for (uint8 tier; tier < 4; ++tier) {
            TestTradingCards c = cards[tier];
            assertEq(c.name(), names[tier]);
            assertEq(c.symbol(), symbols[tier]);
            assertEq(c.owner(), OWNER);
            assertEq(c.tier(), tier);
            assertEq(c.balanceOf(address(holder)), 4);
            assertTrue(c.supportsInterface(0x80ac58cd)); // ERC-721, what the shop checks when a collection is listed
            assertTrue(c.supportsInterface(0x5b5e139f));
            assertFalse(c.supportsInterface(0xffffffff));
            assertEq(Catalog.cardName(tier, 1), first[tier]);
            for (uint8 picture = 1; picture <= 4; ++picture) {
                assertEq(c.ownerOf(picture), address(holder));
                assertEq(c.pictureOf(picture), picture);
                string memory image = string.concat("ipfs://", BoxEncoding.rawCidV1(Catalog.digest(tier, picture)));
                assertEq(c.imageURI(picture), image);
                string memory json = c.metadataJSON(picture);
                assertEq(vm.parseJsonString(json, ".image"), image);
                assertEq(vm.parseJsonString(json, ".name"), string.concat(Catalog.cardName(tier, picture), " #", vm.toString(picture)));
                assertEq(vm.parseJsonString(json, ".attributes[0].value"), rarities[tier]);
                assertEq(vm.parseJsonString(json, ".attributes[1].value"), Catalog.cardName(tier, picture));
                assertEq(vm.parseJsonString(json, ".attributes[2].value"),
                    string.concat(picture + tier * 4 < 10 ? "0" : "", vm.toString(uint256(picture) + tier * 4), "/16"));
                assertEq(c.tokenURI(picture), string.concat("data:application/json;base64,", BoxEncoding.base64(bytes(json))));
            }
        }
        // Sixteen distinct pictures across the four tiers.
        for (uint256 a; a < 16; ++a) {
            for (uint256 b = a + 1; b < 16; ++b) {
                assertTrue(Catalog.digest(uint8(a / 4), uint8(a % 4 + 1)) != Catalog.digest(uint8(b / 4), uint8(b % 4 + 1)));
            }
        }
    }

    function test_SH262_onlyOwnerMintsValidIdsAndPictures() public {
        TestTradingCards c = cards[3];
        vm.expectRevert("owner"); c.mint(address(holder), 5, 1);
        vm.startPrank(OWNER);
        vm.expectRevert(); c.mint(address(holder), 1, 1); // id taken
        vm.expectRevert("id and picture"); c.mint(address(holder), 0, 1);
        vm.expectRevert("id and picture"); c.mint(address(holder), 5, 0);
        vm.expectRevert("id and picture"); c.mint(address(holder), 5, 5);
        vm.expectRevert(); c.mint(address(0), 5, 1);
        vm.expectRevert(); c.mint(address(this), 5, 1); // not a receiver
        c.mint(address(holder), 5, 1); // the failed receipt did not use the id
        vm.stopPrank();
        assertEq(c.pictureOf(5), 1);
        assertEq(c.balanceOf(address(holder)), 5);
        vm.expectRevert(); c.tokenURI(99);
        vm.expectRevert(); c.imageURI(99);
        vm.expectRevert(); c.pictureOf(99);
    }

    /// The catalog's rule is enforced: id n takes picture (n - 1) mod 4 + 1 only; ids 1 to 4 are the four cards, ids 5 to
    /// 8 their second editions (as the stock step mints them); any other pairing is refused.
    function test_SH262_eachIdTakesOnlyItsCatalogPicture() public {
        TestTradingCards c = cards[1];
        for (uint256 id = 1; id <= 8; ++id) assertEq(c.pictureFor(id), uint8((id - 1) % 4 + 1));
        vm.expectRevert(bytes("id")); c.pictureFor(0);
        vm.startPrank(OWNER);
        for (uint256 id = 5; id <= 8; ++id) {
            for (uint8 picture = 1; picture <= 4; ++picture) {
                if (picture == c.pictureFor(id)) continue;
                vm.expectRevert("id and picture"); c.mint(address(holder), id, picture);
            }
            c.mint(address(holder), id, c.pictureFor(id));
            assertEq(c.pictureOf(id), id - 4);
            assertEq(c.imageURI(id), c.imageURI(id - 4)); // a second edition shows its first edition's picture
        }
        vm.stopPrank();
    }

    function testFuzz_SH262_mintedPicturesStayAndTransferNeedsApproval(uint256 id, uint8 wrong) public {
        id = bound(id, 9, type(uint256).max);
        TestTradingCards c = cards[2];
        uint8 picture = uint8((id - 1) % 4 + 1);
        wrong = uint8(bound(wrong, 0, 255));
        vm.startPrank(OWNER);
        if (wrong != picture) { vm.expectRevert("id and picture"); c.mint(address(holder), id, wrong); }
        c.mint(address(holder), id, picture);
        vm.stopPrank();
        assertEq(c.pictureOf(id), picture);
        string memory beforeURI = c.tokenURI(id);
        vm.expectRevert(); c.transferFrom(address(holder), OWNER, id);
        vm.prank(address(holder)); c.approve(address(this), id);
        c.transferFrom(address(holder), OWNER, id);
        assertEq(c.ownerOf(id), OWNER);
        assertEq(c.tokenURI(id), beforeURI);
    }

    function test_SH262_chainGuardAdmitsTestChainsOnly() public {
        vm.chainId(97);
        assertEq(new TestTradingCards(OWNER, 0).tier(), 0);
        vm.chainId(31337);
        assertEq(new TestTradingCards(OWNER, 1).tier(), 1);
        vm.chainId(11_155_111);
        assertEq(new TestTradingCards(OWNER, 2).tier(), 2);
        vm.chainId(56); // the BNB Chain main network
        vm.expectRevert("testnet only"); new TestTradingCards(OWNER, 0);
        vm.chainId(1);
        vm.expectRevert("testnet only"); new TestTradingCards(OWNER, 3);
        vm.chainId(97);
        vm.expectRevert("owner required"); new TestTradingCards(address(0), 0);
        vm.expectRevert("card tier"); new TestTradingCards(OWNER, 4);
    }
}
