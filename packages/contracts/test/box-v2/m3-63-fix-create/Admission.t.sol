// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {RulesCreationFindingsTest} from "../m3-63/rules/CreationFindings.t.sol";

/// Production hook, extension and checker: retain the four joint-review requirements unchanged.
contract M363CreationAdmissionTest is RulesCreationFindingsTest {
    /// MONEY03, copied from the money lens: creation must admit actually backed held Items.
    function test_MONEY03_itemsOnlyReleaseCanCreateAndHoldMoney() public {
        _start(_items(1, 0));
        _gift(address(receiver), 150);
        receiver.collect(address(0));
        assertEq(receiver.itemsHeldP(), 100);
        _booked();
    }

    /// MONEY04, copied from the money lens: pile custody requires no collection facade.
    function test_MONEY04_pileReleaseCanCreateWithoutCollectionReads() public {
        _start(_pile(address(0), 0));
        assertTrue(factory.isPileVault(box.vault()));
    }
}
