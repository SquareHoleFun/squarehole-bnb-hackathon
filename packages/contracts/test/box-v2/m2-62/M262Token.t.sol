// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Keep the independent behavioral oracle; only isolated production code is mutated.
import {LedgerTokenTest} from "../m2-31/Token.t.sol";
import {ReleaseConstantsV2 as C} from "../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";
import {IHolderLedgerV2} from "../../../src/box-v2/interfaces/IHolderLedgerV2.sol";

contract M262Token is LedgerTokenTest {
    function test_optionalHintUsesTheNamedStipend() public {
        ledger.setMode(1); // A refusing optional observer cannot undo mandatory history.
        vm.expectCall(address(ledger), 0, uint64(C.TOKEN_SETTLEMENT_GAS),
            abi.encodeWithSelector(IHolderLedgerV2.onTokenCheckpoint.selector), uint64(1));
        give(ALICE, 100);
        assertEq(token.balanceOf(ALICE), 100);
        assertEq(history.eligibleBalanceAt(ALICE, history.holderCheckpoint()), 100);
    }
}
