// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditRegressMoneyFixture, AuditRegressMoneyGasSink} from "./MoneyFixture.sol";

/// F126 fixes M28: graduation stays fail-safe and retry retains its original earnings baseline.
contract AuditRegressMoneyFindingsTest is AuditRegressMoneyFixture {
    /// M-28: a failed graduation start followed by trading cannot move the stream's financial start time.
    function test_M28_delayedStreamStartMustKeepPostGraduationEarnings() public {
        vm.pauseGasMetering();
        kit.toClosed();
        vm.resumeGasMetering();
        bytes memory code = a.itemStream.code;
        AuditRegressMoneyGasSink sink = new AuditRegressMoneyGasSink();
        vm.etch(a.itemStream, address(sink).code);
        (bool ok,) = a.coordinator.call{gas: 15_000_000}(abi.encodeWithSignature("graduate()"));
        vm.etch(a.itemStream, code);
        // F126 / SH-box0-f126-b: rollback is not an acceptable alternative to lossless retry.
        assertTrue(ok, "F126: an exhausted stream poke must not block graduation");
        assertTrue(vault.gateOpen());
        assertTrue(coordinator.graduated());
        assertFalse(stream.started());
        assertEq(stream.outsideCount(), 1, "one curve placeholder earns from graduation");
        uint256 atGraduation = stream.streamValue();
        uint256 bought = kit.buy(alice, 0.6 ether, 0);
        kit.sell(alice, bought / 2);
        uint256 accrued = (stream.streamValue() - atGraduation) / 4269;
        assertGt(accrued, 0);
        stream.onGraduation();
        assertEq(stream.index(), accrued, "M-28: delayed start erased post-graduation earnings");
    }
}
