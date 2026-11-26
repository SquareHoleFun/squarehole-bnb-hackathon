// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CQ11AFixture} from "./Fixture.sol";
import {ProtocolSkip} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";

contract CQ11ADeepenTest is CQ11AFixture {
    function _tClaims() internal view returns (uint256) {
        return pm.balanceOf(address(hook), uint256(uint160(address(t))));
    }

    function test_C15_deepenBurnsBoughtRemainder() public {
        _migrate();
        assertEq(_tClaims(), 0);
        uint256 supply = t.totalSupply();
        hook.deepen(address(0));
        assertEq(_tClaims(), 0, "unpaired bought T must burn");
        assertLt(t.totalSupply(), supply, "rounding remainder was burned");
    }

    function test_C15_refusedRemainderBurnRetainsClaims() public {
        _migrate();
        uint256 before = vm.snapshotState();
        hook.deepen(address(0));
        uint128 paired = hook.pairedLiquidity();
        uint256 budget = hook.depthBudget();
        uint256 burned = t.totalSupply();
        vm.revertToState(before);
        uint256 supply = t.totalSupply();
        t.setRefuseBurn(true);
        hook.deepen(address(0));
        assertGt(_tClaims(), 0);
        assertEq(supply - burned, _tClaims(), "same remainder retained only on refusal");
        assertEq(t.totalSupply(), supply);
        assertEq(hook.pairedLiquidity(), paired);
        assertEq(hook.depthBudget(), budget);
    }

    function test_C7_giftDoesNotChangePairingOrRemainder() public {
        _migrate();
        uint256 state = vm.snapshotState();
        hook.deepen(address(0));
        uint128 paired = hook.pairedLiquidity();
        uint256 budget = hook.depthBudget();
        vm.revertToState(state);
        t.mint(address(trader), 1e24);
        trader.gift(address(t), address(hook), 1e24);
        hook.deepen(address(0));
        assertEq(hook.pairedLiquidity(), paired);
        assertEq(hook.depthBudget(), budget);
        assertEq(_tClaims(), 1e24, "only the new remainder is burned");
    }

    function test_C7_freshRecipientPaidAndMultiBlockTipTotal() public {
        _migrate();
        trader.gift(address(p), address(hook), layout.raise);
        uint256 moved;
        uint256 tips;
        for (uint160 i = 1; i <= 12; ++i) {
            vm.roll(block.number + 1);
            address recipient = address(0xb000 + i);
            uint256 before = hook.depthBudget();
            (ProtocolSkip skip, uint256 qUsed,, uint256 tip) = hook.deepen(recipient);
            assertEq(uint256(skip), uint256(ProtocolSkip.None));
            assertGt(qUsed, 0);
            uint256 work = before - hook.depthBudget() - tip;
            assertEq(tip, work / 20);
            assertGt(tip, 0, "ordinary fresh recipient must receive its incentive");
            assertEq(p.balanceOf(recipient), tip);
            moved += work; tips += tip;
        }
        assertLe(tips, moved / 20);
    }
}
