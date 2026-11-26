// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ItemClaimFixture} from "./Fixture.sol";
import {IItemLedgerV2} from "../../../src/box-v2/interfaces/IItemLedgerV2.sol";

contract ItemClaimGasTest is ItemClaimFixture {
    function _cool() private {
        vm.cool(address(pm));
        vm.cool(address(ledger));
        vm.cool(address(j));
        vm.cool(address(j.history()));
        vm.cool(ALICE);
        if (price != address(0)) vm.cool(price);
    }

    function test_coldNativeOwnerClaimFitsCap() public {
        _funded(100);
        _cool();
        uint256 beforeGas = gasleft();
        vm.prank(ALICE);
        assertEq(ledger.claim{gas: 3_500_000}(_ids(1), ALICE), 100);
        emit log_named_uint("native owner claim call gas", beforeGas - gasleft());
        assertEq(ALICE.balance, 100);
        _debitModel(1, ALICE, 100);
        _conserved();
    }

    function test_coldERC20OwnerClaimFitsCap() public {
        _erc20(6);
        _funded(100);
        _cool();
        uint256 beforeGas = gasleft();
        vm.prank(ALICE);
        assertEq(ledger.claim{gas: 3_500_000}(_ids(1), ALICE), 100);
        emit log_named_uint("ERC20 owner claim call gas", beforeGas - gasleft());
        assertEq(token.balanceOf(ALICE), 100);
        _debitModel(1, ALICE, 100);
        _conserved();
    }

    function test_BC257_noMinimumNoTipAndClaimGasBounds() public {
        _setup(address(0), type(uint256).max, type(uint256).max);
        _funded(1);
        bytes memory data = abi.encodeCall(IItemLedgerV2.claim, (_ids(1), ALICE));
        uint256 snapshot = vm.snapshotState();
        uint256 successes;
        uint256 failures;
        for (uint256 limit = 200_000; limit <= 3_500_000; limit += 20_000) {
            assertTrue(vm.revertToState(snapshot));
            _cool();
            vm.prank(ALICE);
            (bool ok, bytes memory result) = address(ledger).call{gas: limit}(data);
            if (ok) {
                ++successes;
                assertEq(abi.decode(result, (uint256)), 1);
                assertEq(ALICE.balance, 1);
                assertEq(_credit(1), 0);
                assertEq(pm.balanceOf(address(ledger), 0), 3);
            } else {
                ++failures;
                assertEq(ALICE.balance, 0);
                assertEq(_credit(1), 1);
                assertEq(pm.balanceOf(address(ledger), 0), 4);
            }
            assertEq(KEEPER.balance, 0);
        }
        assertGt(successes, 0);
        assertGt(failures, 0);
        emit log_named_uint("successful owner claims", successes);
        emit log_named_uint("atomic low-gas refusals", failures);
    }

    function test_runtimePreservesReservedSizeGate() public view {
        assertLe(vm.getDeployedCode("ItemLedgerV2.sol:ItemLedgerV2").length, 22_118);
    }
}
