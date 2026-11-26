// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DrawStatus, TicketPhase} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {IDrandSource} from "../../../../src/box/interfaces/IDrandSource.sol";
import {AuditU6FableBase} from "./AuditU6FableBase.sol";

/// @notice SH-AUDIT-B0 U6 (Fable): proof tests (plan § 1.1). Each passes while the behaviour it pins exists and fails
/// once the code is corrected; at fix time it is flipped into the property assertion.
/// forge-config: default.evm_version = "osaka"
contract AuditU6FableProofsTest is AuditU6FableBase {
    function setUp() public override {
        super.setUp();
        _buildRevealCache();
    }

    /// @notice Proof 25. **Property:** a dead queue head stays dead, so terminal mode opens when the rule says
    /// (BoxTickets.sol:42-44: "a queue head without a usable word SILENCE (7 days) after its request, or
    /// SILENCE_UNREQUESTED (30 days) after graduation when nobody requested the graduation word, lets anyone
    /// enterTerminal"; DrandSource.sol:28-30 / IDrandSource.sol:18-20 make silence final: "a late post never undoes
    /// it"; BC-051; F61 R4). For a requested key the code enforces finality (a late word is unusable, `_usableWord`
    /// `readyAt <= requestedAt + SILENCE`). For the unrequested graduation word it does not: `requestGraduationWord`
    /// (BoxTickets.sol:195-204) and `draw`'s own request path (`sendWord`, :231-238, which skips the `QueueDead`
    /// check) only test `terminalAt == 0`, never the 30-day deadline, so a request landed after graduation + 30 days
    /// moves the head's deadline to request + 7 days (`_head`, :745-748).
    /// **Expected:** at graduation + 30 days + 1 s the head is dead and `enterTerminal` succeeds for anyone; a request
    /// made then is refused or does not revive the head.
    /// **Observed:** the request succeeds (a stranger's `requestGraduationWord`, or any drawer's first draw), the head
    /// is alive again for 7 more days (`HeadNotDead(0, request + 7 days)`), draws are accepted again behind it, and
    /// terminal mode opens only at day 37 + 1 s if drand stays silent, or never if the requested round is posted (the
    /// box then lives on with a word nobody could choose). The revival can be repeated only once (the key is then
    /// requested, and that state is final).
    /// **Steps:** box 0 graduated with its word poke failed (the only way the word stays unrequested; F126 keeps no
    /// retry), nobody requests for 30 days; at +30 d + 1 s a snapshot shows `enterTerminal` passes; revert; a stranger
    /// calls `requestGraduationWord()` with no value; `enterTerminal` reverts `HeadNotDead(0, t + 7 d)`; a draw by
    /// another EOA is accepted; at t + 7 d still refused; at t + 7 d + 1 s terminal mode opens.
    /// **Amounts:** no ETH or T is gained by anyone; the cost of the revival is one transaction; holders waiting for
    /// terminal mode's fee-free hand-backs and the drawers' cancels wait 7 days longer. Severity estimate: Low (a
    /// timing effect beyond the documented bound, one-shot, no value moved; see the evidence).
    function test_AUDIT_U6_25_deadUnrequestedWordRevivedByALateRequest() public {
        _toClosed();
        _warpTo(_requestTimeFor(r0));
        vm.mockCallRevert(address(src), abi.encodeWithSelector(IDrandSource.request.selector, 0), "poke fails");
        _graduate(keeper);
        vm.clearMockedCalls();
        uint256 gateAt = vault.gateOpenedAt();
        assertEq(_st().wordRequestedAt, 0, "the word was never requested");
        _warpTo(gateAt + SILENCE_UNREQUESTED + 1);
        (bool exists, bool dead, uint256 key, uint256 deadline) = _refHead();
        assertTrue(exists && dead && key == 0 && deadline == gateAt + SILENCE_UNREQUESTED, "the head is dead");
        uint256 snap = vm.snapshotState();
        vm.prank(eoa[5]);
        tickets.enterTerminal();
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Terminal), "expected: terminal mode opens now");
        vm.revertToState(snap);

        // Observed: a stranger's request after the deadline is accepted and revives the head for 7 days.
        uint256 t = vm.getBlockTimestamp();
        vm.prank(eoa[4]);
        tickets.requestGraduationWord();
        assertEq(_st().wordRequestedAt, t, "the late request was accepted");
        (, dead,, deadline) = _refHead();
        assertFalse(dead, "observed: the dead head is alive again");
        assertEq(deadline, t + SILENCE, "its deadline moved to request + 7 days");
        vm.prank(eoa[5]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.HeadNotDead.selector, 0, t + SILENCE));
        tickets.enterTerminal();
        // Draws are accepted again behind the revived head (their T waits for the word or the next terminal entry).
        _fundDraws(eoa[3], 1);
        uint256 id = _draw(eoa[3], AUDIT_DRAW_VALUE);
        assertEq(uint8(_dv(id).status), uint8(DrawStatus.Requested));
        _warpTo(t + SILENCE);
        vm.prank(eoa[5]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.HeadNotDead.selector, 0, t + SILENCE));
        tickets.enterTerminal();
        _warpTo(t + SILENCE + 1);
        vm.prank(eoa[5]);
        tickets.enterTerminal();
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Terminal), "terminal mode 7 days later than the rule says");
        assertEq(vm.getBlockTimestamp(), gateAt + SILENCE_UNREQUESTED + 1 + SILENCE + 1);
        // The second revival path, the same way: a first draw after the deadline requests the word itself.
        vm.revertToState(snap);
        _fundDraws(eoa[3], 1);
        id = _draw(eoa[3], AUDIT_DRAW_VALUE);
        assertEq(_st().wordRequestedAt, vm.getBlockTimestamp(), "the draw revived the head");
        vm.prank(eoa[5]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.HeadNotDead.selector, 0, vm.getBlockTimestamp() + SILENCE));
        tickets.enterTerminal();
        _assertGhostLedger();
    }

    /// @notice Pinned alongside proof 25: the requested-key dead states are final (a late post or a late backup fix
    /// never revives a dead draw head or a dead requested word), so the revival is confined to the unrequested word.
    function testProperty_AUDIT_U6_requestedDeadHeadsAreFinal() public {
        _toGraduated();
        uint256 requestedAt = _st().wordRequestedAt;
        _warpTo(requestedAt + SILENCE + 1);
        _post(r0);
        (, bool dead,,) = _refHead();
        assertTrue(dead, "a word posted a second late does not revive the requested word");
        vm.expectRevert(IBoxTickets.WordNotReady.selector);
        tickets.acceptGraduationWord();
        vm.expectRevert(IBoxTickets.WordAlreadyRequested.selector);
        tickets.requestGraduationWord();
        _warpTo(vm.getBlockTimestamp() + 60 days);
        (, dead,,) = _refHead();
        assertTrue(dead, "still dead");
        tickets.enterTerminal();
    }
}
