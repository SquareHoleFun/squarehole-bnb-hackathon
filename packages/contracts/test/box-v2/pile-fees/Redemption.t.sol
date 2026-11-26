// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {PileVaultTest} from "../m3-30/PileVault.t.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {IPileVaultV2} from "../../../src/box-v2/interfaces/IPileVaultV2.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";

contract PileLeaveBehindTest is PileVaultTest {
    function _preset(uint16 bps) internal {
        pile = IPileVaultV2(BoxClones.create(BoxClones.initCode(implementation,
            abi.encodePacked(address(coordinator), address(t), address(seed), address(this), seed.balanceOf(address(this)), bps))));
        coordinator.configure(address(t), address(pile), address(seed), seed.balanceOf(address(this)) != 0);
        coordinator.initialize();
        seed.approve(address(pile), type(uint256).max);
        vm.prank(ALICE); t.approve(address(pile), type(uint256).max);
        vm.prank(BOB); t.approve(address(pile), type(uint256).max);
    }
    function test_PF04_leaveBehindBenefitsNextHolderAndLastEmptiesPile() public {
        _preset(500); _ready();
        vm.prank(ALICE); t.transfer(BOB, 50);
        assertEq(pile.quoteRedeem(50), 475); assertEq(_redeem(ALICE, 50), 475);
        assertEq(pile.quoteRedeem(50), 525); assertEq(_redeem(BOB, 50), 525);
        assertEq(seed.balanceOf(address(pile)), 0); assertEq(t.totalSupply(), 0);
    }
    function test_PF05_invalidPresetRefused() public {
        pile = IPileVaultV2(BoxClones.create(BoxClones.initCode(implementation,
            abi.encodePacked(address(coordinator), address(t), address(seed), address(this), uint256(1000), uint16(499)))));
        coordinator.configure(address(t), address(pile), address(seed), true);
        vm.expectRevert(); coordinator.initialize();
    }
    function testFuzz_PF06_quotesBurnsAndBalanceConserve(uint128 amount_, uint128 supply_, uint128 first_, bool preset) public {
        uint256 amount = bound(amount_, 1, type(uint128).max);
        uint256 supply = bound(supply_, 2, type(uint128).max);
        uint256 first = bound(first_, 1, supply - 1);
        _make(18, amount, supply, address(this), false); _preset(preset ? 500 : 0); _ready();
        uint256 expected = FullMath.mulDiv(FullMath.mulDiv(amount, first, supply), preset ? 9500 : 10000, 10000);
        assertEq(pile.quoteRedeem(first), expected); assertEq(_redeem(ALICE, first), expected);
        assertEq(seed.balanceOf(address(pile)), amount - expected);
        assertEq(pile.quoteRedeem(supply - first), amount - expected);
        assertEq(_redeem(ALICE, supply - first), amount - expected);
        assertEq(seed.balanceOf(ALICE), amount); assertEq(seed.balanceOf(address(pile)), 0);
    }
    function test_PF07_fullPrecisionAndRefusedPaymentRollBackTAndAllowance() public {
        _make(18, 1 << 200, 1 << 100, address(this), false); _preset(500); _ready();
        uint256 expected = FullMath.mulDiv(1 << 199, 9500, 10000);
        assertEq(pile.quoteRedeem(1 << 99), expected);
        uint256 approval = t.allowance(ALICE, address(pile));
        seed.setPaused(true); vm.prank(ALICE); vm.expectRevert(); pile.redeem(1 << 99, expected, ALICE);
        assertEq(t.allowance(ALICE, address(pile)), approval); assertEq(t.totalSupply(), 1 << 100);
        seed.setPaused(false); assertEq(_redeem(ALICE, 1 << 99), expected);
    }
}
