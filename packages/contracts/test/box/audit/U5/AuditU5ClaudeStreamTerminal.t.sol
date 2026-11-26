// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditU5ClaudeBase} from "./AuditU5ClaudeBase.sol";

/// @title AuditU5ClaudeStreamTerminalTest
/// @notice SH-AUDIT-B0 U5 (Claude): the stream's terminal-mode branches the main campaign cannot reach (its word is
/// accepted): box 0 graduated, drand silent from the start (the graduation word's round r0 never posted, no backup),
/// terminal mode on the graduation word. Then placeholders are handed back after graduation (BoxItemStream.sol
/// :591-616: no ticket in flight, booked from the start, J per placeholder, to the account the vault pays) and items
/// are taken by number without any numbering (`_ticketsOpened`'s terminal branch, :574-583: an exit marked at J now).
/// forge-config: default.evm_version = "osaka"
contract AuditU5ClaudeStreamTerminalTest is AuditU5ClaudeBase {
    function setUp() public override {
        super.setUp();
        _toGraduated();
        // Fees after graduation, so J > 0 before terminal mode.
        _sell(eoa[2], 6_000_000 ether);
        _buy(eoa[4], 0.6 ether);
        _collect(keeper, keeper);
        _toSilentFromGraduation();
        _toTerminal();
        assertEq(tickets.graduationWord(), bytes32(0), "no word");
        assertTrue(tickets.status().terminalAt != 0);
    }

    function _ids3() internal pure returns (uint256[] memory ids) {
        ids = new uint256[](3);
        (ids[0], ids[1], ids[2]) = (1, 2, 3);
    }

    /// A hand-back after graduation (terminal mode, no word) books each placeholder's accrual since the start (J) to
    /// the holder the vault pays, takes them off the open placeholders and the outside slots, and the holder's claim
    /// pays it (less the 1 raw unit kept).
    function testProperty_AUDIT_U5_terminalHandBackBooksJPerPlaceholder() public {
        uint256 j = stream.index();
        assertGt(j, 0);
        (uint256 p0,,) = stream.openTickets();
        assertEq(p0, 5);
        uint256 m0 = stream.outsideCount();
        uint256 owed0 = stream.owedOf(eoa[0]);
        _handBack(eoa[0], _ids3());
        assertEq(stream.owedOf(eoa[0]) - owed0, 3 * j, "J since the start, per placeholder");
        (uint256 p1,,) = stream.openTickets();
        assertEq(p1, 2, "three placeholders closed");
        assertEq(stream.outsideCount(), m0 - 3, "three slots back inside");
        uint256 paid = _claimStream(eoa[0], new uint256[](0));
        assertEq(paid, 3 * j - 1, "paid, 1 raw unit kept");
        _assertBooksExact();
    }

    /// A take by number with no numbering (no word) starts its Misfit at J now: nothing earned before it, and its share
    /// accrues from then on like any outside Misfit's.
    function testProperty_AUDIT_U5_terminalTakeStartsAtJNow() public {
        _warpTo(uint256(tickets.status().terminalAt) + tickets.TAKE_DELAY());
        uint256 item = 100;
        assertTrue(vault.isHidden(item));
        uint256 m0 = stream.outsideCount();
        _takeByNumber(eoa[3], item, 0, true);
        (address o, uint256 p) = stream.pendingOf(item);
        assertEq(o, eoa[3]);
        assertEq(p, 0, "starts at J now");
        assertEq(stream.outsideCount(), m0 + 1);
        uint256 j0 = stream.index();
        _sell(eoa[2], 3_000_000 ether);
        (, p) = stream.pendingOf(item);
        assertEq(p, stream.index() - j0, "then accrues like any outside Misfit");
        _assertBooksExact();
    }

    /// Every slot's accrual booked or waiting, exactly: liabilities == Σ owed + the outside Misfits' pending + p·J.
    function _assertBooksExact() internal view {
        uint256 j = stream.index();
        uint256 sum = stream.owedOf(eoa[0]) + stream.owedOf(eoa[1]) + stream.owedOf(eoa[3]);
        (, uint256 pend) = stream.pendingOf(100);
        sum += pend;
        (uint256 ph, uint256 dr, uint256 ds) = stream.openTickets();
        assertEq(dr, 0);
        assertEq(ds, 0);
        assertEq(stream.liabilities(), sum + ph * j, "every slot booked or waiting");
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU5ClaudeStreamTerminalAmsterdamTest is AuditU5ClaudeStreamTerminalTest {}
