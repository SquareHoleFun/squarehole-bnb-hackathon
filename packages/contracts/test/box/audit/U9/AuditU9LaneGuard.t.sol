// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {TransientReentrancyGuard} from "../../../../src/libraries/TransientReentrancyGuard.sol";

/// @notice Library exercise adapter. Its external callee deliberately re-enters or reverts; production receiver
/// integration is tested separately on AuditBox0World. Both production modifier forms run without slot writes by tests.
contract AuditU9LaneGuardProbe is TransientReentrancyGuard {
    error InnerFailure();
    uint256 public count;

    function inlineCall(bool fail) external nonReentrant {
        ++count;
        if (fail) revert InnerFailure();
    }

    function outlinedCall(bool fail) external nonReentrantCall {
        ++count;
        if (fail) revert InnerFailure();
    }

    function nested() external nonReentrantCall returns (bytes4 first, bytes4 second, bool stillLocked) {
        // Catch an inner guarded call's revert: it must not clear its caller's live lock.
        (bool ok, bytes memory data) = address(this).call(abi.encodeCall(this.inlineCall, (false)));
        require(!ok, "inline reentry succeeded");
        first = bytes4(data);
        (ok, data) = address(this).call(abi.encodeCall(this.outlinedCall, (false)));
        require(!ok, "outlined reentry succeeded");
        second = bytes4(data);
        stillLocked = _insideGuardedCall();
        ++count;
    }

    function locked() external view returns (bool) {
        return _insideGuardedCall();
    }
}

contract AuditU9LaneGuard is Test {
    AuditU9LaneGuardProbe internal probe = new AuditU9LaneGuardProbe();

    /// TransientReentrancyGuard.sol:6-7; two calls in this very transaction, with both modifier implementations.
    function testProperty_AUDIT_U9_twoGuardedCallsSameTransaction() public {
        probe.inlineCall(false);
        probe.outlinedCall(false);
        probe.inlineCall(false);
        assertEq(probe.count(), 3);
        assertFalse(probe.locked());
    }

    function testProperty_AUDIT_U9_caughtRevertRollsBackLockAndState() public {
        for (uint256 i; i < 2; ++i) {
            bytes memory callData =
                i == 0 ? abi.encodeCall(probe.inlineCall, (true)) : abi.encodeCall(probe.outlinedCall, (true));
            (bool ok, bytes memory data) = address(probe).call(callData);
            assertFalse(ok);
            assertEq(data, abi.encodeWithSelector(AuditU9LaneGuardProbe.InnerFailure.selector));
            assertEq(probe.count(), i);
            assertFalse(probe.locked());
            probe.outlinedCall(false);
        }
        assertEq(probe.count(), 2);
    }

    function testProperty_AUDIT_U9_caughtReentryPreservesOuterLockThenReleases() public {
        (bytes4 a, bytes4 b, bool locked) = probe.nested();
        assertEq(a, TransientReentrancyGuard.Reentrancy.selector);
        assertEq(b, TransientReentrancyGuard.Reentrancy.selector);
        assertTrue(locked);
        assertFalse(probe.locked());
        probe.inlineCall(false);
        assertEq(probe.count(), 2);
    }
}

/// @notice Calls never intentionally abort the invariant run; sticky ghost failures preserve any incorrect outcome.
contract AuditU9LaneGuardHandler {
    AuditU9LaneGuardProbe public immutable probe;
    uint256 public expected;
    uint256 public calls;
    bool public bad;

    constructor(AuditU9LaneGuardProbe p) {
        probe = p;
    }

    function step(uint8 mode) external {
        ++calls;
        if (mode % 3 == 0) {
            try probe.inlineCall(false) {
                ++expected;
            } catch {
                bad = true;
            }
            try probe.outlinedCall(false) {
                ++expected;
            } catch {
                bad = true;
            }
        } else if (mode % 3 == 1) {
            (bool ok, bytes memory data) = address(probe).call(abi.encodeCall(probe.outlinedCall, (true)));
            if (ok || bytes4(data) != AuditU9LaneGuardProbe.InnerFailure.selector) bad = true;
            try probe.inlineCall(false) {
                ++expected;
            } catch {
                bad = true;
            }
        } else {
            try probe.nested() returns (bytes4 a, bytes4 b, bool inside) {
                ++expected;
                if (a != TransientReentrancyGuard.Reentrancy.selector || b != a || !inside) bad = true;
            } catch {
                bad = true;
            }
        }
        if (probe.locked() || probe.count() != expected) bad = true;
    }
}

contract AuditU9LaneGuardInvariants is StdInvariant, Test {
    AuditU9LaneGuardHandler internal handler;
    AuditU9LaneGuardProbe internal probe;

    function setUp() public {
        probe = new AuditU9LaneGuardProbe();
        handler = new AuditU9LaneGuardHandler(probe);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = handler.step.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
    }

    function invariant_AUDIT_U9_lockReleasedAndExactlyCompletedCallsCounted() public view {
        assertFalse(handler.bad());
        assertFalse(probe.locked());
        assertEq(probe.count(), handler.expected());
    }
}
