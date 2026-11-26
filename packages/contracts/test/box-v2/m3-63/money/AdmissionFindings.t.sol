// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M332Base} from "../../m3-32/Fixture.sol";

/// Exact production factory/checker/hook control: no source or readback substitution.
contract MoneyAdmissionFindingsTest is M332Base {
    function test_MONEY03_itemsOnlyReleaseCanCreateAndHoldMoney() public {
        _start(_items(1, 0));
        _gift(address(receiver), 150);
        receiver.collect(address(0));
        assertEq(receiver.itemsHeldP(), 100);
    }

    function test_MONEY04_pileReleaseCanCreateWithoutCollectionReads() public {
        _start(_pile(address(0), 0));
        assertTrue(factory.isPileVault(box.vault()));
    }
}
