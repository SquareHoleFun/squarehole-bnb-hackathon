// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {RewardAccountingV21 as R} from "../../../src/box-v2/libraries/RewardAccountingV21.sol";
contract PayInTAccountingTest is Test {
    using R for R.State;
    R.State private state;
    function testFuzz_T08_queueConservesEveryBoughtToken(uint256 seed) public {
        uint256 totalP;
        for (uint256 i = 1; i <= 24; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 p = seed % 1e24 + 1;
            state.fund(i, p); totalP += p;
        }
        uint256 remaining = totalP; uint256 totalT;
        for (uint256 i; i < 17; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 p = i == 16 ? remaining : seed % (remaining + 1);
            uint256 t = p == 0 ? 0 : seed % 1e30;
            state.consume(p, t); remaining -= p; totalT += t;
        }
        uint256 allocated;
        for (uint256 i = 1; i <= 24; ++i) { (bool closed, uint256 t) = state.funding(i); assertTrue(closed); allocated += t; }
        assertEq(allocated, totalT);
        assertEq(state.consumedP, totalP);
    }
    function test_T09_partialBatchExposesBoughtTAndFailureClosesUnspentPortion() public {
        state.fund(1, 100); state.fund(2, 200);
        state.consume(99, 137);
        (bool closed, uint256 t) = state.funding(1); assertFalse(closed); assertEq(t, 137);
        state.consume(1, 7);
        (closed, t) = state.funding(1); assertTrue(closed); assertEq(t, 144);
        state.consume(200, 0);
        (closed, t) = state.funding(2); assertTrue(closed); assertEq(t, 0);
        (closed, t) = state.funding(1); assertTrue(closed); assertEq(t, 144);
    }
    function testFuzz_AF1_partialQueueConservesEveryBoughtToken(uint256 seed) public {
        for (uint256 i = 1; i <= 24; ++i) state.fund(i, 100);
        uint256 bought;
        for (uint256 i; i < 23; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 output = seed % 1e30;
            state.consume(99, output); bought += output;
            uint256 exposed;
            for (uint256 id = 1; id <= 24; ++id) { (, uint256 t) = state.funding(id); exposed += t; }
            assertEq(exposed, bought, "every partial purchase is assigned exactly once");
        }
        state.consume(2400 - state.consumedP, 0);
        uint256 finalT;
        for (uint256 id = 1; id <= 24; ++id) { (bool closed, uint256 t) = state.funding(id); assertTrue(closed); finalT += t; }
        assertEq(finalT, bought, "zero-T loss cannot reassign earlier purchases");
    }
    function test_T10_manyPurchaseHistoryPointsKeepOldEntitlementsStable() public {
        for (uint256 i = 1; i <= 1024; ++i) { state.fund(i, i * 3); state.consume(i * 3, i * 7); }
        for (uint256 i = 1; i <= 1024; ++i) { (bool closed, uint256 t) = state.funding(i); assertTrue(closed); assertEq(t, i * 7); }
    }
    function test_AF1_partialFundingAfter1024PurchasesRemainsAvailable() public {
        state.fund(1, 2048);
        for (uint256 i; i < 1024; ++i) state.consume(1, 7);
        (bool closed, uint256 t) = state.funding(1); assertFalse(closed); assertEq(t, 7168);
        state.consume(1024, 0);
        (closed, t) = state.funding(1); assertTrue(closed); assertEq(t, 7168);
    }
}
