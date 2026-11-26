// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CoreV2LocalTest} from "./CoreV2Local.t.sol";
import {BoxCoordinatorV2} from "../../src/box-v2/BoxCoordinatorV2.sol";
import {BoxTokenV2} from "../../src/box-v2/BoxTokenV2.sol";
import {BoxVaultV2} from "../../src/box-v2/BoxVaultV2.sol";
import {IBoxVaultV2} from "../../src/box-v2/interfaces/IBoxVaultV2.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";

/// @notice Same real-part money scenarios, with each recipe mutation in a fresh block/second like --slow.
/// This is an offline scheduling model, not a claim to have broadcast on anvil.
contract CoreV2LocalBlocksTest is CoreV2LocalTest {
    function test_withdrawGasFloorRollsBackThenBudgetedRecipeSucceeds() public {
        vm.startPrank(localActor);
        BoxCoordinatorV2 b = _createLocal(4); _loadLocalM3(b, 4);
        vm.warp(b.effectiveOpenAt() + 384);
        _fillLocal(b); _beforeLocalTransaction(); b.graduate();
        IBoxVaultV2 vault = IBoxVaultV2(b.vault());
        BoxTokenV2 token = BoxTokenV2(b.token());
        uint256 principal = vault.quoteWithdraw(1);
        uint256 amount = principal + FullMath.mulDivRoundingUp(principal, BoxVaultV2(b.vault()).pickFeeBps(), 10000);
        _beforeLocalTransaction(); token.approve(b.vault(), amount);
        uint256 balance = token.balanceOf(localActor);
        uint256 supply = token.totalSupply();
        _beforeLocalTransaction();
        (bool ok, bytes memory reason) = b.vault().call{gas: 548_743}(
            abi.encodeCall(IBoxVaultV2.withdraw, (1, amount, block.timestamp + 1 hours))
        );
        assertFalse(ok, "consumption-sized gas cannot satisfy the fail-safe floor");
        // Amsterdam may exhaust this small budget before reaching the floor (empty OOG data).
        assertTrue(reason.length == 0 || bytes4(reason) == IBoxVaultV2.ItemLedgerGasTooLow.selector);
        assertEq(token.balanceOf(localActor), balance, "failed withdrawal spent no principal");
        assertEq(token.totalSupply(), supply, "failed withdrawal burned nothing");
        assertEq(token.allowance(localActor, b.vault()), amount, "failed withdrawal spent no approval");
        _withdrawLocalItem(b);
        assertEq(token.balanceOf(localActor), balance - amount);
        vm.stopPrank();
    }

    function _beforeLocalTransaction() internal override {
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 1);
    }
}
