// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ReferenceReceiverConfig} from "./ReferenceViews.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {BoxReceiverV2Args as A, ReceiverArgs} from "../../../src/box-v2/libraries/BoxReceiverV2Args.sol";

/// @notice SIZE-B2: configuration admission, first refusal and payee preserve the pinned receiver.
contract ReceiverConfigResultsTest is Test {
    ReferenceReceiverConfig private old;
    address private views;

    function setUp() public {
        old = new ReferenceReceiverConfig();
        views = deployCode("ReceiverViews.sol:ReceiverViews");
    }

    function test_allChoicesAndRoyaltyDestinations() public {
        ReceiverArgs memory a = _args();
        for (uint8 b; b <= 10; ++b) {
            for (uint8 s; s <= 10; ++s) {
                for (uint8 royalty; royalty <= 4; ++royalty) {
                    a.buyersChoice = b;
                    a.sellersChoice = s;
                    a.royaltyDestination = royalty;
                    _same(A.encode(a));
                }
            }
        }
    }

    function testFuzz_missingFieldsAndRefusalOrder(uint16 missing, uint8 b, uint8 s, uint8 royalty) public {
        // ShopT 11 is a new admission requiring a real shop; shop-fees/ShopFees.t.sol covers it.
        vm.assume(b != 11 && s != 11);
        ReceiverArgs memory a = _args();
        a.buyersChoice = b;
        a.sellersChoice = s;
        a.royaltyDestination = royalty;
        if (missing & 1 != 0) a.hook = address(0);
        if (missing & 2 != 0) a.t = address(0);
        if (missing & 4 != 0) a.launchRouter = address(0);
        if (missing & 8 != 0) a.registry = address(0);
        if (missing & 16 != 0) a.p = a.t;
        if (missing & 32 != 0) a.creatorPayee = address(0);
        if (missing & 64 != 0) a.holderLedger = address(0);
        if (missing & 128 != 0) a.itemLedger = address(0);
        if (missing & 256 != 0) a.batchMinQ = 0;
        if (missing & 512 != 0) a.stepMinQ = 0;
        _same(A.encode(a));
    }

    function test_truncatedArguments() public {
        bytes memory args = A.encode(_args());
        for (uint256 length; length <= A.LENGTH; ++length) {
            bytes memory truncated = new bytes(length);
            for (uint256 i; i < length; ++i) {
                truncated[i] = args[i];
            }
            _same(truncated);
        }
    }

    function _args() private pure returns (ReceiverArgs memory a) {
        a.hook = address(1);
        a.t = address(2);
        a.launchRouter = address(3);
        a.registry = address(4);
        a.creatorPayee = address(5);
        a.holderLedger = address(6);
        a.itemLedger = address(7);
        a.buyersChoice = 1;
        a.sellersChoice = 1;
        a.royaltyDestination = 1;
        a.batchMinQ = 1;
        a.stepMinQ = 1;
    }

    function _same(bytes memory args) private {
        address receiver = BoxClones.create(BoxClones.initCode(address(old), args));
        bytes memory data = abi.encodeCall(old.checkConfig, (receiver));
        (bool expectedOk, bytes memory expected) = receiver.staticcall(data);
        (bool actualOk, bytes memory actual) = views.staticcall(data);
        assertEq(actualOk, expectedOk, "config success/revert changed");
        assertEq(actual, expected, "config return/revert bytes changed");
    }
}
