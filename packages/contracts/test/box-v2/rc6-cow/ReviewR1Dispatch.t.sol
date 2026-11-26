// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {IComposableCow} from "../../../src/box-v2/interfaces/IRoyaltyCow.sol";
import {RoyaltyCustodyTest} from "../rc5-c/RoyaltyCustody.t.sol";

/// @notice Independent contract review, round 1 (SH-V21-RC6-INT part 2), finding R1-1.
/// The CoW rules for royalty orders (cow-readiness CW7, cow-unified "Network fee on small lots") are: post an
/// order only when CoW quotes it, and skip an hour whose fee is above about 5%. Both live in our order poster.
/// ComposableCoW.create(params, true) emits ConditionalOrderCreated, and CoW Protocol's own watch-tower relays
/// every such order to the order book with no quote or fee check (docs.cow.fi, ComposableCoW). The inbox order
/// has buyAmount 1, so nothing on chain bounds the fee either. Pin: the inbox registers without dispatch, so only
/// a poster that applies the rules finds its orders. If the founder instead accepts CoW's watch-tower as the
/// poster, delete this pin and record that CW7 and the 5% skip no longer hold for inbox orders.
contract ReviewR1DispatchTest is RoyaltyCustodyTest {
    function test_R1_1_inboxOrderIsNotBroadcastToEveryWatchTower() public {
        vm.deal(address(router), 1 ether);
        vm.expectCall(router.composableCow(), abi.encodeCall(IComposableCow.create, (router.orderParams(), false)));
        router.refreshOrder();
    }
}
