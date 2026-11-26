// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {TestTradingCards} from "../../src/test-coins/TestTradingCards.sol";
import {BnbTestnet} from "./BnbTestnet.sol";

/// @notice SH-262, the card shop's stock on the BNB Chain test network (chain 97): the four test card collections, one
/// per rarity tier (0 Common to 3 Legendary), each owned by the sender, and the starting cards. Ids 1 to 4 of every tier
/// go to the creator (the shop's starter set); ids 5 to 8 of every tier go to a tester, who sells cards to the shop. Each
/// id shows the picture the catalog's rule fixes for it. Signed by the configured Foundry sender; reads no key.
///
/// Safe to run again after a stop: before sending, it reads the chain for the sender's collections of an earlier,
/// interrupted run (the CREATE addresses of the sender's last `LOOK_BACK` nonces whose runtime code is exactly
/// TestTradingCards with this sender as owner and that tier, compared by code hash with a reference built in the
/// simulation only) and for every card already minted; it makes only the missing collections and mints only the missing
/// cards. A finished run sends nothing. The window is a recovery aid for a stop, not a registry: the step is run once,
/// and its addresses are then read from the deployment file (`deployments/bnb-testnet/97-cards.json`).
/// Run beside lane c's steps through the driver's extra hook:
/// `deploy --extra script/bnb/CardShopStock.s.sol:CardShopStock:run(address,address) --extra-args <creator>,<tester>`.
contract CardShopStock is Script {
    uint256 internal constant STARTERS = 4;
    /// @notice How far back a rerun looks for a collection an interrupted run made: the sender's last 256 creations.
    uint256 public constant LOOK_BACK = 256;

    function run(address creator, address tester) external returns (address[4] memory cards) {
        BnbTestnet.check(block.chainid);
        require(creator != address(0) && tester != address(0) && creator != tester, "creator and tester");
        cards = existing(msg.sender);
        vm.startBroadcast(msg.sender);
        for (uint8 tier; tier < 4; ++tier) {
            if (cards[tier] == address(0)) cards[tier] = address(new TestTradingCards(msg.sender, tier));
            TestTradingCards c = TestTradingCards(cards[tier]);
            for (uint256 id = 1; id <= 2 * STARTERS; ++id) {
                if (!minted(c, id)) c.mint(id <= STARTERS ? creator : tester, id, c.pictureFor(id));
            }
        }
        vm.stopBroadcast();
        console.log(string.concat("BNB|cardsCommon|", vm.toString(cards[0])));
        console.log(string.concat("BNB|cardsUncommon|", vm.toString(cards[1])));
        console.log(string.concat("BNB|cardsRare|", vm.toString(cards[2])));
        console.log(string.concat("BNB|cardsLegendary|", vm.toString(cards[3])));
    }

    /// @notice The sender's collections of an earlier run, by tier (zero where none). Identified by runtime code: the
    /// code hash of a TestTradingCards built here for (sender, tier) (immutables included; the build happens in the
    /// script's simulation and is never broadcast). Reads no self-description of the candidates.
    function existing(address sender) public returns (address[4] memory found) {
        bytes32[4] memory expected;
        for (uint8 tier; tier < 4; ++tier) expected[tier] = address(new TestTradingCards(sender, tier)).codehash;
        uint256 nonce = vm.getNonce(sender);
        for (uint256 n = nonce > LOOK_BACK ? nonce - LOOK_BACK : 0; n < nonce; ++n) {
            address at = vm.computeCreateAddress(sender, n);
            if (at.code.length == 0) continue;
            for (uint8 tier; tier < 4; ++tier) {
                if (at.codehash == expected[tier] && found[tier] == address(0)) found[tier] = at;
            }
        }
    }

    /// @notice Whether a card exists already: read-only.
    function minted(TestTradingCards c, uint256 id) public view returns (bool) {
        try c.ownerOf(id) returns (address) { return true; } catch { return false; }
    }
}
