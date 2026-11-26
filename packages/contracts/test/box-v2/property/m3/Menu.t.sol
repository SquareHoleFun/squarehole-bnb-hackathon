// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M361Harness, BoxSpec} from "./MenuHarness.sol";
import {IShopVaultV2} from "../../../../src/box-v2/interfaces/IShopVaultV2.sol";

contract M361MenuTest is M361Harness {
    function test_shopMenuOpensWithSeedCoveringOneCheapestGive() public {
        _open(4, 6, 4, 4);
        IShopVaultV2 shop = IShopVaultV2(box.vault());
        assertTrue(shop.seedReady());
        assertTrue(box.gateOpen());
        assertEq(shop.budgetT(), 40 ether, "M361: 2.5% of seed covers one 1 T give");
        assertEq(token.balanceOf(address(shop)), shop.budgetT());
    }

    function test_smokeMixedKeep() public { _life(1, 6, 5, 4, 0); }
    function test_smokeMixedBurn() public { _life(1, 8, 4, 6, 0); }
    function test_smokeItemsHatch() public { _life(1, 0, 5, 6, 2); }
    function test_smokePileDeadline() public { _life(5, 8, 4, 1, 1); }
    function test_smokePileGraduation() public { _life(5, 18, 4, 2, 0); }
    function test_smokeShopHatch() public { _life(4, 6, 2, 4, 2); }
    function test_smokePlainGraduation() public { _life(3, 0, 1, 3, 0); }
    function test_fifthChoiceCreatesAnItemLedger() public {
        BoxSpec memory s = _hiddenSpec();
        s.buyers = _menuSide(5);
        s.sellers = _menuSide(3);
        _start(s);
        assertTrue(box.roleAddress(16) != address(0), "M361: fifth choice must create role 16");
    }

    function _matrix(uint8 kind, uint8 decimals, uint8 outcome, uint8 buyChoice) private {
        uint256 initial = vm.snapshotState();
        uint8 last = kind == 1 ? 6 : 4;
        for (uint8 sellChoice = 1; sellChoice <= last; ++sellChoice) {
            assertTrue(vm.revertToState(initial));
            this.runCase(kind, decimals, buyChoice, sellChoice, outcome);
        }
    }
    /// @notice Only this test driver; a fresh frame bounds CREATE2 search memory per menu case.
    function runCase(uint8 kind, uint8 decimals, uint8 b, uint8 s, uint8 outcome) external {
        require(msg.sender == address(this), "driver");
        _life(kind, decimals, b, s, outcome);
    }
    function testFuzz_menu(uint32 seed) public {
        uint8[4] memory kinds = [uint8(1), 3, 4, 5];
        uint8[4] memory decimals = [uint8(0), 6, 8, 18];
        uint8 kind = kinds[seed % 4];
        uint8 last = kind == 1 ? 6 : 4;
        _life(kind, decimals[(seed >> 2) % 4], uint8(1 + (seed >> 4) % last),
            uint8(1 + (seed >> 8) % last), uint8((seed >> 12) % 3));
    }
    function test_collection0GraduationBuy1() public { _matrix(1, 0, 0, 1); }
    function test_collection0GraduationBuy2() public { _matrix(1, 0, 0, 2); }
    function test_collection0GraduationBuy3() public { _matrix(1, 0, 0, 3); }
    function test_collection0GraduationBuy4() public { _matrix(1, 0, 0, 4); }
    function test_collection0GraduationBuy5() public { _matrix(1, 0, 0, 5); }
    function test_collection0GraduationBuy6() public { _matrix(1, 0, 0, 6); }
    function test_collection0DeadlineBuy1() public { _matrix(1, 0, 1, 1); }
    function test_collection0DeadlineBuy2() public { _matrix(1, 0, 1, 2); }
    function test_collection0DeadlineBuy3() public { _matrix(1, 0, 1, 3); }
    function test_collection0DeadlineBuy4() public { _matrix(1, 0, 1, 4); }
    function test_collection0DeadlineBuy5() public { _matrix(1, 0, 1, 5); }
    function test_collection0DeadlineBuy6() public { _matrix(1, 0, 1, 6); }
    function test_collection0HatchBuy1() public { _matrix(1, 0, 2, 1); }
    function test_collection0HatchBuy2() public { _matrix(1, 0, 2, 2); }
    function test_collection0HatchBuy3() public { _matrix(1, 0, 2, 3); }
    function test_collection0HatchBuy4() public { _matrix(1, 0, 2, 4); }
    function test_collection0HatchBuy5() public { _matrix(1, 0, 2, 5); }
    function test_collection0HatchBuy6() public { _matrix(1, 0, 2, 6); }
    function test_collection6GraduationBuy1() public { _matrix(1, 6, 0, 1); }
    function test_collection6GraduationBuy2() public { _matrix(1, 6, 0, 2); }
    function test_collection6GraduationBuy3() public { _matrix(1, 6, 0, 3); }
    function test_collection6GraduationBuy4() public { _matrix(1, 6, 0, 4); }
    function test_collection6GraduationBuy5() public { _matrix(1, 6, 0, 5); }
    function test_collection6GraduationBuy6() public { _matrix(1, 6, 0, 6); }
    function test_collection6DeadlineBuy1() public { _matrix(1, 6, 1, 1); }
    function test_collection6DeadlineBuy2() public { _matrix(1, 6, 1, 2); }
    function test_collection6DeadlineBuy3() public { _matrix(1, 6, 1, 3); }
    function test_collection6DeadlineBuy4() public { _matrix(1, 6, 1, 4); }
    function test_collection6DeadlineBuy5() public { _matrix(1, 6, 1, 5); }
    function test_collection6DeadlineBuy6() public { _matrix(1, 6, 1, 6); }
    function test_collection6HatchBuy1() public { _matrix(1, 6, 2, 1); }
    function test_collection6HatchBuy2() public { _matrix(1, 6, 2, 2); }
    function test_collection6HatchBuy3() public { _matrix(1, 6, 2, 3); }
    function test_collection6HatchBuy4() public { _matrix(1, 6, 2, 4); }
    function test_collection6HatchBuy5() public { _matrix(1, 6, 2, 5); }
    function test_collection6HatchBuy6() public { _matrix(1, 6, 2, 6); }
    function test_collection8GraduationBuy1() public { _matrix(1, 8, 0, 1); }
    function test_collection8GraduationBuy2() public { _matrix(1, 8, 0, 2); }
    function test_collection8GraduationBuy3() public { _matrix(1, 8, 0, 3); }
    function test_collection8GraduationBuy4() public { _matrix(1, 8, 0, 4); }
    function test_collection8GraduationBuy5() public { _matrix(1, 8, 0, 5); }
    function test_collection8GraduationBuy6() public { _matrix(1, 8, 0, 6); }
    function test_collection8DeadlineBuy1() public { _matrix(1, 8, 1, 1); }
    function test_collection8DeadlineBuy2() public { _matrix(1, 8, 1, 2); }
    function test_collection8DeadlineBuy3() public { _matrix(1, 8, 1, 3); }
    function test_collection8DeadlineBuy4() public { _matrix(1, 8, 1, 4); }
    function test_collection8DeadlineBuy5() public { _matrix(1, 8, 1, 5); }
    function test_collection8DeadlineBuy6() public { _matrix(1, 8, 1, 6); }
    function test_collection8HatchBuy1() public { _matrix(1, 8, 2, 1); }
    function test_collection8HatchBuy2() public { _matrix(1, 8, 2, 2); }
    function test_collection8HatchBuy3() public { _matrix(1, 8, 2, 3); }
    function test_collection8HatchBuy4() public { _matrix(1, 8, 2, 4); }
    function test_collection8HatchBuy5() public { _matrix(1, 8, 2, 5); }
    function test_collection8HatchBuy6() public { _matrix(1, 8, 2, 6); }
    function test_collection18GraduationBuy1() public { _matrix(1, 18, 0, 1); }
    function test_collection18GraduationBuy2() public { _matrix(1, 18, 0, 2); }
    function test_collection18GraduationBuy3() public { _matrix(1, 18, 0, 3); }
    function test_collection18GraduationBuy4() public { _matrix(1, 18, 0, 4); }
    function test_collection18GraduationBuy5() public { _matrix(1, 18, 0, 5); }
    function test_collection18GraduationBuy6() public { _matrix(1, 18, 0, 6); }
    function test_collection18DeadlineBuy1() public { _matrix(1, 18, 1, 1); }
    function test_collection18DeadlineBuy2() public { _matrix(1, 18, 1, 2); }
    function test_collection18DeadlineBuy3() public { _matrix(1, 18, 1, 3); }
    function test_collection18DeadlineBuy4() public { _matrix(1, 18, 1, 4); }
    function test_collection18DeadlineBuy5() public { _matrix(1, 18, 1, 5); }
    function test_collection18DeadlineBuy6() public { _matrix(1, 18, 1, 6); }
    function test_collection18HatchBuy1() public { _matrix(1, 18, 2, 1); }
    function test_collection18HatchBuy2() public { _matrix(1, 18, 2, 2); }
    function test_collection18HatchBuy3() public { _matrix(1, 18, 2, 3); }
    function test_collection18HatchBuy4() public { _matrix(1, 18, 2, 4); }
    function test_collection18HatchBuy5() public { _matrix(1, 18, 2, 5); }
    function test_collection18HatchBuy6() public { _matrix(1, 18, 2, 6); }
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
    function test_pile0GraduationBuy1() public { _matrix(5, 0, 0, 1); }
    function test_pile0GraduationBuy2() public { _matrix(5, 0, 0, 2); }
    function test_pile0GraduationBuy3() public { _matrix(5, 0, 0, 3); }
    function test_pile0GraduationBuy4() public { _matrix(5, 0, 0, 4); }
    function test_pile0DeadlineBuy1() public { _matrix(5, 0, 1, 1); }
    function test_pile0DeadlineBuy2() public { _matrix(5, 0, 1, 2); }
    function test_pile0DeadlineBuy3() public { _matrix(5, 0, 1, 3); }
    function test_pile0DeadlineBuy4() public { _matrix(5, 0, 1, 4); }
    function test_pile0HatchBuy1() public { _matrix(5, 0, 2, 1); }
    function test_pile0HatchBuy2() public { _matrix(5, 0, 2, 2); }
    function test_pile0HatchBuy3() public { _matrix(5, 0, 2, 3); }
    function test_pile0HatchBuy4() public { _matrix(5, 0, 2, 4); }
    function test_pile6GraduationBuy1() public { _matrix(5, 6, 0, 1); }
    function test_pile6GraduationBuy2() public { _matrix(5, 6, 0, 2); }
    function test_pile6GraduationBuy3() public { _matrix(5, 6, 0, 3); }
    function test_pile6GraduationBuy4() public { _matrix(5, 6, 0, 4); }
    function test_pile6DeadlineBuy1() public { _matrix(5, 6, 1, 1); }
    function test_pile6DeadlineBuy2() public { _matrix(5, 6, 1, 2); }
    function test_pile6DeadlineBuy3() public { _matrix(5, 6, 1, 3); }
    function test_pile6DeadlineBuy4() public { _matrix(5, 6, 1, 4); }
    function test_pile6HatchBuy1() public { _matrix(5, 6, 2, 1); }
    function test_pile6HatchBuy2() public { _matrix(5, 6, 2, 2); }
    function test_pile6HatchBuy3() public { _matrix(5, 6, 2, 3); }
    function test_pile6HatchBuy4() public { _matrix(5, 6, 2, 4); }
    function test_pile8GraduationBuy1() public { _matrix(5, 8, 0, 1); }
    function test_pile8GraduationBuy2() public { _matrix(5, 8, 0, 2); }
    function test_pile8GraduationBuy3() public { _matrix(5, 8, 0, 3); }
    function test_pile8GraduationBuy4() public { _matrix(5, 8, 0, 4); }
    function test_pile8DeadlineBuy1() public { _matrix(5, 8, 1, 1); }
    function test_pile8DeadlineBuy2() public { _matrix(5, 8, 1, 2); }
    function test_pile8DeadlineBuy3() public { _matrix(5, 8, 1, 3); }
    function test_pile8DeadlineBuy4() public { _matrix(5, 8, 1, 4); }
    function test_pile8HatchBuy1() public { _matrix(5, 8, 2, 1); }
    function test_pile8HatchBuy2() public { _matrix(5, 8, 2, 2); }
    function test_pile8HatchBuy3() public { _matrix(5, 8, 2, 3); }
    function test_pile8HatchBuy4() public { _matrix(5, 8, 2, 4); }
    function test_pile18GraduationBuy1() public { _matrix(5, 18, 0, 1); }
    function test_pile18GraduationBuy2() public { _matrix(5, 18, 0, 2); }
    function test_pile18GraduationBuy3() public { _matrix(5, 18, 0, 3); }
    function test_pile18GraduationBuy4() public { _matrix(5, 18, 0, 4); }
    function test_pile18DeadlineBuy1() public { _matrix(5, 18, 1, 1); }
    function test_pile18DeadlineBuy2() public { _matrix(5, 18, 1, 2); }
    function test_pile18DeadlineBuy3() public { _matrix(5, 18, 1, 3); }
    function test_pile18DeadlineBuy4() public { _matrix(5, 18, 1, 4); }
    function test_pile18HatchBuy1() public { _matrix(5, 18, 2, 1); }
    function test_pile18HatchBuy2() public { _matrix(5, 18, 2, 2); }
    function test_pile18HatchBuy3() public { _matrix(5, 18, 2, 3); }
    function test_pile18HatchBuy4() public { _matrix(5, 18, 2, 4); }
}
