// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DrawStatus, ItemReveal} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {AuditU6ClaudeBase} from "./AuditU6ClaudeBase.sol";

/// @notice U6's proof tests (plan § 1.1): each passes while the behaviour it pins exists and fails once the code is
/// corrected (it asserts what is observed). Severity per plan § 4.2, reasons in docs/evidence/SH-AUDIT-B0-U6-C.md.
/// forge-config: default.evm_version = "osaka"
contract AuditU6ClaudeProofsTest is AuditU6ClaudeBase {
    // W2-U6-1, accepted as built (FQ-26, F147): settleHours saturates at 65,535 hours (7.48 years), now documented.
    /// @notice Proof 01 (Low): `settleHours` saturates at 65,535 hours, so a draw settled more than about 7.48 years
    /// after its request gets a reveal grace that ends before (or at) its own settlement; a contract drawer then has no
    /// first right at all: a stranger opens its draw in the settlement's own second.
    ///
    /// Property and source: "A third party may open a contract drawer's draw only from REVEAL_GRACE after its
    /// settlement (`DrawerOpensFirst`)" (`IBoxTickets.sol:169-172`); "for a contract drawer only after REVEAL_GRACE"
    /// (`BoxTickets.sol:35-37`); the fix of review of sh-core-v1 #3 (contract drawer opens first, `BoxTickets.sol:302-
    /// 308`); v2's original states the bound this copy dropped: "rounded up, saturating (the fallback is ≤ 1 hour later)"
    /// (`src/v2/MisfitsPlaceholders.sol:105`); box 0's copy says only "rounded up, saturating" (`BoxTickets.sol:59`).
    /// Expected: graceAt ≥ settlement + 30 days (at most 1 hour later), so `openDraw` by a stranger reverts
    /// `DrawerOpensFirst` for 30 days after any settlement.
    /// Observed: `_settle` stores min(⌈(settle − request) / 1 h⌉, 65,535) (`BoxTickets.sol:593-599`) and
    /// `_settledAt` = requestedAt + settleHours h (`:653-655`), so for a settlement S ≥ requestedAt + 65,535 h + 30 days
    /// graceAt = requestedAt + 65,535 h + 30 days ≤ S: the stranger's `openDraw` passes at S and pushes the item into the
    /// contract drawer; `drawTicket().revealFallbackAt` reports that past time.
    /// Steps: the contract drawer draws on committed round r0 + 12 (paying the 0.0006 ETH pot); the round is posted at
    /// once (its word counts); nobody settles for 65,535 h + 30 days (235,926,000 s + 2,592,000 s, 7.56 years); a
    /// stranger settles and, in the same block, opens the draw with its reveal.
    /// Amounts: one draw of ⌈A/n⌉ T + 1% (box 0's 1,969-item world), 0.001 ETH sent, 0.0006 ETH kept as the pot.
    function testAccepted_AUDIT_U6_01_settleHoursSaturationEndsTheContractDrawersFirstRight() public {
        _toDrawing(); // the clock now fixes r0 + 12 (committed)
        uint256 id = _draw(address(contractDrawer), AUDIT_DRAW_VALUE);
        (, uint64 round) = src.requestOf(a.tickets, id);
        assertEq(round, r0 + 12);
        _advance(1);
        _post(r0 + 12);
        uint256 requestedAt = tickets.drawTicket(id).requestedAt;
        uint256 settleAt = requestedAt + uint256(type(uint16).max) * 1 hours + tickets.REVEAL_GRACE();
        _warpTo(settleAt);
        assertEq(vm.getBlockTimestamp(), settleAt);
        assertEq(_settle(eoa[5], 1), 1, "the word still counts: settled now");

        IBoxTickets.DrawView memory v = tickets.drawTicket(id);
        // what the documents promise: the grace ends 30 days after the settlement, or up to an hour later
        uint256 promised = vm.getBlockTimestamp() + tickets.REVEAL_GRACE();
        // observed: the grace saturated and ends now, 30 days early
        assertEq(v.revealFallbackAt, settleAt, "revealFallbackAt is the settlement's own second");
        assertEq(promised - v.revealFallbackAt, 30 days, "the contract drawer's 30-day first right is gone");
        ItemReveal memory r = _reveal(v.itemId);
        vm.prank(eoa[5]);
        tickets.openDraw(id, eoa[5], r); // no DrawerOpensFirst
        assertEq(collection.ownerOf(v.itemId), address(contractDrawer), "pushed into the contract at once");
        assertEq(uint8(tickets.drawTicket(id).status), uint8(DrawStatus.Opened));
        _assertGhostLedger();
    }

    /// @notice The control for proof 01: one hour short of saturation the rule holds exactly (DrawerOpensFirst until
    /// settlement rounded up to the hour + 30 days). Kept as the boundary of the pinned behaviour, not a finding.
    function testProperty_AUDIT_U6_settleHoursBelowSaturationKeepsTheGrace() public {
        _toDrawing();
        uint256 id = _draw(address(contractDrawer), AUDIT_DRAW_VALUE);
        _advance(1);
        _post(r0 + 12);
        uint256 requestedAt = tickets.drawTicket(id).requestedAt;
        _warpTo(requestedAt + (uint256(type(uint16).max) - 1) * 1 hours);
        assertEq(_settle(eoa[5], 1), 1);
        IBoxTickets.DrawView memory v = tickets.drawTicket(id);
        assertGe(v.revealFallbackAt, vm.getBlockTimestamp() + tickets.REVEAL_GRACE(), "30 days after the settlement");
        ItemReveal memory r = _reveal(v.itemId);
        vm.prank(eoa[5]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.DrawerOpensFirst.selector, id, v.revealFallbackAt));
        tickets.openDraw(id, eoa[5], r);
    }
}
