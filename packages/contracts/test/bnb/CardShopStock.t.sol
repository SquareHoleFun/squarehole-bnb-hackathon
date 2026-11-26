// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {TestTradingCards} from "../../src/test-coins/TestTradingCards.sol";
import {CardShopStock} from "../../script/bnb/CardShopStock.s.sol";

/// A contract of the same sender that describes itself as a card collection (owner, tier, name, ownerOf) but is not one.
contract LookAlikeCards {
    address public immutable owner;
    uint8 public immutable tier;
    constructor(address owner_, uint8 tier_) { owner = owner_; tier = tier_; }
    function name() external pure returns (string memory) { return "Test Trading Cards Rare"; }
    function ownerOf(uint256) external view returns (address) { return owner; }
}

/// The runtime code hashes of the four card collections of an owner (built here, never used).
contract CardCode {
    function hashes(address owner) external returns (bytes32[4] memory h) {
        for (uint8 tier; tier < 4; ++tier) h[tier] = address(new TestTradingCards(owner, tier)).codehash;
    }
}

/// SH-262: the stock step after a stop makes no second set of collections and mints only the missing cards.
contract CardShopStockTest is Test {
    address private constant CREATOR = address(0xC4ED);
    address private constant TESTER = address(0x7E57);

    function setUp() public { vm.chainId(97); }

    function _holdings(address[4] memory cards) private view {
        for (uint256 tier; tier < 4; ++tier) {
            TestTradingCards c = TestTradingCards(cards[tier]);
            assertEq(c.tier(), tier);
            assertEq(c.owner(), address(this));
            assertEq(c.balanceOf(CREATOR), 4);
            assertEq(c.balanceOf(TESTER), 4);
            for (uint256 id = 1; id <= 8; ++id) {
                assertEq(c.ownerOf(id), id <= 4 ? CREATOR : TESTER);
                assertEq(c.pictureOf(id), (id - 1) % 4 + 1);
            }
        }
    }

    /// Every card collection this sender has made, over all its nonces, by runtime code.
    function _collections() private returns (uint256 count) {
        bytes32[4] memory h = new CardCode().hashes(address(this));
        for (uint256 n; n < vm.getNonce(address(this)); ++n) {
            address at = vm.computeCreateAddress(address(this), n);
            for (uint256 tier; tier < 4; ++tier) if (at.code.length != 0 && at.codehash == h[tier]) ++count;
        }
    }

    function test_SH262_aRunAfterAStopReusesTheCollectionsAndMintsOnlyWhatIsMissing() public {
        CardShopStock script = new CardShopStock();
        // An interrupted run: the Common and Uncommon collections made, three cards minted, then the stop.
        TestTradingCards common = new TestTradingCards(address(this), 0);
        TestTradingCards uncommon = new TestTradingCards(address(this), 1);
        common.mint(CREATOR, 1, 1); common.mint(CREATOR, 2, 2); uncommon.mint(TESTER, 5, 1);
        // Unrelated contracts of the same sender are passed over: a card collection of another owner, and a look-alike
        // that answers owner, tier and name as the Rare collection would (identity is the runtime code, not the answers).
        new TestTradingCards(address(0xBEEF), 2);
        new LookAlikeCards(address(this), 2);
        address[4] memory found = script.existing(address(this));
        assertEq(found[0], address(common)); assertEq(found[1], address(uncommon));
        assertEq(found[2], address(0)); assertEq(found[3], address(0));
        address[4] memory cards = script.run(CREATOR, TESTER);
        assertEq(cards[0], address(common)); assertEq(cards[1], address(uncommon));
        assertEq(_collections(), 4, "four collections of this sender, no second set");
        _holdings(cards);
        // A finished run sends nothing.
        // (The test's broadcast moves the test contract's nonce by one per run, so count what a run does: its logs.)
        vm.recordLogs();
        address[4] memory again = script.run(CREATOR, TESTER);
        for (uint256 tier; tier < 4; ++tier) assertEq(again[tier], cards[tier]);
        assertEq(vm.getRecordedLogs().length, 0, "a second run mints and creates nothing");
        assertEq(_collections(), 4);
        _holdings(again);
    }

    function test_SH262_stockGuardsChainAndActors() public {
        CardShopStock script = new CardShopStock();
        vm.expectRevert("creator and tester"); script.run(CREATOR, CREATOR);
        vm.expectRevert("creator and tester"); script.run(address(0), TESTER);
        vm.chainId(56);
        vm.expectRevert(); script.run(CREATOR, TESTER);
    }
}
