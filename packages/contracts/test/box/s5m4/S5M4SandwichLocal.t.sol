// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {S5M4Sandwich} from "./S5M4Sandwich.sol";

/// @notice S5.M4's sandwich campaign (BC-129) on the local world: the PoolManager compiled from the pinned v4-core
/// source (as upstream builds it), chain id 1. The same campaign runs on a mainnet fork in S5M4SandwichFork.t.sol.
contract S5M4SandwichLocalTest is S5M4Sandwich {
    function _world() internal override {
        _setUpLocal();
        _ready = true;
    }

    function test_BC129_everyStepTypeTradesAfterASmallPushAndWaitsPastTheBand() public {
        _everyTypeTradesAndWaits();
    }

    function testFuzz_BC129_sandwichNeverPays_buyBurn(uint256 ticks, bool sampledFirst) public {
        _round(BUY_BURN, ticks, sampledFirst);
    }

    function testFuzz_BC129_sandwichNeverPays_sellForFit(uint256 ticks, bool sampledFirst) public {
        _round(SELL_FOR_FIT, ticks, sampledFirst);
    }

    function testFuzz_BC129_sandwichNeverPays_buyForCreator(uint256 ticks, bool sampledFirst) public {
        _round(BUY_FOR_CREATOR, ticks, sampledFirst);
    }

    function testFuzz_BC129_sandwichNeverPays_sellForCreator(uint256 ticks, bool sampledFirst) public {
        _round(SELL_FOR_CREATOR, ticks, sampledFirst);
    }

    function testFuzz_BC129_sandwichNeverPays_standardConversion(uint256 ticks, bool sampledFirst) public {
        _round(CONVERT_STANDARD, ticks, sampledFirst);
    }

    function testFuzz_BC129_sandwichNeverPays_box0Conversion(uint256 ticks, bool sampledFirst) public {
        _round(CONVERT_BOX0, ticks, sampledFirst);
    }

    function testFuzz_BC129_sandwichNeverPays_fitExecutor(uint256 ticks, bool sampledFirst) public {
        _round(FIT_EXECUTOR, ticks, sampledFirst);
    }
}
