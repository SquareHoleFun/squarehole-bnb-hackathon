// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M360Items} from "../../gas/m3/Items.sol";
import {ClaimCap} from "../../gas/m3/ClaimCap.sol";
import {IItemLedgerV2} from "../../../../src/box-v2/interfaces/IItemLedgerV2.sol";

contract MoneyGasFindingsTest is M360Items {
    function test_MONEY05_currentClaimAllowanceHasTwoTimesColdERC20Headroom() public {
        _halfCapClaim(6);
    }

    function test_MONEY05_currentClaimAllowanceHasTwoTimesColdEightDecimalHeadroom() public {
        _halfCapClaim(8);
    }

    function test_MONEY05_currentClaimAllowanceHasTwoTimesColdEighteenDecimalHeadroom() public {
        _halfCapClaim(18);
    }

    function _halfCapClaim(uint8 decimals) private {
        _itemStart(decimals, true);
        uint256 id = _drawAndOpen();
        (uint256 outside, uint256 stash) = ledger.itemCredit(id);
        uint256 backing = pm.balanceOf(address(ledger), uint160(box.q()));
        uint256 cap = ledger.CLAIM_GAS();
        // Replace only the two checked PUSH3 stipend constants to exercise the full PM transport
        // at half the release allowance. The original source is untouched; this is a gas probe.
        vm.etch(
            release.implementations[16],
            ClaimCap.replace(release.implementations[16].code, cap, cap / 2, 2)
        );
        _measure(
            "half allowance owner exit",
            address(ledger),
            ALICE,
            abi.encodeCall(IItemLedgerV2.claim, (_one(id), BOB)),
            3_500_000
        );
        assertEq(_balance(BOB), outside + stash);
        assertEq(pm.balanceOf(address(ledger), uint160(box.q())), backing - outside - stash);
    }
}
