// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M361ItemLife} from "../../property/m3/ItemLifeHarness.sol";
import {BoxTicketsV2} from "../../../../src/box-v2/BoxTicketsV2.sol";
import {MockDrandSource} from "../../../box/items/BoxItemsKit.sol";

/// Real factory/coordinator/custody/receiver/ledger/PM. Only M332 hook/checker handoffs are doubled.
contract MoneyLifecycleTest is M361ItemLife {
    function test_eachRealActionConservesEveryItemAndExactAdapterKey() public {
        pageSize = 1;
        _prepareItems(6, 5, 6);
        BoxTicketsV2 tickets = BoxTicketsV2(box.tickets());
        uint256 a = _drawItem(tickets);
        _compareItems(1);
        _state();
        _fundLive(1500);
        _compareItems(1);
        _state();
        uint256 b = _drawItem(tickets);
        _compareItems(1);
        _state();
        _fundLive(1517);
        _compareItems(1);
        _state();
        MockDrandSource drand = MockDrandSource(release.randomness);
        drand.post(address(tickets), a, keccak256("money A"));
        drand.post(address(tickets), b, keccak256("money B"));
        tickets.settle(2);
        _compareItems(1);
        _state();
        vm.warp(vm.getBlockTimestamp() + tickets.REVEAL_GRACE() + 1);
        uint256 bid = _deliver(tickets, b);
        _compareItems(1);
        _state();
        uint256 aid = _deliver(tickets, a);
        _compareItems(1);
        _state();
        (uint256 aP,) = items.itemCredit(aid);
        (uint256 bP,) = items.itemCredit(bid);
        assertGt(aP, bP, "same-second request before funding owns that interval alone");
        _claimItem(bid, ALICE);
        _claimItem(aid, ALICE);
    }

    function testFuzz_realMissedNoticesAndMixedChoicesConserve(uint64 word, uint8 kind) public {
        uint8 d = kind % 4 == 0 ? 0 : kind % 4 == 1 ? 6 : kind % 4 == 2 ? 8 : 18;
        uint8 b = kind % 3 == 0 ? 4 : 5;
        uint8 s = kind % 3 == 1 ? 4 : 6;
        _itemLife(d, b, s, word, true);
    }
}
