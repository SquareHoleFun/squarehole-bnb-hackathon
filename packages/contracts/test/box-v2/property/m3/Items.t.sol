// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M361ItemLife} from "./ItemLifeHarness.sol";
import {IBoxVaultItemsV2} from "../../../../src/box-v2/interfaces/IBoxVaultV2.sol";

contract M361ItemsTest is M361ItemLife {
    function test_eachTicketAndItemThroughCustody() public {
        _itemLife(0, 5, 6, 11, false);
        assertGt(IBoxVaultItemsV2(box.vault()).itemLifecycleCount(), 0, "M361: menu proof needs custody actions");
        assertGt(ticketKeys.length, 0, "M361: compare actual ticket keys, not only items");
    }
    function test_items0Buy5Sell5() public { _itemLife(0, 5, 5, 71, true); }
    function test_items0Buy5Sell6() public { _itemLife(0, 5, 6, 71, true); }
    function test_items0Buy6Sell5() public { _itemLife(0, 6, 5, 71, true); }
    function test_items0Buy6Sell6() public { _itemLife(0, 6, 6, 71, true); }
    function test_items0Buy4Sell5() public { _itemLife(0, 4, 5, 71, true); }
    function test_items0Buy4Sell6() public { _itemLife(0, 4, 6, 71, true); }
    function test_items0Buy5Sell4() public { _itemLife(0, 5, 4, 71, true); }
    function test_items0Buy6Sell4() public { _itemLife(0, 6, 4, 71, true); }
    function test_items6Buy5Sell5() public { _itemLife(6, 5, 5, 71, true); }
    function test_items6Buy5Sell6() public { _itemLife(6, 5, 6, 71, true); }
    function test_items6Buy6Sell5() public { _itemLife(6, 6, 5, 71, true); }
    function test_items6Buy6Sell6() public { _itemLife(6, 6, 6, 71, true); }
    function test_items6Buy4Sell5() public { _itemLife(6, 4, 5, 71, true); }
    function test_items6Buy4Sell6() public { _itemLife(6, 4, 6, 71, true); }
    function test_items6Buy5Sell4() public { _itemLife(6, 5, 4, 71, true); }
    function test_items6Buy6Sell4() public { _itemLife(6, 6, 4, 71, true); }
    function test_items8Buy5Sell5() public { _itemLife(8, 5, 5, 71, true); }
    function test_items8Buy5Sell6() public { _itemLife(8, 5, 6, 71, true); }
    function test_items8Buy6Sell5() public { _itemLife(8, 6, 5, 71, true); }
    function test_items8Buy6Sell6() public { _itemLife(8, 6, 6, 71, true); }
    function test_items8Buy4Sell5() public { _itemLife(8, 4, 5, 71, true); }
    function test_items8Buy4Sell6() public { _itemLife(8, 4, 6, 71, true); }
    function test_items8Buy5Sell4() public { _itemLife(8, 5, 4, 71, true); }
    function test_items8Buy6Sell4() public { _itemLife(8, 6, 4, 71, true); }
    function test_items18Buy5Sell5() public { _itemLife(18, 5, 5, 71, true); }
    function test_items18Buy5Sell6() public { _itemLife(18, 5, 6, 71, true); }
    function test_items18Buy6Sell5() public { _itemLife(18, 6, 5, 71, true); }
    function test_items18Buy6Sell6() public { _itemLife(18, 6, 6, 71, true); }
    function test_items18Buy4Sell5() public { _itemLife(18, 4, 5, 71, true); }
    function test_items18Buy4Sell6() public { _itemLife(18, 4, 6, 71, true); }
    function test_items18Buy5Sell4() public { _itemLife(18, 5, 4, 71, true); }
    function test_items18Buy6Sell4() public { _itemLife(18, 6, 4, 71, true); }
    function testFuzz_itemAndTicketLifecycle(uint32 seed) public {
        uint8[4] memory decimals = [uint8(0), 6, 8, 18];
        _itemLife(decimals[seed % 4], uint8(5 + (seed >> 2) % 2), uint8(5 + (seed >> 3) % 2), seed, seed % 2 == 0);
    }
}
