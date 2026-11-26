// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RailShop} from "../src/RailShop.sol";
import {RailShopFactory} from "../src/RailShopFactory.sol";

interface IERC20O {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
    function symbol() external view returns (string memory);
}

interface ICardsO {
    function ownerOf(uint256 id) external view returns (address);
    function setApprovalForAll(address op, bool ok) external;
}

/// @notice SH-288 on Four.meme's rail: a card shop for a token that already exists on our OpenFour copy on chain 97
/// (bounties/openfour/deployments/97.json). On that copy the tax's creator part always goes to the requester, so the
/// shop is fed by hand: a holder transfers tokens to it. Then the holder of our real test cards stocks and gives, and a
/// token holder picks, each for its exact price. The factory is constructed as in the real run (Flap's DEX router,
/// PancakeSwap's router, our four test card collections). Set FORK_URL (the BNB test network); skipped otherwise.
/// The feeder's tokens are dealt on the fork (the copy's run wallet sold or handed in what it bought).
contract RailShopOpenFourForkTest is Test {
    address constant FLAP_ROUTER = 0xc9D63ddCB9549578057EAB6A83a543DdFEE2b8c3;
    address constant PANCAKE_ROUTER = 0xD99D1c33F9fC3444f8101754aBC46c52416550D1;
    address constant COMMON = 0x675A3eCDd3e46eC716Af19179B36e6f4d6a2A174;
    address constant UNCOMMON = 0xF4F372F7c73D0D6D85da691856B24B9ea1f2B577;
    address constant RARE = 0xf7204bC0D744E4cF466c89fC7260e9506a50eBFC;
    address constant LEGENDARY = 0x26C4f9298F88f203c7BC84e4eE3d9eA45680B143;
    address constant CARD_HOLDER = 0xc979F6Cb8902f56f76b926358dC451cBF8f310F0;
    /// The copy's two tokens: PTAX (the Bonding Tax preset with our rules vault) and PILE (the Pile Bonding preset).
    address constant PTAX = 0x00C80DFaC0465F10E9a8D3eFB9cEf8750a733835;
    address constant PILE = 0x64019AEA4e0322Dc6cd4e314315Cf08385C23AfC;

    address creator = address(uint160(0xC0DE0011));
    address feeder = address(uint160(0xC0DE0012));
    address buyer = address(uint160(0xC0DE0013));
    RailShopFactory shops;

    function setUp() public {
        string memory url = vm.envOr("FORK_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(url);
        require(block.chainid == 97, "FORK_URL is not the BNB test network");
        address[] memory routers = new address[](2);
        (routers[0], routers[1]) = (FLAP_ROUTER, PANCAKE_ROUTER);
        address[] memory cards = new address[](4);
        (cards[0], cards[1], cards[2], cards[3]) = (COMMON, UNCOMMON, RARE, LEGENDARY);
        shops = new RailShopFactory(routers, cards);
    }

    function test_openfour_ptax_fedByHand_stockGivePick() public {
        _fedByHand(PTAX, 5);
    }

    function test_openfour_pile_fedByHand_stockGivePick() public {
        _fedByHand(PILE, 7);
    }

    function _fedByHand(address token, uint256 cardId) internal {
        assertGt(token.code.length, 0, "an existing OpenFour token");
        address[] memory nfts = new address[](4);
        (nfts[0], nfts[1], nfts[2], nfts[3]) = (COMMON, UNCOMMON, RARE, LEGENDARY);
        uint256[] memory prices = new uint256[](4);
        (prices[0], prices[1], prices[2], prices[3]) = (1_000 ether, 2_000 ether, 4_000 ether, 8_000 ether);
        vm.prank(creator);
        RailShop shop = RailShop(payable(shops.create(token, address(0), PANCAKE_ROUTER, nfts, prices, 10_000, 100_000 ether)));
        assertEq(shops.shopOf(token, 0), address(shop));

        // Fed by hand: a holder sends tokens to the shop (a plain transfer: the budget grows by exactly that).
        deal(token, feeder, 200_000 ether);
        deal(token, buyer, 50_000 ether);
        vm.prank(feeder);
        assertTrue(IERC20O(token).transfer(address(shop), 100_000 ether));
        assertEq(shop.budget(), 100_000 ether, "the shop's budget is exactly what was sent");

        // Our real test cards: their holder stocks a Common and a Rare and gives a Legendary for its exact price.
        for (uint256 i; i < 4; ++i) assertEq(ICardsO(nfts[i]).ownerOf(cardId), CARD_HOLDER, "the holder has the card");
        vm.startPrank(CARD_HOLDER);
        ICardsO(COMMON).setApprovalForAll(address(shop), true);
        ICardsO(RARE).setApprovalForAll(address(shop), true);
        ICardsO(LEGENDARY).setApprovalForAll(address(shop), true);
        uint256[] memory one = new uint256[](1);
        one[0] = cardId;
        shop.stock(COMMON, one);
        shop.stock(RARE, one);
        uint256 h0 = IERC20O(token).balanceOf(CARD_HOLDER);
        shop.give(LEGENDARY, cardId, 8_000 ether);
        vm.stopPrank();
        assertEq(IERC20O(token).balanceOf(CARD_HOLDER) - h0, 8_000 ether, "the holder received exactly the give price");
        assertEq(shop.budget(), 100_000 ether - 8_000 ether);
        assertEq(ICardsO(LEGENDARY).ownerOf(cardId), address(shop));

        // A token holder picks the Rare for exactly its pick price (twice the give price).
        (, uint256 pickPrice) = shop.pricesOf(RARE);
        assertEq(pickPrice, 8_000 ether);
        uint256 b0 = IERC20O(token).balanceOf(buyer);
        vm.startPrank(buyer);
        IERC20O(token).approve(address(shop), pickPrice);
        shop.pick(RARE, cardId, pickPrice, buyer);
        vm.stopPrank();
        assertEq(b0 - IERC20O(token).balanceOf(buyer), pickPrice, "the buyer paid exactly the pick price");
        assertEq(shop.budget(), 100_000 ether - 8_000 ether + pickPrice);
        assertEq(ICardsO(RARE).ownerOf(cardId), buyer);
        assertEq(shop.cardCount(), 2);
        emit log_named_string("token", IERC20O(token).symbol());
        emit log_named_uint("budget after give and pick", shop.budget());
    }
}
