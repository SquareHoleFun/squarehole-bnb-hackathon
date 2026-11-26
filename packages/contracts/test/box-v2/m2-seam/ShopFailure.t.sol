// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {FailureTestBase} from "../m1-31/FailureTestBase.sol";

contract ShopFailureTest is FailureTestBase {
    function test_plainShareVaultKeepsTheExistingKRule() public {
        _give(ALICE, 100);
        vm.prank(address(box)); t.approve(address(vault), 300);
        vm.prank(address(vault)); t.transferFrom(address(box), address(vault), 300);
        _fundT(address(vault), 200);
        vault.configure(0, 123, false);
        _fund(p, address(hook), 1200); _expire(); box.fail();
        assertEq(_left(), 477, "M1 share-vault K behaviour stays byte-for-byte arithmetic");
    }
    function test_S1_shopBalanceAndClaimsJoinHWithoutShareVaultK() public {
        // Additive coordinator kind tail: SHOP = 4. Existing share-vault encoding stays unchanged.
        vm.etch(address(box), bytes.concat(address(box).code, hex"04"));
        _give(ALICE, 100);
        vm.prank(address(box)); t.approve(address(vault), 300);
        vm.prank(address(vault)); t.transferFrom(address(box), address(vault), 300);
        _fundT(address(vault), 200);
        vault.configure(0, 123, false); // Must not subtract K a second time for a shop.
        _fund(p, address(hook), 1200);
        _expire();
        box.fail();
        assertEq(_left(), 100, "shop's liquid T and claims are excluded exactly once");
        assertEq(_claim(ALICE, 100, ALICE), 1200);
        assertEq(_left(), 0);
    }
}
