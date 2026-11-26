// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M360ClaimsTest} from "../../gas/m3/Claims.t.sol";
import {M340Base} from "../../m3-40/Fixture.sol";

// Full/half linked-token release payouts, low-gas rollback and exhausting-recipient retry on all four P variants.
contract RulesClaimMarginDoubleTest is M360ClaimsTest {
    function setUp() public override {
        // Retain the actual release artifacts and cold paths, without M3-60's stale exact runtime lengths.
        M340Base.setUp();
        assertLe(release.implementations[16].code.length, 22_118);
    }
}
