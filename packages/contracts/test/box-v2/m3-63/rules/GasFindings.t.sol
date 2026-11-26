// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M360Items} from "../../gas/m3/Items.sol";
import {ClaimCap} from "../../gas/m3/ClaimCap.sol";
import {IItemLedgerV2} from "../../../../src/box-v2/interfaces/IItemLedgerV2.sol";
import {M340Base} from "../../m3-40/Fixture.sol";

contract RulesGasFindingsTest is M360Items {
    // The pin changed unrelated runtime lengths since M3-60. Keep its real setup and cold measurement,
    // without treating those historical exact byte counts as a substitute for release-profile checks.
    function setUp() public override {
        M340Base.setUp();
        assertLe(release.implementations[16].code.length, 22_118);
    }

    function test_R06_measuredClaimStipendIncludesLinkedTokens() public {
        _itemStart(6, true);
        assertEq(ledger.CLAIM_GAS(), 2_600_000);
    }

    function test_R06_productionClaimStipendMustHaveTwoTimesColdHeadroom() public {
        _itemStart(6, true);
        uint256 id = _drawAndOpen();
        (uint256 outside, uint256 stash) = ledger.itemCredit(id);
        uint256 credit = outside + stash;
        assertGt(credit, 0);
        uint256 cap = ledger.CLAIM_GAS();
        // Only reduce the two named cap instructions. All production payout logic and PM transport remain.
        vm.etch(release.implementations[16], ClaimCap.replace(release.implementations[16].code, cap, cap / 2, 2));
        _measure(
            "half production claim stipend",
            address(ledger),
            ALICE,
            abi.encodeCall(IItemLedgerV2.claim, (_one(id), BOB)),
            3_2_600_000
        );
        assertEq(_balance(BOB), credit);
    }
}
