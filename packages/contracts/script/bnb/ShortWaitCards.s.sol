// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {TestTradingCards} from "../../src/test-coins/TestTradingCards.sol";
import {BnbTestnet} from "./BnbTestnet.sol";

/// @notice SH-300: the new card shop box's starter cards. For each of the four live card collections (one per tier),
/// the collection's owner (the deploy wallet, the sender) mints the given ids to `to`, with the picture the catalog's
/// rule fixes. An id that exists already is skipped if `to` holds it and stops the script otherwise, so a second run
/// after a stop sends only what is missing. Run through the driver's extra hook.
contract ShortWaitCards is Script {
    function run(address[4] memory cards, address to, uint256[4] memory ids) external {
        BnbTestnet.check(block.chainid);
        require(to != address(0), "receiver");
        for (uint256 t; t < 4; ++t) {
            TestTradingCards c = TestTradingCards(cards[t]);
            require(c.owner() == msg.sender && uint256(c.tier()) == t, "the sender owns this tier's collection");
        }
        vm.startBroadcast(msg.sender);
        for (uint256 t; t < 4; ++t) {
            TestTradingCards c = TestTradingCards(cards[t]);
            for (uint256 i; i < 4; ++i) {
                (bool exists, address holder) = _holder(c, ids[i]);
                if (exists) { require(holder == to, "an id exists with another holder"); continue; }
                c.mint(to, ids[i], c.pictureFor(ids[i]));
            }
        }
        vm.stopBroadcast();
        console.log(string.concat("BNB|cardsTo|", vm.toString(to)));
    }

    function _holder(TestTradingCards c, uint256 id) private view returns (bool, address) {
        try c.ownerOf(id) returns (address holder) { return (true, holder); } catch { return (false, address(0)); }
    }
}
