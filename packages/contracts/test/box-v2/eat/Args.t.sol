// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BoxReceiverV2Args, ReceiverArgs} from "../../../src/box-v2/libraries/BoxReceiverV2Args.sol";

contract EatArgsTest is Test {
    // Keep the reviewed prefix's independent packed encoding while shrinking its production encoder.
    function testFuzz_EAT27_receiverPrefixMatchesReviewedWire(ReceiverArgs memory a) public pure {
        bytes memory expected = bytes.concat(
            abi.encodePacked(a.coordinator, a.hook, a.p, a.t, a.launchRouter, a.registry, a.creatorPayee),
            abi.encodePacked(a.boxId, a.batchMinQ, a.tipMaxQ, a.stepMinQ),
            abi.encodePacked(a.buyersChoice, a.sellersChoice, a.royaltyDestination, a.holderLedger, a.itemLedger)
        );
        assertEq(BoxReceiverV2Args.encode(a), expected);
        assertEq(expected.length, 263);
    }
}
