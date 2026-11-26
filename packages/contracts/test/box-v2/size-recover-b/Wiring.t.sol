// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReceiverFixture, ReceiverArgs} from "../cq11-b/ReceiverFixture.sol";

/// @notice SIZE-B5: production clones use the helper fixed by their implementation constructor.
contract ReceiverViewsWiringTest is ReceiverFixture {
    function test_initializationReadsFixedPartAndRetainsPayee() public {
        ReceiverArgs memory a = _args(1, 4, 1, address(p));
        a.holderLedger = address(0xABCD);
        r = _clone(a);
        (address views,,) = implementation.receiverCode();
        vm.expectCall(views, abi.encodeWithSignature("checkInitial(address)", address(r)));
        coord.initialize(r);
        assertEq(r.creatorPayee(), PAYEE);
        assertEq(r.holderLedger(), a.holderLedger);
    }

    function test_buyBackReadsFixedPartAndStillBurnsExactly() public {
        r = _receiver(2, 2, 1, address(p), true);
        _pool();
        _fees(15_000, 0);
        r.collect(address(0));
        coord.graduation(r);
        (address views,,) = implementation.receiverCode();
        vm.expectCall(views, abi.encodeWithSignature("buyLimit(uint160)", uint160(1 << 96)));
        vm.expectCall(views, abi.encodeWithSignature("buyResult(int256,uint256,uint160,uint24)"));
        uint256 supply = t.totalSupply();
        uint256 budget = r.buyBackP();
        (, uint256 spent, uint256 bought, uint256 tip) = r.buyBack(TIP);
        assertEq(supply - t.totalSupply(), bought);
        assertEq(budget - r.buyBackP(), spent + tip);
        _booked();
    }
}
