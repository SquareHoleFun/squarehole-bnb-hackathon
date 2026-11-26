// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FailureTestBase} from "../../m1-31/FailureTestBase.sol";
import {GasBudget} from "../../gas/GasBudget.sol";

/// FINAL3-T01: retain the obsolete 1.5M refusal beside the measured 12M release envelope.
/// The M1 success fixture now uses 12M too; this control also pins atomic refusal and the fixed count.
contract Round3FailureEnvelopeTest is FailureTestBase {
    function test_currentFailureEnvelopePreservesFixedCountAndRejectsTheObsoleteEnvelope() public {
        _give(ALICE, 100);
        _fund(p, address(hook), 100);
        _expire();
        bytes memory data = abi.encodeCall(box.fail, ());
        (bool low,) = address(box).call{gas: 1_500_000}(data);
        assertFalse(low);
        assertFalse(box.failed());
        assertFalse(hook.failed());
        assertEq(pm.balanceOf(address(hook), uint256(uint160(p))), 100);
        uint256 envelope = 12_000_000;
        uint256 start = gasleft();
        (bool ok,) = address(box).call{gas: envelope - GasBudget.intrinsic(data)}(data);
        assertTrue(ok);
        assertEq(_left(), 100);
        assertLt(GasBudget.transaction(start - gasleft(), data), envelope);
        assertLt(envelope, 16_777_216);
    }
}
