// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {IBoxItemStream} from "../../../../src/box/interfaces/IBoxItemStream.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {AuditU5ClaudeBase} from "./AuditU5ClaudeBase.sol";

/// @title AuditU5ClaudeStreamStartTest
/// @notice SH-AUDIT-B0 U5 (Claude), P5.7 (IBoxItemStream.sol:95-98; BoxItemStream.sol:134-146, :352-368, :620-626;
/// F126 / M28): the stream's start value X₀ is the coordinator's recorded baseline whatever order the graduation
/// pokes ran in or failed, and a delayed start keeps every earning since graduation. The world is the shared box 0 at
/// its close, prepared so X₀ has all three parts: T given to the stream on the curve and burned there (a
/// pre-graduation burn), T given and left unburned (the stream's balance at graduation), and T fees after the curve's
/// last batch (the receiver's T claims at graduation, the curve's 2/15 depth among them, excluded).
/// forge-config: default.evm_version = "osaka"
contract AuditU5ClaudeStreamStartTest is AuditU5ClaudeBase {
    uint256 internal preBurned;

    function setUp() public override {
        super.setUp();
        _toBonding();
        // Given and burned on the curve (all of it: nothing is owed before graduation).
        _transferT(eoa[0], a.itemStream, 3 ether);
        vm.prank(eoa[5]);
        preBurned = stream.burn();
        assertEq(preBurned, 3 ether, "a pre-graduation burn takes everything");
        // Given and left: the stream's balance at graduation.
        _transferT(eoa[0], a.itemStream, 2 ether + 7);
        // T fees after the bonding batch: the migration's last poke harvests them to the receiver's claims.
        _sell(eoa[1], token.balanceOf(eoa[1]) / 4);
        _toClosed();
    }

    /// X₀ from the coordinator's record, as the stream defines it (BoxItemStream.sol:360-368).
    function _recordedX0() internal view returns (uint256) {
        uint256 claims = coordinator.streamStartClaims() - receiver.streamCurveDepthT();
        return preBurned + coordinator.streamStartBalance() + BoxSpecV1.BOX0_FEE_SHARE_T_BURN
            * (claims / BoxSpecV1.FEE_SHARE_DENOMINATOR);
    }

    /// graduate() with the receiver's and the stream's pokes failing (`PokeFailed` twice).
    function _graduateBothPokesFail() internal {
        _warpTo(_requestTimeFor(r0));
        vm.mockCallRevert(a.receiver, abi.encodeWithSelector(IBoxReceiver.onGraduation.selector), "");
        vm.mockCallRevert(a.itemStream, abi.encodeWithSelector(IBoxItemStream.onGraduation.selector), "");
        (, uint256 fails) = _graduate(keeper);
        vm.clearMockedCalls();
        assertEq(fails, 2, "the receiver's and the stream's pokes failed");
        assertFalse(receiver.graduationSettled());
        assertFalse(stream.started());
    }

    /// The same life after graduation for every order: a sell, a batch, a second sell, a batch.
    function _afterGraduation() internal {
        _advance(2);
        _sell(eoa[2], 9_000_000 ether);
        _buy(eoa[4], 0.6 ether);
        _collect(keeper, keeper);
        _advance(3);
        _sell(eoa[2], 4_000_000 ether);
        _buy(eoa[4], 0.6 ether);
        _collect(keeper, keeper);
    }

    struct Outcome {
        uint256 x0;
        uint256 recorded;
        uint256 j;
        uint256 x;
    }

    function _outcome() internal view returns (Outcome memory o) {
        o.x0 = stream.startValue();
        o.recorded = _recordedX0();
        o.j = stream.index();
        o.x = stream.streamValue();
    }

    /// The five orders give one X₀ (the recorded one) and, after the same life, one J:
    /// (A) every poke succeeds; (B) both the receiver's and the stream's pokes fail, then anyone's
    /// `stream.onGraduation()` runs the settlement itself (its notice re-entering `onStreamFunds`) and starts;
    /// (C) both fail, the receiver is settled later by anyone's `payPlatform()` (the notice caches X₀), then the start;
    /// (D) both fail and the whole life runs before anyone starts the stream (M28: nothing earned since graduation is
    /// lost); (E) the receiver's poke settles but its notice to the stream fails and the stream's poke fails, so the
    /// start computes X₀ from the record with no cached baseline.
    function testProperty_AUDIT_U5_startValueIsTheRecordedBaselineInEveryOrder() public {
        Outcome[5] memory out;
        for (uint256 k; k < 5; ++k) {
            uint256 snap = vm.snapshotState();
            if (k == 0) {
                _toGraduated();
                assertEq(graduationPokeFailures, 0);
                assertTrue(stream.started());
                _afterGraduation();
            } else if (k == 1) {
                _graduateBothPokesFail();
                vm.prank(eoa[5]);
                stream.onGraduation();
                assertTrue(receiver.graduationSettled(), "the stream's call settled the receiver");
                assertTrue(stream.started());
                _afterGraduation();
            } else if (k == 2) {
                _graduateBothPokesFail();
                _payPlatform(eoa[5]);
                assertTrue(receiver.graduationSettled());
                assertFalse(stream.started(), "settled, not started");
                vm.prank(eoa[5]);
                stream.onGraduation();
                _afterGraduation();
            } else if (k == 3) {
                _graduateBothPokesFail();
                _afterGraduation(); // its first batch settles the receiver; the stream is not started
                assertFalse(stream.started());
                vm.prank(eoa[5]);
                stream.onGraduation();
            } else {
                _warpTo(_requestTimeFor(r0));
                vm.mockCallRevert(a.itemStream, abi.encodeWithSelector(IBoxItemStream.onStreamFunds.selector), "");
                vm.mockCallRevert(a.itemStream, abi.encodeWithSelector(IBoxItemStream.onGraduation.selector), "");
                (, uint256 fails) = _graduate(keeper);
                vm.clearMockedCalls();
                assertEq(fails, 1, "only the stream's poke failed");
                assertTrue(receiver.graduationSettled(), "the receiver's poke settled");
                vm.prank(eoa[5]);
                stream.onGraduation();
                _afterGraduation();
            }
            out[k] = _outcome();
            vm.revertToState(snap);
        }
        for (uint256 k; k < 5; ++k) {
            assertEq(out[k].x0, out[k].recorded, "X0 is the coordinator's recorded baseline");
            assertEq(out[k].x0, out[0].x0, "one X0 in every order");
            assertEq(out[k].j, out[0].j, "one J after the same life");
            assertEq(out[k].x, out[0].x, "one X");
        }
        assertGt(out[0].x0, preBurned + 2 ether, "all three parts are in X0");
        assertGt(out[0].j, 0);
    }

    /// The same parts, read: X₀ includes the pre-graduation burn (`_s` bits 128-255 before the start), the stream's
    /// balance at graduation and 13/15 of the receiver's T claims at graduation less the curve's 2/15 depth claims;
    /// right after the start J is 0, and the stream burned what it held beyond the outside slots' margin.
    function testProperty_AUDIT_U5_theRecordedBaselineHasItsThreeParts() public {
        _toGraduated();
        assertEq(coordinator.streamStartBalance(), 2 ether + 7, "the T left in the stream");
        uint256 claims = coordinator.streamStartClaims();
        uint256 depth = receiver.streamCurveDepthT();
        assertGt(depth, 0, "the curve's 2/15 depth T, held as claims");
        assertGt(claims - depth, 15, "the curve's last T fees");
        assertEq(stream.startValue(), _recordedX0());
        assertEq(stream.index(), 0, "J starts at 0");
        (, uint256 burned) = stream.totals();
        assertEq(token.balanceOf(a.itemStream), stream.outsideCount(), "only the margin stays at the start");
        assertEq(_streamF(), stream.startValue(), "F = X0 right after the start (no swap since)");
        assertGt(burned, preBurned);
    }

    /// `onGraduation` is refused before graduation (`NotGraduated`) and once started (`AlreadyStarted`); before
    /// graduation `index()` is 0 and a burn takes everything.
    function testProperty_AUDIT_U5_onGraduationOnlyOnceAfterGraduation() public {
        vm.expectRevert(IBoxItemStream.NotGraduated.selector);
        stream.onGraduation();
        assertEq(stream.index(), 0);
        _toGraduated();
        vm.expectRevert(IBoxItemStream.AlreadyStarted.selector);
        stream.onGraduation();
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU5ClaudeStreamStartAmsterdamTest is AuditU5ClaudeStreamStartTest {}
