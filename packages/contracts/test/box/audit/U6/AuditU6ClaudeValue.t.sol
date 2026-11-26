// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {DrawStatus} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {IDrandSource} from "../../../../src/box/interfaces/IDrandSource.sol";
import {EthIn, TIn, TOut} from "../common/AuditGhostLedger.sol";
import {AuditU6ClaudeBase} from "./AuditU6ClaudeBase.sol";

/// @notice U6 lens L1 (value flow and accounting) on the factory's box 0: P6.1 (nothing stays in the tickets
/// contract, `BoxTickets.sol:47-52`), P6.2 (take, hand-back and cancel quotes from the pre-action state,
/// `BoxVault.sol:145,173,549-564`; M17, M18 hold), P6.3 (the draw's posting bounty, F75 W3, `DrandWords.sol:77-98`,
/// `IBoxTickets.sol:155-164`). Every test ends with the world's ghost ledger (X01/X02 at the boundary).
/// forge-config: default.evm_version = "osaka"
contract AuditU6ClaudeValueTest is AuditU6ClaudeBase {
    /// P6.2 take: k placeholders cost ceil(A·k/n) principal into E plus ceil(1% of it) burned, from the state before
    /// the call; the payer's T falls by exactly that, the supply by the fee, E by the principal; nothing stays here.
    function testFuzz_AUDIT_U6_takePaysCeilQuotePlusFee(uint8 kRaw) public {
        _toBonding();
        uint256 k = 1 + uint256(kRaw) % 8;
        uint256 e0 = vault.escrowPrincipal();
        uint256 s0 = token.totalSupply();
        uint256 n0 = vault.inside();
        uint256 a0 = s0 - e0;
        uint256 wantPrincipal = (a0 * k + n0 - 1) / n0;
        uint256 wantFee = (wantPrincipal * vault.drawFeeBps() + 9_999) / 10_000;
        (uint256 qp, uint256 qf) = vault.quoteTake(k);
        assertEq(qp, wantPrincipal, "quote: ceil(A k / n)");
        assertEq(qf, wantFee, "quote: ceil(1%)");
        uint256 b0 = token.balanceOf(eoa[3]);
        uint256 q0 = tickets.status().slots;
        uint256 pending0 = vault.pendingTickets();
        uint256 first = _take(eoa[3], k);
        assertEq(b0 - token.balanceOf(eoa[3]), wantPrincipal + wantFee, "the payer paid principal + fee");
        assertEq(vault.escrowPrincipal() - e0, wantPrincipal, "principal into E");
        assertEq(s0 - token.totalSupply(), wantFee, "the fee burned");
        assertEq(vault.pendingTickets() - pending0, k, "k tickets");
        for (uint256 i; i < k; ++i) {
            assertEq(tickets.ownerOf(first + i), eoa[3]);
            assertEq(tickets.slotOf(first + i), q0 + i, "the next free slots");
        }
        _assertTicketsHoldNothing();
        _assertSlotsAndTickets();
        _assertGhostLedger();
    }

    /// P6.2 hand-back on the curve: k placeholders return floor(A·k/n) less ceil(5%), from the state before the call;
    /// v1 never waives the fee (`waiveHandBackFee` has no caller in src/box); the fee is burned, E pays the principal.
    function testFuzz_AUDIT_U6_handBackPaysFloorQuoteLessFive(uint8 kRaw, uint8 order) public {
        _toBonding();
        uint256 first = _take(eoa[3], 6);
        uint256 k = 1 + uint256(kRaw) % 6;
        uint256[] memory ids = new uint256[](k);
        for (uint256 i; i < k; ++i) {
            ids[i] = first + (uint256(order) + i * 5) % 6;
        }
        // distinct ids: (order + 5 i) mod 6 runs through 6 residues for i < 6
        uint256 e0 = vault.escrowPrincipal();
        uint256 s0 = token.totalSupply();
        uint256 n0 = vault.inside();
        uint256 a0 = s0 - e0;
        uint256 wantPrincipal = (a0 * k) / n0;
        uint256 wantFee = (wantPrincipal * vault.returnFeeBps() + 9_999) / 10_000;
        (uint256 qp, uint256 qf) = vault.quoteHandBack(k);
        assertEq(qp, wantPrincipal, "quote: floor(A k / n)");
        assertEq(qf, wantFee, "quote: ceil(5%)");
        assertFalse(vault.handBackFeeWaived(), "v1 never waives");
        uint256 b0 = token.balanceOf(eoa[3]);
        (uint256 principal, uint256 fee) = _handBack(eoa[3], ids);
        assertEq(principal, wantPrincipal);
        assertEq(fee, wantFee);
        assertEq(token.balanceOf(eoa[3]) - b0, wantPrincipal - wantFee, "the holder got principal less 5%");
        assertEq(e0 - vault.escrowPrincipal(), wantPrincipal, "E paid the principal");
        assertEq(s0 - token.totalSupply(), wantFee, "the fee burned");
        _assertTicketsHoldNothing();
        _assertSlotsAndTickets();
        _assertGhostLedger();
    }

    /// P6.2 / AR-18 / M18 (holds): in terminal mode anyone cancels a requested draw; the drawer, and only the drawer,
    /// gets exactly the vault's current return quote for one, with no fee (gate open); the draw's 1% stays burned.
    function testProperty_AUDIT_U6_cancelReturnsCurrentPrincipalFeeStaysBurned() public {
        _toTerminal();
        uint256 quote = vault.quoteReturn(1);
        (uint256 hp, uint256 hf) = vault.quoteHandBack(1);
        assertEq(hp, quote, "the release quote is the return quote");
        assertEq(hf, 0, "no fee once the gate is open");
        uint256 e0 = vault.escrowPrincipal();
        uint256 s0 = token.totalSupply();
        uint256 drawer0 = token.balanceOf(eoa7702);
        uint256 caller0 = token.balanceOf(eoa[4]);
        uint256 principal = _cancelDraw(eoa[4], drawC);
        assertEq(principal, quote, "the current principal");
        assertEq(token.balanceOf(eoa7702) - drawer0, quote, "to the drawer");
        assertEq(token.balanceOf(eoa[4]), caller0, "the caller gets nothing");
        assertEq(e0 - vault.escrowPrincipal(), quote, "out of E");
        assertEq(token.totalSupply(), s0, "nothing burned at the cancel: the fee was burned at the draw");
        assertEq(uint8(tickets.drawTicket(drawC).status), uint8(DrawStatus.Cancelled));
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotCancellable.selector, drawC));
        tickets.cancelDraw(drawC);
        _assertTicketsHoldNothing();
        _assertGhostLedger();
    }

    /// P6.3 / F75 W3: the first draw of a round tops its pot up to DRAND_BOUNTY_GAS × base fee and gets the rest back;
    /// the later draws of the same round (same block) get all they sent back; the events say what each paid.
    function testProperty_AUDIT_U6_firstDrawOfRoundPaysLaterGetAllBack() public {
        _toWordAccepted();
        uint256 round = _roundNow();
        uint256 target = _target();
        assertEq(drand.bountyOf(round), 0, "an empty pot");
        address[3] memory who = [eoa[3], eoa[4], eoa[5]];
        uint256 value = 3 * target;
        uint256[3] memory paid;
        for (uint256 i; i < 3; ++i) {
            uint256 e0 = who[i].balance;
            vm.recordLogs();
            uint256 id = _draw(who[i], value); // funds `value` first
            paid[i] = _drawBounty(id);
            assertEq(e0 + value - who[i].balance, paid[i], "the drawer paid exactly its bounty");
            (, uint64 r) = src.requestOf(a.tickets, id);
            assertEq(r, round, "one round for the block");
        }
        assertEq(paid[0], target, "the first draw pays the pot");
        assertEq(paid[1], 0, "the second gets all back");
        assertEq(paid[2], 0, "the third gets all back");
        assertEq(drand.bountyOf(round), target, "the pot holds the target");
        _assertTicketsHoldNothing();
        _assertGhostLedger();
    }

    /// P6.3 with the base fee changing inside one round (blocks with the same timestamp, so the same round; on mainnet a
    /// round is one block): each draw leaves the pot at max(pot, 600,000 × its base fee) and pays the difference.
    function testProperty_AUDIT_U6_basefeeChangeInsideARound() public {
        _toWordAccepted();
        uint256 round = _roundNow();
        uint256[3] memory fees = [uint256(1 gwei), 3 gwei, 0.5 gwei];
        address[3] memory who = [eoa[3], eoa[4], eoa[5]];
        uint256 pot;
        for (uint256 i; i < 3; ++i) {
            vm.roll(vm.getBlockNumber() + 1);
            vm.fee(fees[i]);
            assertEq(_roundNow(), round, "same timestamp, same round");
            uint256 target = BOUNTY_GAS * fees[i];
            uint256 want = target > pot ? target - pot : 0;
            uint256 value = 0.01 ether;
            uint256 e0 = who[i].balance;
            vm.recordLogs();
            uint256 id = _draw(who[i], value); // funds `value` first
            assertEq(_drawBounty(id), want, "paid the shortfall only");
            assertEq(e0 + value - who[i].balance, want, "the rest came back");
            pot = pot > target ? pot : target;
            assertEq(drand.bountyOf(round), pot, "pot = max(pot, target)");
        }
        vm.fee(AUDIT_BASE_FEE);
        _assertTicketsHoldNothing();
        _assertGhostLedger();
    }

    /// P6.3: a drawer that refuses ETH still draws; everything it sent joins the pot, as the first of a round (more
    /// than the target) and as a later one (pot already full).
    function testProperty_AUDIT_U6_refusingDrawerPaysWholeValueIntoPot() public {
        _toWordAccepted();
        _giveT(eoa[3], address(ethRefuser), token.balanceOf(eoa[3]) / 4);
        uint256 round = _roundNow();
        uint256 target = _target();
        uint256 value = 2 * target;
        vm.recordLogs();
        uint256 id1 = _draw(address(ethRefuser), value);
        assertEq(_drawBounty(id1), value, "first of the round: all of it");
        assertEq(drand.bountyOf(round), value);
        vm.recordLogs();
        uint256 id2 = _draw(address(ethRefuser), value);
        assertEq(_drawBounty(id2), value, "later in the round: all of it again");
        assertEq(drand.bountyOf(round), 2 * value);
        assertEq(address(ethRefuser).balance, 0, "nothing came back");
        _assertTicketsHoldNothing();
        _assertGhostLedger();
    }

    /// P6.3 with a drawer whose `receive` burns every unit of gas it is given: the refund call (all gas, DrandWords:93)
    /// fails, the 1/64 left pays the pot with all of `msg.value`; the drawer's own gas is what it loses. Measured by
    /// `testProperty_AUDIT_U6_gasBurningDrawerMinimumGas` (binary search to 10,000 gas): such a draw needs about
    /// 2,894,774 gas on Osaka and 9,302,734 on Amsterdam (the 1/64 must cover `addBounty` and the event); 20,000,000
    /// is sent here.
    function testProperty_AUDIT_U6_gasBurningDrawerStillDraws() public {
        _toWordAccepted();
        _giveT(eoa[3], address(gasBurner), token.balanceOf(eoa[3]) / 4);
        _approveT(address(gasBurner), a.tickets);
        uint256 round = _roundNow();
        uint256 value = 2 * _target();
        vm.deal(address(gasBurner), value);
        uint256 deadline = vm.getBlockTimestamp();
        uint256 t0 = token.balanceOf(address(gasBurner));
        vm.prank(address(gasBurner));
        uint256 id = tickets.draw{value: value, gas: 20_000_000}(type(uint256).max, deadline);
        _noteEthIn(EthIn.DrawValue, value);
        _noteTChange(t0, token.balanceOf(address(gasBurner)), TIn.Draw, TOut.Other);
        assertEq(address(gasBurner).balance, 0, "nothing came back");
        assertEq(drand.bountyOf(round), value, "all of it joined the pot");
        assertEq(uint8(tickets.drawTicket(id).status), uint8(DrawStatus.Requested));
        _assertTicketsHoldNothing();
        _assertGhostLedger();
    }

    /// P6.3, measured: the least gas with which a gas-burning drawer's draw still succeeds (binary search over the
    /// call's gas limit, each probe from the same state): pinned under 3,500,000 on Osaka and 12,000,000 on Amsterdam,
    /// so such a drawer can always draw within a block, at its own cost.
    function testProperty_AUDIT_U6_gasBurningDrawerMinimumGas() public {
        _toWordAccepted();
        _giveT(eoa[3], address(gasBurner), token.balanceOf(eoa[3]) / 4);
        _approveT(address(gasBurner), a.tickets);
        uint256 value = 2 * BOUNTY_GAS * AUDIT_BASE_FEE; // the world's base fee, read once
        uint256 deadline = vm.getBlockTimestamp();
        uint256 lo = 1_000_000;
        uint256 hi = 40_000_000;
        while (hi - lo > 10_000) {
            uint256 mid = (lo + hi) / 2;
            uint256 snap = vm.snapshotState();
            vm.deal(address(gasBurner), value);
            vm.prank(address(gasBurner));
            (bool ok,) =
                a.tickets.call{value: value, gas: mid}(abi.encodeCall(tickets.draw, (type(uint256).max, deadline)));
            vm.revertToState(snap);
            if (ok) hi = mid;
            else lo = mid;
        }
        emit log_named_string("evm", vm.getEvmVersion());
        emit log_named_uint("least gas for a gas-burning drawer's draw (within 10,000)", hi);
        if (keccak256(bytes(vm.getEvmVersion())) == keccak256("amsterdam")) assertLt(hi, 12_000_000);
        else assertLt(hi, 3_500_000);
    }

    /// P6.3: the graduation word's request (graduation's poke failed: the source refused it once) is free and its value
    /// is the posting bounty of its round, forwarded whole; a second request is refused.
    function testProperty_AUDIT_U6_graduationWordValueIsItsBounty() public {
        _toClosed();
        _warpTo(_requestTimeFor(r0));
        vm.mockCallRevert(address(src), abi.encodeWithSelector(IDrandSource.request.selector, uint256(0)), "refused");
        (, uint256 failures) = _graduate(keeper);
        vm.clearMockedCalls();
        assertEq(failures, 1, "the tickets' poke failed");
        assertEq(tickets.status().wordRequestedAt, 0, "the word is unrequested");
        assertEq(drand.bountyOf(r0), 0);
        _requestGraduationWord(eoa[2], 0.01 ether);
        assertEq(drand.bountyOf(r0), 0.01 ether, "the value is r0's pot");
        (, uint64 round) = src.requestOf(a.tickets, 0);
        assertEq(round, r0, "key 0 on r0");
        vm.deal(eoa[2], 1 ether);
        vm.prank(eoa[2]);
        vm.expectRevert(IBoxTickets.WordAlreadyRequested.selector);
        tickets.requestGraduationWord{value: 1 ether}();
        _assertTicketsHoldNothing();
        _assertGhostLedger();
    }

    /// P6.3: a draw whose value cannot reach the target reverts BountyTooLow(pot + value, target); zero value works for
    /// a later draw of a round whose pot is full.
    function testProperty_AUDIT_U6_bountyTooLowAndZeroValueLaterDraw() public {
        _toWordAccepted();
        uint256 target = _target();
        _approveT(eoa[3], a.tickets);
        uint256 deadline = vm.getBlockTimestamp();
        vm.deal(eoa[3], target);
        vm.prank(eoa[3]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.BountyTooLow.selector, target - 1, target));
        tickets.draw{value: target - 1}(type(uint256).max, deadline);
        _draw(eoa[3], target);
        _approveT(eoa[4], a.tickets);
        uint256 t0 = token.balanceOf(eoa[4]);
        vm.prank(eoa[4]);
        uint256 id = tickets.draw(type(uint256).max, deadline);
        _noteTChange(t0, token.balanceOf(eoa[4]), TIn.Draw, TOut.Other);
        assertEq(uint8(tickets.drawTicket(id).status), uint8(DrawStatus.Requested), "a free later draw");
        _assertTicketsHoldNothing();
        _assertGhostLedger();
    }

    // ------------------------------------------------------------------------------------------------ helpers

    /// @dev The `bounty` field of the `DrawRequested` event of `id` in the recorded logs.
    function _drawBounty(uint256 id) internal returns (uint256) {
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == a.tickets && logs[i].topics[0] == IBoxTickets.DrawRequested.selector) {
                if (uint256(logs[i].topics[1]) == id) {
                    (,,, uint256 bounty) = abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
                    return bounty;
                }
            }
        }
        revert("no DrawRequested event");
    }
}

/// The same under Amsterdam (Glamsterdam's repricing).
/// forge-config: default.evm_version = "amsterdam"
contract AuditU6ClaudeValueAmsterdamTest is AuditU6ClaudeValueTest {}
