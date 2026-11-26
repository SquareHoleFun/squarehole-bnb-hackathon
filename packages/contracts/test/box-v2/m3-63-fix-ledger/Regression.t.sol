// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ItemAccountingTest} from "../m3-20/Accounting.t.sol";
import {ItemBoundariesTest} from "../m3-20/Boundaries.t.sol";
import {ItemClaimsTest} from "../m3-21/Claims.t.sol";
import {HostileItemClaimsTest} from "../m3-21/HostileClaims.t.sol";
import {ItemClaimGasTest} from "../m3-21/Gas.t.sol";
import {LargeItemCreditsTest} from "../m3-21/LargeCredits.t.sol";
import {ReplayItemClaimsTest} from "../m3-21/ReplayClaims.t.sol";
import {ItemLedgerV2} from "../../../src/box-v2/ItemLedgerV2.sol";

// Re-run all inherited ledger accounting/owner/transport regressions through this ticket's entry point.
contract LedgerAccountingRegressionTest is ItemAccountingTest {}

contract LedgerOwnerRegressionTest is ItemClaimsTest {}

contract LedgerHostileRegressionTest is HostileItemClaimsTest {}

contract LedgerGasRegressionTest is ItemClaimGasTest {}

contract LedgerLargeCreditRegressionTest is LargeItemCreditsTest {}

contract LedgerReplayRegressionTest is ReplayItemClaimsTest {}

contract LedgerInitialCountsTest is ItemBoundariesTest {
    function test_R03_initialCountsMustDescribeUntouchedShelfOrHiddenCollection() public {
        _clone(_args(1, 2));
        vm.mockCall(address(j), abi.encodeWithSignature("inside()"), abi.encode(uint256(3)));
        vm.expectRevert(ItemLedgerV2.InvalidWiring.selector);
        c.initializeLedger();
        vm.mockCall(address(j), abi.encodeWithSignature("inside()"), abi.encode(uint256(4)));
        vm.mockCall(address(j), abi.encodeWithSignature("hiddenCount()"), abi.encode(uint256(2)));
        vm.expectRevert(ItemLedgerV2.InvalidWiring.selector);
        c.initializeLedger();
        vm.mockCall(address(j), abi.encodeWithSignature("hiddenCount()"), abi.encode(uint256(5)));
        vm.expectRevert(ItemLedgerV2.InvalidWiring.selector);
        c.initializeLedger();
    }
}
