// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SetPoolGasFixture} from "./SetPoolGas.t.sol";

/// Differential integer arithmetic after actual local-pool funding/graduation, with a burn between pick and return.
contract SetPoolPricingTest is SetPoolGasFixture {
    function _stage() internal pure override returns (uint256) {
        return 4;
    }

    function testFuzz_E07_realPoolSupplyShare(uint8 countSeed, uint96 burnSeed) public {
        uint256 count = bound(countSeed, 1, 32);
        uint256 supply = token.totalSupply();
        uint256 principal = (supply * count + 95) / 96;
        uint256 fee = (principal * 500 + 9999) / 10000;
        uint256 before = token.balanceOf(ALICE);
        assertEq(vault.quoteWithdraw(count), principal);
        vm.prank(ALICE);
        (uint256 paid, uint256 burned) = vault.withdrawBatch(_ids(0, count), principal + fee, block.timestamp);
        assertEq(paid, principal);
        assertEq(burned, fee);
        assertEq(token.totalSupply(), supply - fee);
        assertEq(token.balanceOf(ALICE), before - principal - fee);
        uint256 outsideBurn = bound(burnSeed, 0, token.balanceOf(ALICE) / 10);
        vm.startPrank(ALICE);
        token.burn(outsideBurn);
        art.setApprovalForAll(address(vault), true);
        vm.stopPrank();
        assertEq(vault.escrowPrincipal(), principal);
        assertEq(token.balanceOf(address(vault)), principal);
        uint256 returned = (supply - fee - outsideBurn - principal) * count / (96 - count);
        uint256 returnFee = (returned * 500 + 9999) / 10000;
        assertEq(vault.quoteReturn(count), returned);
        vm.prank(ALICE);
        (paid, burned) = vault.returnItems(_ids(0, count), returned - returnFee, block.timestamp);
        assertEq(paid, returned);
        assertEq(burned, returnFee);
        assertEq(token.totalSupply(), supply - fee - outsideBurn - returnFee);
        assertEq(token.balanceOf(ALICE), before - principal - fee - outsideBurn + returned - returnFee);
        assertEq(vault.escrowPrincipal(), principal - returned);
        assertEq(token.balanceOf(address(vault)), principal - returned);
        assertEq(vault.inside(), 96);
        assertGe(token.totalSupply(), vault.supplyFloor());
        _noPayouts();
    }
}
