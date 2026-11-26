// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {DrawStatus, ItemReveal, TicketPhase} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {IDrandSource} from "../../../../src/box/interfaces/IDrandSource.sol";
import {DrandWords} from "../../../../src/box/randomness/DrandWords.sol";
import {EthIn, EthOut, TIn, TOut} from "../common/AuditGhostLedger.sol";
import {AuditRevealSet} from "../common/AuditRevealSet.sol";
import {AuditU6FableBase} from "./AuditU6FableBase.sol";

/// @notice SH-AUDIT-B0 U6 (Fable): L1 value flow and accounting (P6.1, P6.2, P6.3) and the arithmetic behind the
/// quotes (L7), on the factory's box 0 with the real BoxBackedSource and DrandSource.
/// forge-config: default.evm_version = "osaka"
contract AuditU6FableValueTest is AuditU6FableBase {
    function setUp() public virtual override {
        super.setUp();
        _buildRevealCache();
    }

    /// The reveal cache answers exactly what `AuditRevealSet` computes (so every reveal below is the library's).
    function testProperty_AUDIT_U6_revealCacheMatchesTheLibrary() public view {
        uint256[4] memory ids = [uint256(1), 2, 1_000, editionSize];
        for (uint256 i; i < ids.length; ++i) {
            ItemReveal memory want = AuditRevealSet.itemReveal(editionSize, ids[i]);
            ItemReveal memory got = _rv(ids[i]);
            assertEq(got.proof.length, want.proof.length, "depth");
            for (uint256 k; k < want.proof.length; ++k) {
                assertEq(got.proof[k], want.proof[k], "sibling");
            }
            assertEq(got.traitsPacked, want.traitsPacked);
            assertEq(got.salt, want.salt);
        }
    }

    // ================================================================================================ P6.1

    /// P6.1 (BoxTickets.sol:47-52): no T and no ETH stays in the tickets contract after take, hand-back, draw (with a
    /// refund, with a refused refund), settle, open, openDraw, enterTerminal, cancel and takeByNumber; the ghost ledger
    /// balances at every step (X01/X02 at the boundary).
    function testProperty_AUDIT_U6_nothingStaysInTheTicketsContract() public {
        _toBonding();
        _assertNothingStays();
        _take(eoa[3], 2);
        _assertNothingStays();
        _handBack(eoa[3], _one(6));
        _assertNothingStays();
        _toDrawing();
        _assertNothingStays();
        _advance(1);
        // A drawer that refuses ETH: its rest joins the pot, nothing stays here.
        uint256 pot0 = drand.bountyOf(src.roundAt(vm.getBlockTimestamp() + 12));
        _fundDraws(address(ethRefuser), 1);
        _draw(address(ethRefuser), AUDIT_DRAW_VALUE);
        assertEq(drand.bountyOf(_roundOf(3)), pot0 + AUDIT_DRAW_VALUE, "the refused rest joined the pot");
        _assertNothingStays();
        _draw(eoa[4], AUDIT_DRAW_VALUE);
        _assertNothingStays();
        _toTerminal();
        _assertNothingStays();
        _cancelDraw(eoa[5], 3);
        _assertNothingStays();
        _warpTo(uint256(_st().terminalAt) + TAKE_DELAY);
        (uint256 item,) = _poolItem(0);
        _takeByNumber(eoa[5], item, 0, true);
        _assertNothingStays();
        _open(eoa[0], 2, true);
        _assertNothingStays();
    }

    function _assertNothingStays() internal view {
        assertEq(token.balanceOf(a.tickets), 0, "no T in the tickets contract");
        assertEq(a.tickets.balance, 0, "no ETH in the tickets contract");
        _assertGhostLedger();
    }

    // ================================================================================================ P6.2

    /// P6.2 (IBoxTickets.sol:11-12; BoxVault.sol:24-26): `take(k)` pays ⌈A·k/n⌉ into E plus ⌈1%⌉ burned, quoted from
    /// the state before the action (A = S − E, n = inside); the vault's E and T balance rise by the principal only.
    function testFuzz_AUDIT_U6_takeQuoteIsCeilAndFeeBurned(uint8 kSeed) public {
        _toBonding();
        uint256 k = 1 + kSeed % 6;
        address who = eoa[3];
        uint256 s = token.totalSupply();
        uint256 e = vault.escrowPrincipal();
        uint256 n = vault.inside();
        uint256 principal = FullMath.mulDivRoundingUp(s - e, k, n);
        uint256 fee = FullMath.mulDivRoundingUp(principal, 100, 10_000);
        (uint256 qp, uint256 qf) = vault.quoteTake(k);
        assertEq(qp, principal, "the vault's quote: ceil(A k / n)");
        assertEq(qf, fee, "1% rounded up");
        uint256 t0 = token.balanceOf(who);
        uint256 burned0 = token.totalBurned();
        uint256 pending0 = vault.pendingTickets();
        uint256 first = _take(who, k);
        assertEq(token.balanceOf(who), t0 - principal - fee, "the payer pays principal + fee");
        assertEq(vault.escrowPrincipal(), e + principal, "E rose by the principal");
        assertEq(token.balanceOf(a.vault), e + principal, "the vault holds exactly E");
        assertEq(token.totalSupply(), s - fee, "the fee left the supply");
        assertEq(token.totalBurned(), burned0 + fee, "the fee is burned");
        assertEq(vault.inside(), n - k);
        assertEq(vault.pendingTickets(), pending0 + k);
        for (uint256 i; i < k; ++i) {
            assertEq(tickets.ownerOf(first + i), who);
        }
        _assertGhostLedger();
    }

    /// P6.2: `handBack` of j placeholders pays ⌊A·j/n⌋ less ⌈5%⌉ on the curve (v1 never waives), from the pre-action
    /// state; the fee is burned, E falls by the principal, the holder receives principal − fee.
    function testFuzz_AUDIT_U6_handBackQuoteIsFloorLessFivePercent(uint8 kSeed, uint8 jSeed) public {
        _toBonding();
        uint256 k = 1 + kSeed % 6;
        uint256 j = 1 + jSeed % k;
        uint256 first = _take(eoa[3], k);
        uint256[] memory ids = new uint256[](j);
        for (uint256 i; i < j; ++i) {
            ids[i] = first + i;
        }
        Quote memory q = _expectedReturn(j);
        assertFalse(vault.handBackFeeWaived(), "v1 never waives");
        uint256 t0 = token.balanceOf(eoa[3]);
        uint256 burned0 = token.totalBurned();
        (uint256 gotP, uint256 gotF) = _handBack(eoa[3], ids);
        assertEq(gotP, q.principal, "floor(A j / n)");
        assertEq(gotF, q.fee, "5% rounded up, on the curve");
        assertEq(token.balanceOf(eoa[3]), t0 + q.principal - q.fee, "the holder receives principal less the fee");
        assertEq(vault.escrowPrincipal(), q.e - q.principal, "E fell by the principal");
        assertEq(token.balanceOf(a.vault), q.e - q.principal);
        assertEq(token.totalBurned(), burned0 + q.fee, "the fee is burned");
        assertEq(vault.inside(), q.n + j);
        // The freed slots are compacted: q = live placeholders, every live one below q and distinct.
        _assertSlotsConsistent();
        _assertGhostLedger();
    }

    struct Quote {
        uint256 e;
        uint256 n;
        uint256 principal;
        uint256 fee;
    }

    /// @dev The return quote for `j` tickets from the current state, computed here from the documents' formula, and
    /// checked against the vault's own view.
    function _expectedReturn(uint256 j) internal view returns (Quote memory q) {
        uint256 s = token.totalSupply();
        q.e = vault.escrowPrincipal();
        q.n = vault.inside();
        q.principal = FullMath.mulDiv(s - q.e, j, q.n);
        q.fee = FullMath.mulDivRoundingUp(q.principal, 500, 10_000);
        (uint256 vp, uint256 vf) = vault.quoteHandBack(j);
        assertEq(vp, q.principal, "the vault's return quote: floor(A j / n)");
        assertEq(vf, q.fee, "the vault's fee: 5% rounded up");
    }

    /// P6.2 (BoxTickets.sol:44; ADR-0013 § 3.3 rule 3 "the base is returned and the fee stays burned"): in terminal
    /// mode `cancelDraw` pays the vault's fee-free return quote for one ticket (⌊A/n⌋ from the state before the cancel),
    /// the draw's 1% fee stays burned. The amount is the release quote of the moment, not the wei the drawer paid:
    /// the difference is the fee's and the rounding's share, logged below.
    function testProperty_AUDIT_U6_cancelReturnsTheReleaseQuoteFeeStaysBurned() public {
        _toSilent();
        IBoxTickets.DrawView memory d = _dv(drawC);
        assertEq(uint8(d.status), uint8(DrawStatus.Requested));
        _warpTo(uint256(d.requestedAt) + SILENCE + 1);
        vm.prank(eoa[5]);
        tickets.enterTerminal();
        (uint256 qp, uint256 qf) = vault.quoteHandBack(1);
        assertEq(qf, 0, "fee-free after graduation");
        uint256 s = token.totalSupply();
        uint256 e = vault.escrowPrincipal();
        uint256 n = vault.inside();
        assertEq(qp, FullMath.mulDiv(s - e, 1, n), "floor(A / n)");
        uint256 burned0 = token.totalBurned();
        uint256 t0 = token.balanceOf(eoa7702);
        uint256 got = _cancelDraw(eoa[4], drawC);
        assertEq(got, qp, "exactly the release quote");
        assertEq(token.balanceOf(eoa7702), t0 + qp, "paid to the drawer, whoever cancels");
        assertEq(token.totalBurned(), burned0, "the draw's fee stays burned: nothing burned or unburned now");
        assertEq(vault.escrowPrincipal(), e - qp);
        assertEq(uint8(_dv(drawC).status), uint8(DrawStatus.Cancelled));
        emit log_named_uint("T the draws paid in all (principal + fee), from the ledger", ghostTIn(TIn.Draw));
        emit log_named_uint("T draw C's cancel returned", got);
        _assertGhostLedger();
    }

    /// P6.2, measured: a draw followed at once by its cancel (terminal mode entered on another dead head) returns
    /// ⌊A'/n'⌋ where A' lost the draw's own fee; the shortfall against the principal paid is bounded by
    /// ⌈fee/(n − 1)⌉ + 1 wei of rounding (the fee is 1% of one item's worth, spread over the n − 1 remaining items).
    function testProperty_AUDIT_U6_cancelShortfallIsTheBurnedFeeShareAndRounding() public {
        _toDrawing();
        _advance(1);
        uint256 n = vault.inside();
        (uint256 p, uint256 f) = vault.quoteTake(1);
        uint256 id = _draw(eoa[4], AUDIT_DRAW_VALUE); // a silent round: this draw can never settle
        uint256 requestedAt = vm.getBlockTimestamp();
        _warpTo(requestedAt + SILENCE + 1);
        vm.prank(eoa[5]);
        tickets.enterTerminal();
        uint256 back = _cancelDraw(eoa[5], id);
        assertLe(back, p, "never more than the principal paid");
        uint256 bound = (f + (n - 2)) / (n - 1) + 1;
        assertLe(p - back, bound, "shortfall <= the fee's share over n - 1 items + 1 wei");
        emit log_named_uint("principal paid", p);
        emit log_named_uint("fee burned", f);
        emit log_named_uint("principal returned by the cancel", back);
        emit log_named_uint("shortfall (wei of T)", p - back);
        _assertGhostLedger();
    }

    /// P6.2: `takeByNumber` pays the draw quote (⌈A/n⌉ + 1% burned) from the pre-action state, into E.
    function testProperty_AUDIT_U6_takeByNumberPaysTheDrawQuote() public {
        _toTerminal();
        _warpTo(uint256(_st().terminalAt) + TAKE_DELAY);
        (uint256 item, bool hidden) = _poolItem(0);
        assertTrue(hidden);
        uint256 s = token.totalSupply();
        uint256 e = vault.escrowPrincipal();
        uint256 n = vault.inside();
        uint256 principal = FullMath.mulDivRoundingUp(s - e, 1, n);
        uint256 fee = FullMath.mulDivRoundingUp(principal, 100, 10_000);
        uint256 t0 = token.balanceOf(eoa[5]);
        (uint256 gp, uint256 gf) = _takeByNumber(eoa[5], item, 0, true);
        assertEq(gp, principal);
        assertEq(gf, fee);
        assertEq(token.balanceOf(eoa[5]), t0 - principal - fee);
        assertEq(vault.escrowPrincipal(), e + principal);
        assertEq(token.totalSupply(), s - fee);
        assertEq(collection.ownerOf(item), eoa[5]);
        assertTrue(collection.isRevealed(item));
        _assertGhostLedger();
    }

    // ================================================================================================ P6.3

    /// P6.3 (F75 W3; review of sh-f75; IBoxTickets.sol:155-163): in one block three drawers each send 0.001 ETH; the
    /// round's pot ends at DRAND_BOUNTY_GAS × base fee (0.0006 ETH at 1 gwei), the first paid exactly the target, the
    /// others got everything back, the `DrawRequested` events name what went into the pot, and the first draw of a
    /// round without the target reverts `BountyTooLow(pot + value, target)`.
    function testProperty_AUDIT_U6_drawPaysTheRoundOnceAndRefundsTheRest() public {
        _toDrawing();
        _advance(1);
        uint256 target = _target();
        assertEq(target, 0.0006 ether, "600,000 gas at 1 gwei");
        uint256 round = src.roundAt(vm.getBlockTimestamp() + 12);
        assertEq(drand.bountyOf(round), 0, "an empty pot");
        uint256 deadline = vm.getBlockTimestamp();
        _approveT(eoa[3], a.tickets);
        _fund(eoa[3], target);
        vm.prank(eoa[3]);
        vm.expectRevert(abi.encodeWithSelector(DrandWords.BountyTooLow.selector, target - 1, target));
        tickets.draw{value: target - 1}(type(uint256).max, deadline);

        _prepareDraw(eoa[3], AUDIT_DRAW_VALUE);
        uint256 e3 = eoa[3].balance;
        uint256 e4 = eoa[4].balance + AUDIT_DRAW_VALUE;
        uint256 e5 = eoa[5].balance + AUDIT_DRAW_VALUE;
        (uint256 qp, uint256 qf) = vault.quoteTake(1);
        vm.expectEmit(true, true, false, true, a.tickets);
        emit IBoxTickets.DrawRequested(3, eoa[3], qp, qf, round, target);
        uint256 first = _drawAfterExpect(eoa[3], AUDIT_DRAW_VALUE);
        _draw(eoa[4], AUDIT_DRAW_VALUE);
        _draw(eoa[5], AUDIT_DRAW_VALUE);
        assertEq(_roundOf(first), round);
        assertEq(_roundOf(first + 1), round, "one round for the block");
        assertEq(_roundOf(first + 2), round);
        assertEq(drand.bountyOf(round), target, "the pot at the target, not three times it");
        assertEq(eoa[3].balance, e3 - target, "the first draw paid the posting");
        assertEq(eoa[4].balance, e4, "the second got all back");
        assertEq(eoa[5].balance, e5, "the third got all back");
        assertEq(ghostEthIn(EthIn.DrawValue) - ghostEthOut(EthOut.Refund), 3 * target, "three pots paid in all");
        assertEq(a.tickets.balance, 0);
        _assertGhostLedger();
    }

    /// P6.3 on the real DrandSource: when a later block fixes the same quicknet round at a higher base fee, its draw
    /// tops the pot up by the difference and gets the rest back; at a lower base fee it pays nothing.
    function testProperty_AUDIT_U6_baseFeeChangeBetweenDrawsOfOneRound() public {
        _toDrawing();
        _advance(1);
        // Two consecutive seconds inside one round (rounds are 3 s apart; blocks here are 12 s, so nudge the clock).
        while (src.roundAt(vm.getBlockTimestamp() + 12) != src.roundAt(vm.getBlockTimestamp() + 13)) {
            vm.warp(vm.getBlockTimestamp() + 1);
        }
        uint256 round = src.roundAt(vm.getBlockTimestamp() + 12);
        uint256 low = _target();
        uint256 e3 = eoa[3].balance + AUDIT_DRAW_VALUE;
        uint256 first = _draw(eoa[3], AUDIT_DRAW_VALUE);
        assertEq(_roundOf(first), round);
        assertEq(eoa[3].balance, e3 - low);
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.roll(vm.getBlockNumber() + 1);
        vm.fee(1.25 gwei);
        uint256 high = _target();
        assertGt(high, low);
        uint256 deadline = vm.getBlockTimestamp();
        _approveT(eoa[4], a.tickets);
        vm.prank(eoa[4]);
        vm.expectRevert(abi.encodeWithSelector(DrandWords.BountyTooLow.selector, low, high));
        tickets.draw(type(uint256).max, deadline);
        uint256 e4 = eoa[4].balance + AUDIT_DRAW_VALUE;
        uint256 second = _draw(eoa[4], AUDIT_DRAW_VALUE);
        assertEq(_roundOf(second), round, "the same round");
        assertEq(eoa[4].balance, e4 - (high - low), "only the difference");
        assertEq(drand.bountyOf(round), high);
        vm.fee(0.5 gwei);
        uint256 e5 = eoa[5].balance + AUDIT_DRAW_VALUE;
        uint256 third = _draw(eoa[5], AUDIT_DRAW_VALUE);
        assertEq(_roundOf(third), round);
        assertEq(eoa[5].balance, e5, "nothing at a lower base fee");
        assertEq(drand.bountyOf(round), high, "the pot unchanged");
        vm.fee(AUDIT_BASE_FEE);
        _assertGhostLedger();
    }

    /// P6.3: a drawer that refuses ETH still draws and its whole value joins the pot (first and later draws alike); a
    /// drawer whose `receive` burns all the gas it gets does the same (the refund fails, the rest joins the pot) and
    /// the draw completes within a 6,000,000-gas call (the refund keeps 63/64 of what is left; the 64th finishes the
    /// draw: under Amsterdam 2,000,000 was not enough, the drawer's own loss).
    function testProperty_AUDIT_U6_refusedRefundJoinsThePot() public {
        _toDrawing();
        _advance(1);
        uint256 round = src.roundAt(vm.getBlockTimestamp() + 12);
        uint256 target = _target();
        _fundDraws(address(ethRefuser), 2);
        _fundDraws(address(gasBurner), 1);
        _draw(address(ethRefuser), AUDIT_DRAW_VALUE);
        assertEq(drand.bountyOf(round), AUDIT_DRAW_VALUE, "all of it: the refund was refused");
        _draw(address(ethRefuser), AUDIT_DRAW_VALUE);
        assertEq(drand.bountyOf(round), 2 * AUDIT_DRAW_VALUE, "a later draw's refused refund too");
        assertGt(AUDIT_DRAW_VALUE, target);

        // The gas burner, with a bounded call: the refund burns 63/64 of what is left, the rest finishes the draw.
        _approveT(address(gasBurner), a.tickets);
        _fund(address(gasBurner), AUDIT_DRAW_VALUE);
        uint256 deadline = vm.getBlockTimestamp();
        uint256 pot0 = drand.bountyOf(round);
        uint256 t0 = token.balanceOf(address(gasBurner));
        vm.prank(address(gasBurner));
        uint256 id = tickets.draw{value: AUDIT_DRAW_VALUE, gas: 6_000_000}(type(uint256).max, deadline);
        _noteEthIn(EthIn.DrawValue, AUDIT_DRAW_VALUE);
        _noteTChange(t0, token.balanceOf(address(gasBurner)), TIn.Draw, TOut.Other);
        assertEq(uint8(_dv(id).status), uint8(DrawStatus.Requested));
        assertEq(drand.bountyOf(round), pot0 + AUDIT_DRAW_VALUE, "the burner's whole value joined the pot");
        assertEq(a.tickets.balance, 0);
        _assertGhostLedger();
    }

    /// P6.3 (BoxTickets.sol:244-245; F75 W3): when the coordinator's poke of the word failed, the first draw requests
    /// the graduation word too; both requests fix the same round, one bounty serves both, and the word's request is free
    /// for anyone (`requestGraduationWord` with any value, forwarded whole).
    function testProperty_AUDIT_U6_firstDrawRequestingTheWordPaysOneBounty() public {
        _toClosed();
        _warpTo(_requestTimeFor(r0));
        vm.mockCallRevert(address(src), abi.encodeWithSelector(IDrandSource.request.selector, 0), "poke fails");
        (, uint256 failures) = _graduate(keeper);
        vm.clearMockedCalls();
        assertEq(failures, 1, "the word's poke failed");
        assertEq(_st().wordRequestedAt, 0, "no word requested");
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.AwaitingWord));
        _advance(1);
        uint256 round = src.roundAt(vm.getBlockTimestamp() + 12);
        uint256 target = _target();
        _prepareDraw(eoa[3], AUDIT_DRAW_VALUE);
        uint256 e3 = eoa[3].balance;
        vm.expectEmit(true, false, false, true, a.tickets);
        emit IBoxTickets.GraduationWordRequested(eoa[3], round, 0);
        uint256 id = _drawAfterExpect(eoa[3], AUDIT_DRAW_VALUE);
        assertEq(_roundOf(0), round, "the word's round");
        assertEq(_roundOf(id), round, "the draw's round: the same");
        assertEq(drand.bountyOf(round), target, "one bounty for both");
        assertEq(eoa[3].balance, e3 - target);
        assertEq(_st().wordRequestedAt, vm.getBlockTimestamp());
        // Requested now: a stranger's request is refused; before the draw it would have been accepted with any value.
        vm.prank(eoa[5]);
        vm.expectRevert(IBoxTickets.WordAlreadyRequested.selector);
        tickets.requestGraduationWord();
        _assertGhostLedger();
    }

    /// P6.3: the graduation word's request by a stranger (the poke failed) forwards its whole value as the round's
    /// bounty; nothing stays; later draws of that round pay nothing more when the bounty already covers the target.
    function testProperty_AUDIT_U6_strangerRequestsTheWordWithAnyBounty() public {
        _toClosed();
        _warpTo(_requestTimeFor(r0));
        vm.mockCallRevert(address(src), abi.encodeWithSelector(IDrandSource.request.selector, 0), "poke fails");
        _graduate(keeper);
        vm.clearMockedCalls();
        _advance(1);
        uint256 round = src.roundAt(vm.getBlockTimestamp() + 12);
        _requestGraduationWord(eoa[5], 0.01 ether);
        assertEq(drand.bountyOf(round), 0.01 ether, "the whole value is the bounty");
        assertEq(a.tickets.balance, 0);
        uint256 e3 = eoa[3].balance + AUDIT_DRAW_VALUE;
        _draw(eoa[3], AUDIT_DRAW_VALUE);
        assertEq(eoa[3].balance, e3, "the round is funded: all back");
        assertEq(drand.bountyOf(round), 0.01 ether);
        _assertGhostLedger();
    }

    // ================================================================================================ ETH exits

    /// Every ETH send of this unit forwards all gas, so no stipend-only path exists: the draw's refund
    /// (`DrandWords.payRound`, `call(gas(), …)`) and the pot's exit (`DrandSource.withdrawBounty`, `to.call{value}`)
    /// both reach an EIP-7702-delegated account, under Osaka and (the variant below) Amsterdam, where a 2,300-gas
    /// stipend alone would fail in the delegate (R0-A's observation).
    function testProperty_AUDIT_U6_ethSendsReachA7702AccountOnBothEvms() public {
        _toDrawing();
        _advance(1);
        uint256 target = _target();
        uint256 e0 = eoa7702.balance + AUDIT_DRAW_VALUE;
        uint256 d = _draw(eoa7702, AUDIT_DRAW_VALUE);
        assertEq(eoa7702.balance, e0 - target, "the refund reached the 7702 account");
        assertEq(_dv(d).drawer, eoa7702);
        // The poster withdraws its credits to the 7702 account.
        uint256 owed = drand.owedTo(poster);
        assertGt(owed, 0, "the poster holds the pots of the posted rounds");
        uint256 b0 = eoa7702.balance;
        (bool ok, uint256 amount) = _tryWithdrawBounty(poster, payable(eoa7702));
        assertTrue(ok, "withdrawBounty to a 7702 account");
        assertEq(amount, owed);
        assertEq(eoa7702.balance, b0 + owed);
        // And to a recipient whose receive uses all its gas: refused (the credit stays), never a silent loss.
        (ok,) = _tryWithdrawBounty(poster, payable(address(gasBurner)));
        assertFalse(ok);
        emit log_named_string("evm", _evm());
        _assertGhostLedger();
    }

    // ================================================================================================ L7 slots

    /// P6.15 (IBoxTickets.sol:27-29): random takes, transfers and hand-backs on the curve keep every live placeholder in
    /// a distinct slot below q, minted − burned == live, and the vault's pending tickets == live placeholders.
    function testFuzz_AUDIT_U6_curveSlotsStayDistinctAndCompact(uint256 seed) public {
        _toBonding();
        address[3] memory who = [eoa[0], eoa[1], eoa[3]];
        uint256 burned;
        for (uint256 step; step < 12; ++step) {
            uint256 r = uint256(keccak256(abi.encode(seed, step)));
            address w = who[r % 3];
            uint256 kind = (r >> 8) % 3;
            if (kind == 0) {
                _take(w, 1 + (r >> 16) % 3);
            } else {
                (uint256[] memory ids, uint256 live) = _livePlaceholders();
                if (live == 0) continue;
                uint256 id = ids[(r >> 16) % live];
                address owner = tickets.ownerOf(id);
                if (kind == 1) {
                    vm.prank(owner);
                    tickets.transferFrom(owner, w, id);
                } else {
                    _handBack(owner, _one(id));
                    ++burned;
                }
            }
            _assertSlotsConsistent();
            (, uint256 liveNow) = _livePlaceholders();
            assertEq(uint256(_st().minted) - burned, liveNow, "minted - burned == live");
            assertEq(vault.pendingTickets(), liveNow, "pending tickets == live placeholders (no draws yet)");
        }
        _assertGhostLedger();
    }

    /// @dev Every live placeholder holds a distinct slot below q, and q equals the live count (curve).
    function _assertSlotsConsistent() internal view {
        (uint256[] memory ids, uint256 live) = _livePlaceholders();
        uint256 q = _st().slots;
        assertEq(q, live, "q == live placeholders on the curve");
        bool[] memory seen = new bool[](q);
        for (uint256 i; i < live; ++i) {
            uint256 slot = tickets.slotOf(ids[i]);
            assertLt(slot, q, "slot below q");
            assertFalse(seen[slot], "distinct slots");
            seen[slot] = true;
        }
    }
}

/// The same under Amsterdam (the refund call forwards all gas: the EIP-7702 drawer's and every other refund arrives).
/// forge-config: default.evm_version = "amsterdam"
contract AuditU6FableValueAmsterdamTest is AuditU6FableValueTest {}
