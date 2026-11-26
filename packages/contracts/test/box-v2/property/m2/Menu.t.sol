// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M261Harness} from "./MenuHarness.sol";
import {BoxSpec} from "../../../../src/box-v2/interfaces/SpecTypes.sol";

/// M261-MENU: the M1 life builder must distinguish the fourth choice from depth.
contract M261MenuTest is M261Harness {
    function test_fourthChoiceCreatesTheHolderLedgerOnEitherSide() public {
        for (uint8 side; side < 2; ++side) {
            BoxSpec memory s = _m2Menu(side == 0 ? 4 : 3, side == 1 ? 4 : 3);
            _start(s);
            assertTrue(box.roleAddress(17) != address(0), "M261: fourth choice requires role 17");
            assertEq(receiver.holderLedger(), box.roleAddress(17));
            assertEq(hook.holderLedger(), box.roleAddress(17));
        }
    }

    function test_smokeHolderLifecycle() public { _life(3, 6, 4, 4, 0, 3); }
    function test_smokeCollectionFailure() public { _life(1, 8, 1, 4, 1, 3); }
    function test_smokeShopHatch() public { _life(4, 18, 4, 2, 2, 3); }
    function test_token0GraduationBuy1() public { _matrix(3, 0, 0, 1); }
    function test_token0GraduationBuy2() public { _matrix(3, 0, 0, 2); }
    function test_token0GraduationBuy3() public { _matrix(3, 0, 0, 3); }
    function test_token0GraduationBuy4() public { _matrix(3, 0, 0, 4); }
    function test_token0DeadlineBuy1() public { _matrix(3, 0, 1, 1); }
    function test_token0DeadlineBuy2() public { _matrix(3, 0, 1, 2); }
    function test_token0DeadlineBuy3() public { _matrix(3, 0, 1, 3); }
    function test_token0DeadlineBuy4() public { _matrix(3, 0, 1, 4); }
    function test_token0HatchBuy1() public { _matrix(3, 0, 2, 1); }
    function test_token0HatchBuy2() public { _matrix(3, 0, 2, 2); }
    function test_token0HatchBuy3() public { _matrix(3, 0, 2, 3); }
    function test_token0HatchBuy4() public { _matrix(3, 0, 2, 4); }
    function test_token6GraduationBuy1() public { _matrix(3, 6, 0, 1); }
    function test_token6GraduationBuy2() public { _matrix(3, 6, 0, 2); }
    function test_token6GraduationBuy3() public { _matrix(3, 6, 0, 3); }
    function test_token6GraduationBuy4() public { _matrix(3, 6, 0, 4); }
    function test_token6DeadlineBuy1() public { _matrix(3, 6, 1, 1); }
    function test_token6DeadlineBuy2() public { _matrix(3, 6, 1, 2); }
    function test_token6DeadlineBuy3() public { _matrix(3, 6, 1, 3); }
    function test_token6DeadlineBuy4() public { _matrix(3, 6, 1, 4); }
    function test_token6HatchBuy1() public { _matrix(3, 6, 2, 1); }
    function test_token6HatchBuy2() public { _matrix(3, 6, 2, 2); }
    function test_token6HatchBuy3() public { _matrix(3, 6, 2, 3); }
    function test_token6HatchBuy4() public { _matrix(3, 6, 2, 4); }
    function test_token8GraduationBuy1() public { _matrix(3, 8, 0, 1); }
    function test_token8GraduationBuy2() public { _matrix(3, 8, 0, 2); }
    function test_token8GraduationBuy3() public { _matrix(3, 8, 0, 3); }
    function test_token8GraduationBuy4() public { _matrix(3, 8, 0, 4); }
    function test_token8DeadlineBuy1() public { _matrix(3, 8, 1, 1); }
    function test_token8DeadlineBuy2() public { _matrix(3, 8, 1, 2); }
    function test_token8DeadlineBuy3() public { _matrix(3, 8, 1, 3); }
    function test_token8DeadlineBuy4() public { _matrix(3, 8, 1, 4); }
    function test_token8HatchBuy1() public { _matrix(3, 8, 2, 1); }
    function test_token8HatchBuy2() public { _matrix(3, 8, 2, 2); }
    function test_token8HatchBuy3() public { _matrix(3, 8, 2, 3); }
    function test_token8HatchBuy4() public { _matrix(3, 8, 2, 4); }
    function test_token18GraduationBuy1() public { _matrix(3, 18, 0, 1); }
    function test_token18GraduationBuy2() public { _matrix(3, 18, 0, 2); }
    function test_token18GraduationBuy3() public { _matrix(3, 18, 0, 3); }
    function test_token18GraduationBuy4() public { _matrix(3, 18, 0, 4); }
    function test_token18DeadlineBuy1() public { _matrix(3, 18, 1, 1); }
    function test_token18DeadlineBuy2() public { _matrix(3, 18, 1, 2); }
    function test_token18DeadlineBuy3() public { _matrix(3, 18, 1, 3); }
    function test_token18DeadlineBuy4() public { _matrix(3, 18, 1, 4); }
    function test_token18HatchBuy1() public { _matrix(3, 18, 2, 1); }
    function test_token18HatchBuy2() public { _matrix(3, 18, 2, 2); }
    function test_token18HatchBuy3() public { _matrix(3, 18, 2, 3); }
    function test_token18HatchBuy4() public { _matrix(3, 18, 2, 4); }
    function test_collection0GraduationBuy1() public { _matrix(1, 0, 0, 1); }
    function test_collection0GraduationBuy2() public { _matrix(1, 0, 0, 2); }
    function test_collection0GraduationBuy3() public { _matrix(1, 0, 0, 3); }
    function test_collection0GraduationBuy4() public { _matrix(1, 0, 0, 4); }
    function test_collection0DeadlineBuy1() public { _matrix(1, 0, 1, 1); }
    function test_collection0DeadlineBuy2() public { _matrix(1, 0, 1, 2); }
    function test_collection0DeadlineBuy3() public { _matrix(1, 0, 1, 3); }
    function test_collection0DeadlineBuy4() public { _matrix(1, 0, 1, 4); }
    function test_collection0HatchBuy1() public { _matrix(1, 0, 2, 1); }
    function test_collection0HatchBuy2() public { _matrix(1, 0, 2, 2); }
    function test_collection0HatchBuy3() public { _matrix(1, 0, 2, 3); }
    function test_collection0HatchBuy4() public { _matrix(1, 0, 2, 4); }
    function test_collection6GraduationBuy1() public { _matrix(1, 6, 0, 1); }
    function test_collection6GraduationBuy2() public { _matrix(1, 6, 0, 2); }
    function test_collection6GraduationBuy3() public { _matrix(1, 6, 0, 3); }
    function test_collection6GraduationBuy4() public { _matrix(1, 6, 0, 4); }
    function test_collection6DeadlineBuy1() public { _matrix(1, 6, 1, 1); }
    function test_collection6DeadlineBuy2() public { _matrix(1, 6, 1, 2); }
    function test_collection6DeadlineBuy3() public { _matrix(1, 6, 1, 3); }
    function test_collection6DeadlineBuy4() public { _matrix(1, 6, 1, 4); }
    function test_collection6HatchBuy1() public { _matrix(1, 6, 2, 1); }
    function test_collection6HatchBuy2() public { _matrix(1, 6, 2, 2); }
    function test_collection6HatchBuy3() public { _matrix(1, 6, 2, 3); }
    function test_collection6HatchBuy4() public { _matrix(1, 6, 2, 4); }
    function test_collection8GraduationBuy1() public { _matrix(1, 8, 0, 1); }
    function test_collection8GraduationBuy2() public { _matrix(1, 8, 0, 2); }
    function test_collection8GraduationBuy3() public { _matrix(1, 8, 0, 3); }
    function test_collection8GraduationBuy4() public { _matrix(1, 8, 0, 4); }
    function test_collection8DeadlineBuy1() public { _matrix(1, 8, 1, 1); }
    function test_collection8DeadlineBuy2() public { _matrix(1, 8, 1, 2); }
    function test_collection8DeadlineBuy3() public { _matrix(1, 8, 1, 3); }
    function test_collection8DeadlineBuy4() public { _matrix(1, 8, 1, 4); }
    function test_collection8HatchBuy1() public { _matrix(1, 8, 2, 1); }
    function test_collection8HatchBuy2() public { _matrix(1, 8, 2, 2); }
    function test_collection8HatchBuy3() public { _matrix(1, 8, 2, 3); }
    function test_collection8HatchBuy4() public { _matrix(1, 8, 2, 4); }
    function test_collection18GraduationBuy1() public { _matrix(1, 18, 0, 1); }
    function test_collection18GraduationBuy2() public { _matrix(1, 18, 0, 2); }
    function test_collection18GraduationBuy3() public { _matrix(1, 18, 0, 3); }
    function test_collection18GraduationBuy4() public { _matrix(1, 18, 0, 4); }
    function test_collection18DeadlineBuy1() public { _matrix(1, 18, 1, 1); }
    function test_collection18DeadlineBuy2() public { _matrix(1, 18, 1, 2); }
    function test_collection18DeadlineBuy3() public { _matrix(1, 18, 1, 3); }
    function test_collection18DeadlineBuy4() public { _matrix(1, 18, 1, 4); }
    function test_collection18HatchBuy1() public { _matrix(1, 18, 2, 1); }
    function test_collection18HatchBuy2() public { _matrix(1, 18, 2, 2); }
    function test_collection18HatchBuy3() public { _matrix(1, 18, 2, 3); }
    function test_collection18HatchBuy4() public { _matrix(1, 18, 2, 4); }
    function test_shop0GraduationBuy1() public { _matrix(4, 0, 0, 1); }
    function test_shop0GraduationBuy2() public { _matrix(4, 0, 0, 2); }
    function test_shop0GraduationBuy3() public { _matrix(4, 0, 0, 3); }
    function test_shop0GraduationBuy4() public { _matrix(4, 0, 0, 4); }
    function test_shop0DeadlineBuy1() public { _matrix(4, 0, 1, 1); }
    function test_shop0DeadlineBuy2() public { _matrix(4, 0, 1, 2); }
    function test_shop0DeadlineBuy3() public { _matrix(4, 0, 1, 3); }
    function test_shop0DeadlineBuy4() public { _matrix(4, 0, 1, 4); }
    function test_shop0HatchBuy1() public { _matrix(4, 0, 2, 1); }
    function test_shop0HatchBuy2() public { _matrix(4, 0, 2, 2); }
    function test_shop0HatchBuy3() public { _matrix(4, 0, 2, 3); }
    function test_shop0HatchBuy4() public { _matrix(4, 0, 2, 4); }
    function test_shop6GraduationBuy1() public { _matrix(4, 6, 0, 1); }
    function test_shop6GraduationBuy2() public { _matrix(4, 6, 0, 2); }
    function test_shop6GraduationBuy3() public { _matrix(4, 6, 0, 3); }
    function test_shop6GraduationBuy4() public { _matrix(4, 6, 0, 4); }
    function test_shop6DeadlineBuy1() public { _matrix(4, 6, 1, 1); }
    function test_shop6DeadlineBuy2() public { _matrix(4, 6, 1, 2); }
    function test_shop6DeadlineBuy3() public { _matrix(4, 6, 1, 3); }
    function test_shop6DeadlineBuy4() public { _matrix(4, 6, 1, 4); }
    function test_shop6HatchBuy1() public { _matrix(4, 6, 2, 1); }
    function test_shop6HatchBuy2() public { _matrix(4, 6, 2, 2); }
    function test_shop6HatchBuy3() public { _matrix(4, 6, 2, 3); }
    function test_shop6HatchBuy4() public { _matrix(4, 6, 2, 4); }
    function test_shop8GraduationBuy1() public { _matrix(4, 8, 0, 1); }
    function test_shop8GraduationBuy2() public { _matrix(4, 8, 0, 2); }
    function test_shop8GraduationBuy3() public { _matrix(4, 8, 0, 3); }
    function test_shop8GraduationBuy4() public { _matrix(4, 8, 0, 4); }
    function test_shop8DeadlineBuy1() public { _matrix(4, 8, 1, 1); }
    function test_shop8DeadlineBuy2() public { _matrix(4, 8, 1, 2); }
    function test_shop8DeadlineBuy3() public { _matrix(4, 8, 1, 3); }
    function test_shop8DeadlineBuy4() public { _matrix(4, 8, 1, 4); }
    function test_shop8HatchBuy1() public { _matrix(4, 8, 2, 1); }
    function test_shop8HatchBuy2() public { _matrix(4, 8, 2, 2); }
    function test_shop8HatchBuy3() public { _matrix(4, 8, 2, 3); }
    function test_shop8HatchBuy4() public { _matrix(4, 8, 2, 4); }
    function test_shop18GraduationBuy1() public { _matrix(4, 18, 0, 1); }
    function test_shop18GraduationBuy2() public { _matrix(4, 18, 0, 2); }
    function test_shop18GraduationBuy3() public { _matrix(4, 18, 0, 3); }
    function test_shop18GraduationBuy4() public { _matrix(4, 18, 0, 4); }
    function test_shop18DeadlineBuy1() public { _matrix(4, 18, 1, 1); }
    function test_shop18DeadlineBuy2() public { _matrix(4, 18, 1, 2); }
    function test_shop18DeadlineBuy3() public { _matrix(4, 18, 1, 3); }
    function test_shop18DeadlineBuy4() public { _matrix(4, 18, 1, 4); }
    function test_shop18HatchBuy1() public { _matrix(4, 18, 2, 1); }
    function test_shop18HatchBuy2() public { _matrix(4, 18, 2, 2); }
    function test_shop18HatchBuy3() public { _matrix(4, 18, 2, 3); }
    function test_shop18HatchBuy4() public { _matrix(4, 18, 2, 4); }

    function _matrix(uint8 kind, uint8 decimals, uint8 outcome, uint8 buys) private {
        uint256 initial = vm.snapshotState();
        for (uint8 sells = 1; sells <= 4; ++sells) {
            assertTrue(vm.revertToState(initial));
            this.runCase(kind, decimals, buys, sells, outcome, 3);
        }
    }

    /// @notice Test driver only; a fresh frame bounds salt-search memory separately for each menu case.
    function runCase(uint8 kind, uint8 decimals, uint8 buys, uint8 sells, uint8 outcome, uint256 divisor) external {
        require(msg.sender == address(this));
        _life(kind, decimals, buys, sells, outcome, divisor);
    }
}
