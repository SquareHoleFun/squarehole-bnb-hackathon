// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {VaultViews} from "../../../src/box-v2/libraries/VaultViews.sol";
import {IBoxVaultV2} from "../../../src/box-v2/interfaces/IBoxVaultV2.sol";

/// Pins the arithmetic helper the new set vault can call without importing minted-id or reveal assumptions.
contract ExistingNftsPricingReuseTest is Test {
    VaultViews private quotes;

    function setUp() public {
        quotes = new VaultViews();
    }

    function testFuzz_E00_supplyShareAndFeeRounding(uint96 rawActive, uint16 rawN, uint16 rawK) public view {
        uint256 n = bound(uint256(rawN), 10, 10_000);
        uint256 a = bound(uint256(rawActive), n, type(uint96).max);
        uint256 k = bound(uint256(rawK), 1, n - 1);
        // These uint96 operands times at most 9999 cannot overflow this independent integer oracle.
        uint256 take = (a * k + n - 1) / n;
        uint256 give = a * k / n;
        assertEq(quotes.quoteWithdraw(k, n, a), take);
        assertEq(quotes.quoteReturn(k, n, k, a), give);
        assertEq(quotes.fee(give, 500), (give * 500 + 9999) / 10_000);
        assertEq(quotes.fee(take, 100), (take * 100 + 9999) / 10_000);
        assertEq(quotes.fee(take, 2500), (take * 2500 + 9999) / 10_000);
    }

    function test_E00_lastItemAndSubUnitReturnAreRefused() public {
        vm.expectRevert(IBoxVaultV2.LastItem.selector);
        quotes.quoteWithdraw(1, 1, 100);
        vm.expectRevert(abi.encodeWithSelector(IBoxVaultV2.ReturnBelowUnit.selector, 0, 1));
        quotes.quoteReturn(1, 10, 1, 9);
    }
}
