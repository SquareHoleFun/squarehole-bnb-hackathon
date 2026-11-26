// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M244Base} from "../../m2-44/Fixture.sol";
import {IBoxHolderBatchNoticeV2} from "../../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {ReleaseConstantsV2 as C} from "../../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";

/// M200-N1/M260-CAPS: real ledger/history under a cold first-write notice.
/// Only the notice caller is doubled with prank; no production runtime or storage is patched.
contract M263NoticeBudgetTest is M244Base {
    function _probe(uint256 allowance) private returns (bool ok) {
        _createShop(0, 40 ether, false, true);
        receiver.collect(address(0)); // close 1/2, so 3 has no notice yet
        for (uint256 i; i < 512; ++i) {
            vm.prank(CREATOR); token.transfer(ALICE, 1);
            vm.prank(ALICE); token.transfer(CREATOR, 1);
        }
        bytes memory input = abi.encodeCall(IBoxHolderBatchNoticeV2.onTradeFeeBatch, (3, ALICE, true, 100));
        vm.cool(address(ledger)); vm.cool(release.implementations[17]);
        vm.cool(address(token)); vm.cool(release.implementations[20]);
        vm.prank(address(hook));
        (ok,) = address(ledger).call{gas: allowance}(input);
    }

    // Regression M263-MONEY-03: fail if the production cap loses the measured two-times margin.
    function test_M200_N1_productionNoticeHasTwiceColdCaseHeadroom() public {
        assertTrue(_probe(C.HOLDER_NOTICE_GAS / 2), "notice exceeds half production stipend");
    }

}
