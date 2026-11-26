// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {ItemReveal} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxCollection} from "../../../../src/box/interfaces/IBoxCollection.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {IBoxToken} from "../../../../src/box/interfaces/IBoxToken.sol";
import {IBoxVault} from "../../../../src/box/interfaces/IBoxVault.sol";
import {TIn, TOut} from "../common/AuditGhostLedger.sol";
import {AuditU7FableBase} from "./AuditU7FableBase.sol";

/// @notice SH-AUDIT-B0 U7 (Fable). The vault after graduation on the factory's box 0 with the real stream as observer
/// (L1 P7.1, P7.2; L2 P7.4; L7 P7.12): picks and returns at the formula from the pre-action state, the flat fees
/// burned, VLT-08 after every move, the return rights, the unrevealed safety net, a failed `returnableFrom`, the
/// adapter-only guards and the pick guards. The shelf holds five revealed items (`_stockShelf`); placeholder 5 and
/// draw B stay open for the paths where an item leaves without its reveal.
/// forge-config: default.evm_version = "osaka"
contract AuditU7FableVaultTest is AuditU7FableBase {
    address internal picker;

    function setUp() public override {
        super.setUp();
        _toDrawing();
        _buildTree();
        _stockShelf();
        picker = eoa[4];
        (uint256 p, uint256 f) = _pickQuote(shelf.length);
        _fundT(picker, 2 * (p + f));
    }

    // ============================================================================================ L1 quotes, fees

    /// P7.1, P7.2 (BC-006, `BoxVault.sol:24-26, 469-496, 505-547`; F23 C3): one pick locks ⌈A/n⌉ plus the 25% fee
    /// (burned) computed from the state before the action; the return pays ⌊A/n⌋ less 5% (burned); the real stream
    /// records the owner and the count in step; VLT-08 before and after; the vault approves nobody.
    function testProperty_AUDIT_U7_pickAndReturnQuotesFromPreActionState() public {
        uint256 id = shelf[0];
        (uint256 p, uint256 f) = _pickQuote(1);
        assertEq(vault.quoteWithdraw(1), p, "quoteWithdraw = ceil(A/n)");
        assertEq(f, _ceilFee(p, PICK_BPS));
        uint256 t0 = token.balanceOf(picker);
        uint256 s0 = token.totalSupply();
        uint256 e0 = vault.escrowPrincipal();
        uint256 n0 = vault.inside();
        uint256 b0 = token.totalBurned();
        (uint256 principal, uint256 fee) = _pick(picker, id);
        assertEq(principal, p);
        assertEq(fee, f);
        assertEq(token.balanceOf(picker), t0 - p - f, "the picker paid principal + fee");
        assertEq(token.totalSupply(), s0 - f, "the fee left the supply");
        assertEq(token.totalBurned(), b0 + f, "and is counted burned");
        assertEq(vault.escrowPrincipal(), e0 + p, "E rose by the principal");
        assertEq(token.balanceOf(a.vault), e0 + p, "the vault holds exactly E");
        assertEq(vault.inside(), n0 - 1);
        assertEq(collection.ownerOf(id), picker);
        assertTrue(vault.isOutside(id) && vault.hasLeftVault(id) && !vault.isOnShelf(id));
        (address recorded,) = stream.pendingOf(id);
        assertEq(recorded, picker, "the real stream recorded the picker");
        _assertVlt08("after the pick");

        (uint256 r, uint256 rf) = _returnQuote(1);
        assertEq(vault.quoteReturn(1), r, "quoteReturn = floor(A/n)");
        assertEq(rf, _ceilFee(r, RETURN_BPS));
        assertLe(r, p, "the box never pays out more than it took for the item");
        t0 = token.balanceOf(picker);
        s0 = token.totalSupply();
        e0 = vault.escrowPrincipal();
        b0 = token.totalBurned();
        (principal, fee) = _returnItem(picker, id);
        assertEq(principal, r);
        assertEq(fee, rf);
        assertEq(token.balanceOf(picker), t0 + r - rf, "principal less the fee came back");
        assertEq(token.totalSupply(), s0 - rf);
        assertEq(token.totalBurned(), b0 + rf);
        assertEq(vault.escrowPrincipal(), e0 - r);
        assertEq(vault.inside(), n0);
        assertEq(collection.ownerOf(id), a.vault);
        assertTrue(vault.isOnShelf(id) && vault.hasLeftVault(id) && !vault.isOutside(id));
        (recorded,) = stream.pendingOf(id);
        assertEq(recorded, address(0), "the stream cleared the record on the return");
        _assertVlt08("after the return");
        _assertVaultApprovesNobody();
        _assertGhostLedger();
    }

    /// P7.1, P7.12 (BC-006; `BoxVault.sol:549-559`): after S moves (a holder's burn) a batch pick of k and a return
    /// of j ≤ k pay exactly ⌈A·k/n⌉ + ⌈p/4⌉ and ⌊A·j/n⌋ − ⌈p/20⌉ from the state before each action; VLT-08 after each.
    function testFuzz_AUDIT_U7_picksAndReturnsFollowTheFormula(uint8 kSeed, uint8 jSeed, uint96 burnSeed) public {
        uint256 k = bound(kSeed, 1, shelf.length);
        uint256 j = bound(jSeed, 1, k);
        uint256 burn = bound(uint256(burnSeed), 0, token.balanceOf(eoa[2]) / 4);
        if (burn != 0) _burnT(eoa[2], burn);
        uint256[] memory ids = new uint256[](k);
        for (uint256 i; i < k; ++i) {
            ids[i] = shelf[i];
        }
        (uint256 p, uint256 f) = _pickQuote(k);
        assertEq(vault.quoteWithdraw(k), p);
        (uint256 principal, uint256 fee) = k == 1 ? _pick(picker, ids[0]) : _pickBatch(picker, ids);
        assertEq(principal, p, "pick principal = ceil(A k / n)");
        assertEq(fee, f, "pick fee = ceil(p / 4)");
        _assertVlt08("after picks");
        uint256[] memory back = new uint256[](j);
        for (uint256 i; i < j; ++i) {
            back[i] = ids[i];
        }
        (uint256 r, uint256 rf) = _returnQuote(j);
        assertEq(vault.quoteReturn(j), r);
        (principal, fee) = j == 1 ? _returnItem(picker, back[0]) : _returnItems(picker, back);
        assertEq(principal, r, "return principal = floor(A j / n)");
        assertEq(fee, rf, "return fee = ceil(p / 20)");
        if (j == k) assertLe(r, p, "a full round trip never pays out more than it took");
        _assertVlt08("after returns");
        _assertGhostLedger();
    }

    /// P7.2 (F23 C3 `DECISION-LOG.md:38`; `BoxSpecV1.sol` DRAW/PICK/RETURN_FEE_BPS; `BoxVault.sol:157, 479, 527,
    /// 561-564`): the fees are flat (1%, 25%, 5% of the principal, rounded up) and every unit of fee is burned.
    function testProperty_AUDIT_U7_feesFlatAndBurned() public {
        for (uint256 k = 1; k <= 2; ++k) {
            uint256[] memory ids = new uint256[](k);
            for (uint256 i; i < k; ++i) {
                ids[i] = shelf[i];
            }
            (uint256 p,) = _pickQuote(k);
            uint256 b0 = token.totalBurned();
            (uint256 principal, uint256 fee) = _pickBatch(picker, ids);
            assertEq(principal, p);
            assertEq(fee, FullMath.mulDivRoundingUp(p, 2_500, BPS), "25%");
            assertEq(token.totalBurned(), b0 + fee, "burned");
            (uint256 r,) = _returnQuote(k);
            b0 = token.totalBurned();
            (principal, fee) = _returnItems(picker, ids);
            assertEq(principal, r);
            assertEq(fee, FullMath.mulDivRoundingUp(r, 500, BPS), "5%");
            assertEq(token.totalBurned(), b0 + fee, "burned");
        }
        (uint256 dp, uint256 df) = vault.quoteTake(1);
        (uint256 wp,) = _pickQuote(1);
        assertEq(dp, wp, "a draw locks the pick principal");
        assertEq(df, FullMath.mulDivRoundingUp(dp, 100, BPS), "1%");
        if (token.balanceOf(eoa[5]) < dp + df) _fundT(eoa[5], dp + df);
        uint256 t0 = token.balanceOf(eoa[5]);
        uint256 s0 = token.totalSupply();
        uint256 burned0 = token.totalBurned();
        _draw(eoa[5], AUDIT_DRAW_VALUE);
        assertEq(t0 - token.balanceOf(eoa[5]), dp + df, "the drawer paid principal + 1%");
        assertEq(s0 - token.totalSupply(), df, "the 1% is burned");
        assertEq(token.totalBurned() - burned0, df);
        _assertVlt08("after a draw");
        _assertGhostLedger();
    }

    /// P7.12 (`BoxVault.sol:24-26`; F23 C2 "the escrow must always hold more than enough"): for every shelf item, a
    /// pick followed at once by its return pays out at most what it took; E and the surplus never fall across the pair.
    function testProperty_AUDIT_U7_roundTripNeverPaysOutMoreThanTaken() public {
        for (uint256 i; i < shelf.length; ++i) {
            uint256 e0 = vault.escrowPrincipal();
            (uint256 k0,) = vault.escrowSurplus();
            (uint256 p, uint256 f) = _pick(picker, shelf[i]);
            (uint256 r, uint256 rf) = _returnItem(picker, shelf[i]);
            assertLe(r, p, "payout <= principal taken");
            assertLt(r - rf, p + f, "net payout < net payment");
            assertGe(vault.escrowPrincipal(), e0, "E never falls across a round trip");
            (uint256 k1,) = vault.escrowSurplus();
            assertGe(k1, k0, "the surplus never falls");
            _assertVlt08("round trip");
        }
        _assertGhostLedger();
    }

    /// P7.2, BC-043 (`BoxToken.sol:138-152`; F24 (d)): no T reaches the vault but through its own pull, so
    /// `unsolicitedToken()` is 0 and the T balance is E whatever anyone tries.
    function testProperty_AUDIT_U7_unsolicitedTokenStaysZero() public {
        vm.expectRevert(abi.encodeWithSelector(IBoxToken.DirectSendRefused.selector, a.vault));
        vm.prank(eoa[2]);
        token.transfer(a.vault, 1);
        vm.prank(eoa[2]);
        token.approve(eoa[3], 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxToken.DirectSendRefused.selector, a.vault));
        vm.prank(eoa[3]);
        token.transferFrom(eoa[2], a.vault, 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxToken.DirectSendRefused.selector, a.vault));
        vm.prank(a.tickets);
        token.transfer(a.vault, 0);
        assertEq(vault.unsolicitedToken(), 0);
        assertEq(token.balanceOf(a.vault), vault.escrowPrincipal());
        _assertVlt08("after refused sends");
    }

    // ============================================================================================ L2 rights

    /// P7.4 (VLT-05 `BoxVault.sol:518-521`; `BoxCollection.sol:688-694`): only the current owner returns an item
    /// (an operator or an approved address cannot), the vault must be approved for the pull (an operator approval
    /// or a single-token approval, cleared by the pull), and an id that is not outside is nobody's to return.
    function testProperty_AUDIT_U7_returnRights() public {
        uint256 id = shelf[0];
        uint256 id2 = shelf[1];
        _pick(picker, id);
        _pick(picker, id2);
        uint256 now_ = block.timestamp;
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotOwner.selector, id));
        vm.prank(eoa[5]);
        vault.returnItem(id, 0, now_);
        vm.prank(picker);
        collection.setApprovalForAll(eoa[5], true);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotOwner.selector, id));
        vm.prank(eoa[5]);
        vault.returnItem(id, 0, now_);
        vm.prank(picker);
        collection.approve(eoa[5], id);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotOwner.selector, id));
        vm.prank(eoa[5]);
        vault.returnItem(id, 0, now_);
        // The owner, the vault not approved: the pull is refused by the collection (nothing moved).
        assertFalse(collection.isApprovedForAll(picker, a.vault));
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721InsufficientApproval.selector, a.vault, id));
        vm.prank(picker);
        vault.returnItem(id, 0, now_);
        assertEq(collection.ownerOf(id), picker);
        assertTrue(vault.isOutside(id));
        // A single-token approval to the vault suffices and is cleared by the pull.
        vm.prank(picker);
        collection.approve(a.vault, id);
        (uint256 r,) = _returnQuote(1);
        uint256 t0 = token.balanceOf(picker);
        vm.prank(picker);
        (uint256 principal,) = vault.returnItem(id, 0, now_);
        _noteTChange(t0, token.balanceOf(picker), TIn.Other, TOut.Return);
        assertEq(principal, r);
        assertEq(collection.getApproved(id), address(0), "approval cleared by the pull");
        assertEq(collection.ownerOf(id), a.vault);
        // Ids that are not outside: the shelf one just returned, a hidden one, draw B's reserved item, 0 and N + 1.
        uint256[5] memory notOutside = [id, _hiddenId(), itemB, 0, editionSize + 1];
        for (uint256 i; i < notOutside.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotOwner.selector, notOutside[i]));
            vm.prank(picker);
            vault.returnItem(notOutside[i], 0, now_);
        }
        vm.prank(picker);
        collection.setApprovalForAll(a.vault, true);
        vm.expectRevert(IBoxVault.InvalidIdList.selector);
        vm.prank(picker);
        vault.returnItems(new uint256[](0), 0, now_);
        vm.expectRevert(IBoxVault.InvalidIdList.selector);
        vm.prank(picker);
        vault.returnItems(_ids2(id2, id2), 0, now_);
        (uint256 r2, uint256 rf2) = _returnQuote(1);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.MinTokenNotMet.selector, r2 - rf2, r2 - rf2 + 1));
        vm.prank(picker);
        vault.returnItem(id2, r2 - rf2 + 1, now_);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.DeadlineExpired.selector, now_ - 1, now_));
        vm.prank(picker);
        vault.returnItem(id2, 0, now_ - 1);
        _returnItem(picker, id2);
        _assertVlt08("after the rights checks");
        _assertGhostLedger();
    }

    /// P7.4, P7.5 (F55's safety net, `BoxVault.sol:34-35, 520-521, 571-584`; `BoxTickets.sol:430-433, 690-704`): an
    /// item that left without its reveal returns only once revealed (by anyone) or from the adapter's
    /// `returnableFrom`, exactly at that second; back on the shelf unrevealed it is revealable and, revealed, pickable.
    function testProperty_AUDIT_U7_unrevealedItemReturnsOnlyAfterTheSafetyNet() public {
        uint256 item5 = tickets.numberOf(5);
        uint256 grace = uint256(_status().wordAcceptedAt) + tickets.REVEAL_GRACE();
        uint256 graceB = tickets.drawTicket(drawB).revealFallbackAt;
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.RevealRequired.selector, item5, grace));
        vm.prank(eoa[1]);
        tickets.open(5, _emptyReveal());
        _warpTo(grace > graceB ? grace : graceB);
        vm.prank(eoa[1]);
        assertEq(tickets.open(5, _emptyReveal()), item5, "opened without its reveal after the grace");
        assertEq(collection.ownerOf(item5), eoa[1]);
        assertFalse(collection.isRevealed(item5));
        assertTrue(collection.isRevealable(item5), "it left: revealable by anyone");
        uint256 from = tickets.returnableFrom(item5);
        assertEq(from, vm.getBlockTimestamp() + tickets.RETURN_GRACE(), "30 days after it left");
        vm.prank(eoa[1]);
        collection.setApprovalForAll(a.vault, true);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotRevealed.selector, item5));
        vm.prank(eoa[1]);
        vault.returnItem(item5, 0, vm.getBlockTimestamp());
        vm.warp(from - 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotRevealed.selector, item5));
        vm.prank(eoa[1]);
        vault.returnItem(item5, 0, block.timestamp);
        vm.warp(from);
        (uint256 r, uint256 rf) = _returnQuote(1);
        (uint256 principal, uint256 fee) = _returnItem(eoa[1], item5);
        assertEq(principal, r);
        assertEq(fee, rf);
        assertTrue(vault.isOnShelf(item5) && !collection.isRevealed(item5), "on the shelf, still unrevealed");
        assertTrue(collection.isRevealable(item5));
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotRevealed.selector, item5));
        vm.prank(picker);
        vault.withdraw(item5, type(uint256).max, block.timestamp);
        ItemReveal memory rv = _revealOf(item5);
        vm.prank(eoa[7]);
        collection.reveal(item5, rv.traitsPacked, rv.imageHash, rv.avatarHash, rv.modelHash, rv.salt, rv.proof);
        _pick(picker, item5);
        assertEq(collection.ownerOf(item5), picker);
        // Draw B, opened without its reveal, returns at once if someone reveals it.
        uint256 got = _openDrawEmpty(address(contractDrawer), drawB, address(contractDrawer));
        assertEq(got, itemB);
        assertFalse(collection.isRevealed(itemB));
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotRevealed.selector, itemB));
        vm.prank(address(contractDrawer));
        vault.returnItem(itemB, 0, block.timestamp);
        rv = _revealOf(itemB);
        vm.prank(eoa[7]);
        collection.reveal(itemB, rv.traitsPacked, rv.imageHash, rv.avatarHash, rv.modelHash, rv.salt, rv.proof);
        _returnItem(address(contractDrawer), itemB);
        assertTrue(vault.isOnShelf(itemB));
        _assertVlt08("after the safety-net paths");
        _assertGhostLedger();
    }

    /// P7.4 (`BoxVault.sol:571-584`, the S3 finding's fix pinned): a `returnableFrom` that reverts, answers short or
    /// answers zero reads as "not returnable"; a time not reached reads the same; the time reached allows the return.
    /// The adapter's answers are stood in by `vm.mockCall` on the real adapter's address (stated: a stand-in).
    function testProperty_AUDIT_U7_failedReturnableFromReadsNotReturnable() public {
        uint256 item5 = tickets.numberOf(5);
        _warpTo(uint256(_status().wordAcceptedAt) + tickets.REVEAL_GRACE());
        vm.prank(eoa[1]);
        tickets.open(5, _emptyReveal());
        vm.warp(tickets.returnableFrom(item5));
        vm.prank(eoa[1]);
        collection.setApprovalForAll(a.vault, true);
        bytes memory q = abi.encodeWithSelector(IBoxTickets.returnableFrom.selector, item5);
        bytes memory notRevealed = abi.encodeWithSelector(IBoxVault.NotRevealed.selector, item5);

        vm.mockCallRevert(a.tickets, q, "adapter down");
        vm.expectRevert(notRevealed);
        vm.prank(eoa[1]);
        vault.returnItem(item5, 0, block.timestamp);
        vm.clearMockedCalls();

        vm.mockCall(a.tickets, q, hex"01");
        vm.expectRevert(notRevealed);
        vm.prank(eoa[1]);
        vault.returnItem(item5, 0, block.timestamp);
        vm.clearMockedCalls();

        vm.mockCall(a.tickets, q, abi.encode(uint256(0)));
        vm.expectRevert(notRevealed);
        vm.prank(eoa[1]);
        vault.returnItem(item5, 0, block.timestamp);
        vm.clearMockedCalls();

        vm.mockCall(a.tickets, q, abi.encode(block.timestamp + 1));
        vm.expectRevert(notRevealed);
        vm.prank(eoa[1]);
        vault.returnItem(item5, 0, block.timestamp);
        vm.clearMockedCalls();

        vm.mockCall(a.tickets, q, abi.encode(block.timestamp));
        (uint256 r,) = _returnQuote(1);
        uint256 t0 = token.balanceOf(eoa[1]);
        vm.prank(eoa[1]);
        (uint256 principal,) = vault.returnItem(item5, 0, block.timestamp);
        vm.clearMockedCalls();
        _noteTChange(t0, token.balanceOf(eoa[1]), TIn.Other, TOut.Return);
        assertEq(principal, r);
        assertTrue(vault.isOnShelf(item5));
        _assertVlt08("after the mocked adapter");
        _assertGhostLedger();
    }

    /// P7.4 (`BoxVault.sol:145-221`): the adapter's own calls are checked too (pranked as the adapter, reverts only,
    /// so the adapter and the vault stay in step): a zero recipient, a foreign or non-hidden id, a count of zero or
    /// above the pending tickets, more hidden items than exist; the quote views refuse the same bounds.
    function testProperty_AUDIT_U7_adapterOnlyGuards() public {
        uint256 n = vault.inside();
        uint256 h = vault.hiddenCount();
        uint256 t = vault.pendingTickets();
        uint256 m = vault.outside();
        assertEq(t, 2);
        uint256 hid = _hiddenId();
        vm.expectRevert(IBoxVault.ZeroAddress.selector);
        vm.prank(a.tickets);
        vault.deliverTicket(hid, address(0));
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.IneligibleId.selector, 0));
        vm.prank(a.tickets);
        vault.deliverTicket(0, eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.IneligibleId.selector, editionSize + 1));
        vm.prank(a.tickets);
        vault.deliverTicket(editionSize + 1, eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotHidden.selector, shelf[0]));
        vm.prank(a.tickets);
        vault.deliverTicket(shelf[0], eoa[0]);
        _pick(picker, shelf[1]);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotHidden.selector, shelf[1]));
        vm.prank(a.tickets);
        vault.deliverTicket(shelf[1], eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.InvalidQuantity.selector, 0, t));
        vm.prank(a.tickets);
        vault.releaseTickets(0, eoa[0], 0);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.InvalidQuantity.selector, t + 1, t));
        vm.prank(a.tickets);
        vault.releaseTickets(t + 1, eoa[0], 0);
        vm.expectRevert(IBoxVault.ZeroAddress.selector);
        vm.prank(a.tickets);
        vault.releaseTickets(1, address(0), 0);
        n = vault.inside(); // one pick happened above
        m = vault.outside();
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.InvalidQuantity.selector, 0, n));
        vm.prank(a.tickets);
        vault.openTickets(0, type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NoHiddenItem.selector, h + 1, h));
        vm.prank(a.tickets);
        vault.openTickets(h + 1, type(uint256).max);
        // The quote views, from anyone: k = n is the last item (BC-007), k > n or k = 0 an invalid quantity.
        vm.expectRevert(IBoxVault.LastItem.selector);
        vault.quoteWithdraw(n);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.InvalidQuantity.selector, n + 1, n));
        vault.quoteWithdraw(n + 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.InvalidQuantity.selector, 0, n));
        vault.quoteWithdraw(0);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.InvalidQuantity.selector, 0, m));
        vault.quoteReturn(0);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.InvalidQuantity.selector, m + 1, m));
        vault.quoteReturn(m + 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NoHiddenItem.selector, h + 1, h));
        vault.quoteTake(h + 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.InvalidQuantity.selector, 0, t));
        vault.quoteHandBack(0);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.InvalidQuantity.selector, t + 1, t));
        vault.quoteHandBack(t + 1);
        _assertVlt08("after the guards");
    }

    /// P7.4, P7.8 (`BoxVault.sol:474-480, 499-503, 648-667`): a named pick refuses a hidden id, an outside id, a
    /// foreign id, a repeated id, a total above `maxTokenIn`, a passed deadline and a payer without the T, each
    /// with its named error and before anything moves.
    function testProperty_AUDIT_U7_pickGuards() public {
        uint256 now_ = block.timestamp;
        uint256 hidden = _hiddenId();
        (uint256 p, uint256 f) = _pickQuote(1);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.HiddenItem.selector, hidden));
        vm.prank(picker);
        vault.withdraw(hidden, type(uint256).max, now_);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.HiddenItem.selector, itemB));
        vm.prank(picker);
        vault.withdraw(itemB, type(uint256).max, now_);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.IneligibleId.selector, 0));
        vm.prank(picker);
        vault.withdraw(0, type(uint256).max, now_);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.IneligibleId.selector, editionSize + 1));
        vm.prank(picker);
        vault.withdraw(editionSize + 1, type(uint256).max, now_);
        (uint256 p2, uint256 f2) = _pickQuote(2);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.IneligibleId.selector, shelf[0]));
        vm.prank(picker);
        vault.withdrawBatch(_ids2(shelf[0], shelf[0]), type(uint256).max, now_);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.MaxTokenExceeded.selector, p2 + f2, p2 + f2 - 1));
        vm.prank(picker);
        vault.withdrawBatch(_ids2(shelf[0], shelf[1]), p2 + f2 - 1, now_);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.DeadlineExpired.selector, now_ - 1, now_));
        vm.prank(picker);
        vault.withdraw(shelf[0], type(uint256).max, now_ - 1);
        uint256 poor = token.balanceOf(eoa[7]);
        assertLt(poor, p + f, "eoa[7] cannot pay a pick");
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.InsufficientToken.selector, poor, p + f));
        vm.prank(eoa[7]);
        vault.withdraw(shelf[0], type(uint256).max, now_);
        _pick(picker, shelf[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.IneligibleId.selector, shelf[0]));
        vm.prank(picker);
        vault.withdraw(shelf[0], type(uint256).max, now_);
        assertEq(vault.inside(), editionSize - 3, "one pick happened; nothing else moved");
        _assertVlt08("after the pick guards");
    }

    // ============================================================================================ helpers

    /// @dev An id that never left (hidden): not a shelf item, not A, P1, the placeholders' items or B.
    function _hiddenId() internal view returns (uint256 id) {
        for (id = 1; id <= editionSize; ++id) {
            if (vault.isHidden(id) && id != itemB) return id;
        }
        revert("no hidden id");
    }

    function _openDrawEmpty(address who, uint256 ticketId, address to) internal returns (uint256 item) {
        vm.prank(who);
        item = tickets.openDraw(ticketId, to, _emptyReveal());
    }
}
