// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Keep the independent behavioral oracle; only isolated production code is mutated.
import {LedgerTradeTest} from "../m2-31/Trade.t.sol";

contract M262Notice is LedgerTradeTest {
    function test_buyReceiptContainsOnlyClaimsLeftAfterD6() public {
        RAISE = 340282366920938463376658674914100925496;
        setUp();
        _open();
        for (uint256 i; i < 3; ++i) {
            trader.trade(key, true, -int256(RAISE / 4), layout.sqrtPriceEndX96);
        }
        receiver.harvest(hook);
        uint256 reserve = hook.reserveMinted();
        assertGt(reserve, 0, "exercise a real D6 allocation");
        assertEq(pm.balanceOf(address(c), 0), reserve);
        assertTrue(hook.tradeBatch(1).closed);
        assertGt(hook.tradeBatch(1).netP, 0, "exercise holder funding after the reserve");
        assertEq(hook.tradeBatch(1).netP, pm.balanceOf(address(receiver), 0),
            "only actual receiver claims can fund the buy receipt");
        assertEq(hook.tradeBatch(2).netP, 0, "no sale source was funded");
    }
}
