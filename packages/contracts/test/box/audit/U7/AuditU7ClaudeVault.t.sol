// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {ItemReveal} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxCollection} from "../../../../src/box/interfaces/IBoxCollection.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {IBoxToken} from "../../../../src/box/interfaces/IBoxToken.sol";
import {IBoxVault} from "../../../../src/box/interfaces/IBoxVault.sol";
import {TIn, TOut} from "../common/AuditGhostLedger.sol";
import {AuditU7ClaudeBase, AuditU7ClaudeMath} from "./AuditU7ClaudeBase.sol";

/// @notice SH-AUDIT-B0-U7 (Claude), L1 and L7 on the curve (box 0 in its bonding phase, the gate closed): takes lock
/// ⌈A·k/n⌉ plus the 1% draw fee, hand-backs release ⌊A·k/n⌋ less the 5% return fee (BoxVault.sol:24-26, :145-200;
/// BoxSpecV1.sol:61-65; F23 C3), both quoted from the state before the call and never from the vault's balance
/// (BC-006), fees burned (S falls by exactly the fee), VLT-08 after each (BoxVault.sol:42); T cannot be sent to the
/// vault (BoxToken.sol:143; BC-043), so no unsolicited T exists and T balance == E holds exactly.
/// forge-config: default.evm_version = "osaka"
contract AuditU7ClaudeVaultCurveTest is AuditU7ClaudeBase {
    function setUp() public virtual override {
        super.setUp();
        _toBonding();
    }

    /// @notice P7.1, P7.2, P7.12: a take of k placeholders on the curve.
    function testFuzz_AUDIT_U7_takeOnTheCurveQuotesFromThePreState(uint256 k, uint256 seed) public {
        k = bound(k, 1, 12);
        address who = [eoa[0], eoa[1], eoa[3], eoa[4], eoa[5]][seed % 5];
        VaultState memory b = _vaultState();
        uint256 p = (b.a * k + b.n - 1) / b.n;
        uint256 fee = AuditU7ClaudeMath.feeOf(p, DRAW_BPS);
        assertTrue(AuditU7ClaudeMath.isCeil(p, b.a, k, b.n), "independent ceil");
        {
            (uint256 qp, uint256 qf) = vault.quoteTake(k);
            assertEq(qp, p, "quoteTake principal == ceil(A*k/n)");
            assertEq(qf, fee, "quoteTake fee == ceil(p * 1%)");
        }
        uint256 t0 = token.balanceOf(who);
        _take(who, k);
        assertEq(t0 - token.balanceOf(who), p + fee, "the taker paid p + fee");
        _assertMoved(b, int256(p), fee, -int256(k), -int256(k), int256(k));
        _assertVlt08Light("take");
        _assertGhostLedger();
    }

    /// @notice P7.1, P7.2: a hand-back of j of them before graduation, at the current quote less 5%.
    function testFuzz_AUDIT_U7_handBackOnTheCurveFloorLessFivePercent(uint256 k, uint256 j) public {
        k = bound(k, 1, 10);
        j = bound(j, 1, k);
        uint256[] memory ids = new uint256[](j);
        {
            uint256 first = _take(eoa[3], k);
            for (uint256 i; i < j; ++i) {
                ids[i] = first + i;
            }
        }
        _advance(1);
        VaultState memory b = _vaultState();
        uint256 p = b.a * j / b.n;
        uint256 fee = AuditU7ClaudeMath.feeOf(p, RETURN_BPS);
        assertTrue(AuditU7ClaudeMath.isFloor(p, b.a, j, b.n), "independent floor");
        {
            (uint256 qp, uint256 qf) = vault.quoteHandBack(j);
            assertEq(qp, p, "quoteHandBack principal == floor(A*j/n)");
            assertEq(qf, fee, "quoteHandBack fee == ceil(p * 5%) before graduation");
        }
        uint256 t0 = token.balanceOf(eoa[3]);
        {
            (uint256 rp, uint256 rf) = _handBack(eoa[3], ids);
            assertEq(rp, p, "principal");
            assertEq(rf, fee, "fee");
        }
        assertEq(token.balanceOf(eoa[3]) - t0, p - fee, "the holder receives p - fee");
        _assertMoved(b, -int256(p), fee, int256(j), int256(j), -int256(j));
        _assertVlt08Light("hand-back");
        _assertGhostLedger();
    }

    /// @notice P7.2 / BC-043: T sent to the vault by a holder or by an approved spender reverts DirectSendRefused;
    /// the vault's T balance stays E and `unsolicitedToken()` stays 0.
    function testFuzz_AUDIT_U7_directTToTheVaultIsRefused(uint256 amount) public {
        amount = bound(amount, 0, token.balanceOf(eoa[0]));
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxToken.DirectSendRefused.selector, a.vault));
        token.transfer(a.vault, amount);
        vm.prank(eoa[0]);
        token.approve(eoa[1], type(uint256).max);
        vm.prank(eoa[1]);
        vm.expectRevert(abi.encodeWithSelector(IBoxToken.DirectSendRefused.selector, a.vault));
        token.transferFrom(eoa[0], a.vault, amount);
        assertEq(vault.unsolicitedToken(), 0, "no unsolicited T");
        _assertVlt08Light("direct T");
    }

    /// @notice P7.4: on the curve the vault refuses picks and returns (GateClosed) whatever the id.
    function testFuzz_AUDIT_U7_curveRefusesPicksAndReturns(uint256 id) public {
        uint256 deadline = vm.getBlockTimestamp();
        vm.prank(eoa[0]);
        vm.expectRevert(IBoxVault.GateClosed.selector);
        vault.withdraw(id, type(uint256).max, deadline);
        vm.prank(eoa[0]);
        vm.expectRevert(IBoxVault.GateClosed.selector);
        vault.returnItem(id, 0, deadline);
    }

    /// @notice F23 C2 (surplus stays in E): after a take and a hand-back the escrow's surplus over what the outside
    /// slots need, kFloor = E − ⌈m·A/n⌉ (`escrowSurplus`), is defined (E·n ≥ m·A) and equals the recomputed value.
    function testProperty_AUDIT_U7_escrowSurplusIsDefined() public {
        _take(eoa[4], 3);
        uint256[] memory ids = new uint256[](1);
        ids[0] = tickets.status().minted;
        _handBack(eoa[4], ids);
        (uint256 kf, uint256 kr) = vault.escrowSurplus();
        VaultState memory v = _vaultState();
        assertTrue(AuditU7ClaudeMath.productGe(v.e, v.n, v.m, v.a), "E*n >= m*A");
        uint256 need = (v.m * v.a + v.n - 1) / v.n;
        assertEq(kf, v.e - need, "kFloor == E - ceil(m*A/n)");
        uint256 r0 = (v.m * v.a) % v.n;
        assertEq(kr, r0 == 0 ? 0 : v.n - r0, "kRemainder");
    }
}

/// @notice SH-AUDIT-B0-U7 (Claude), L1, L2 and L7 after graduation (box 0 drawing; items A and P1 outside, revealed):
/// returns release ⌊A·k/n⌋ less 5%, named picks lock ⌈A·k/n⌉ plus 25% (BoxVault.sol:226-260, :469-547), only for
/// revealed shelf items (BoxVault.sol:648-667) and only by each id's owner (BoxVault.sol:516-522), the gate opened
/// once by the coordinator at graduation (BoxVault.sol:121-130; F30 Q3), VLT-08 after each step.
/// forge-config: default.evm_version = "osaka"
contract AuditU7ClaudeVaultDrawingTest is AuditU7ClaudeBase {
    function setUp() public virtual override {
        super.setUp();
        _toDrawing();
        _buildTree();
    }

    /// @notice P7.4: the gate opened at graduation, by the coordinator, once: a second openGate (even by the
    /// coordinator) reverts GateAlreadyOpen, and so does waiveHandBackFee (it is only for a closed gate).
    function testProperty_AUDIT_U7_gateOpenedOnceAtGraduation() public {
        assertTrue(vault.gateOpen(), "open");
        assertEq(vault.gateOpenedAt(), coordinator.graduatedAt(), "opened in graduate()");
        vm.prank(a.coordinator);
        vm.expectRevert(IBoxVault.GateAlreadyOpen.selector);
        vault.openGate();
        vm.prank(a.coordinator);
        vm.expectRevert(IBoxVault.GateAlreadyOpen.selector);
        vault.waiveHandBackFee();
        assertFalse(vault.handBackFeeWaived(), "never waived");
    }

    /// @notice P7.1, P7.2, P7.12: the return of item A, then its named pick by another holder, each from the state
    /// before it: return ⌊A/n⌋ less ⌈5%⌉, pick ⌈A/n⌉ plus ⌈25%⌉; the item is back on the shelf in between; A/n
    /// falls at each step (the fees burn), so the later pick costs less than the return paid.
    function testProperty_AUDIT_U7_returnThenPickAtPreStateQuotes() public {
        VaultState memory b = _vaultState();
        uint256 pr = b.a / b.n;
        uint256 fr = AuditU7ClaudeMath.feeOf(pr, RETURN_BPS);
        assertEq(vault.quoteReturn(1), pr, "quoteReturn(1) == floor(A/n)");
        {
            uint256 t3 = token.balanceOf(eoa[3]);
            (uint256 p1, uint256 f1) = _returnItem(eoa[3], itemA);
            assertEq(p1, pr, "return principal");
            assertEq(f1, fr, "return fee 5%");
            assertEq(token.balanceOf(eoa[3]) - t3, pr - fr, "net to the owner");
        }
        _assertMoved(b, -int256(pr), fr, 1, 0, 0);
        assertTrue(vault.isOnShelf(itemA) && collection.ownerOf(itemA) == a.vault, "on the shelf");
        _assertVlt08("after return");

        VaultState memory c = _vaultState();
        uint256 pp = (c.a + c.n - 1) / c.n;
        uint256 fp = AuditU7ClaudeMath.feeOf(pp, PICK_BPS);
        assertEq(vault.quoteWithdraw(1), pp, "quoteWithdraw(1) == ceil(A/n)");
        {
            uint256 t1 = token.balanceOf(eoa[1]);
            (uint256 p2, uint256 f2) = _pick(eoa[1], itemA);
            assertEq(p2, pp, "pick principal");
            assertEq(f2, fp, "pick fee 25%");
            assertEq(t1 - token.balanceOf(eoa[1]), pp + fp, "the picker paid p + fee");
        }
        _assertMoved(c, int256(pp), fp, -1, 0, 0);
        assertEq(collection.ownerOf(itemA), eoa[1], "delivered");
        assertTrue(AuditU7ClaudeMath.productGe(b.a, c.n, c.a, b.n), "A/n never rises (return)");
        _assertVlt08("after pick");
        _assertGhostLedger();
    }

    /// @notice P7.1, P7.2 (draw fee 1%): a draw after graduation locks ⌈A/n⌉ plus ⌈1%⌉ from the state before it, the
    /// fee burned, the ticket counted outside at once (n − 1, h − 1, t + 1; ADR-0014 § G07), no item moving yet.
    function testProperty_AUDIT_U7_drawLocksCeilPlusOnePercent() public {
        _advance(1);
        VaultState memory b = _vaultState();
        uint256 p = (b.a + b.n - 1) / b.n;
        uint256 fee = AuditU7ClaudeMath.feeOf(p, DRAW_BPS);
        uint256 t0 = token.balanceOf(eoa[4]);
        _draw(eoa[4], AUDIT_DRAW_VALUE);
        assertEq(t0 - token.balanceOf(eoa[4]), p + fee, "paid p + fee");
        _assertMoved(b, int256(p), fee, -1, -1, 1);
        assertEq(collection.balanceOf(a.vault), b.vaultItems, "no item moved yet");
        _assertVlt08Light("draw");
        _assertGhostLedger();
    }

    /// @notice P7.1, P7.12: batches: returnItems of two items by one holder, then withdrawBatch of both, ⌊2A/n⌋ and
    /// ⌈2A/n⌉; Σ balances == N with one owner per id afterwards.
    function testProperty_AUDIT_U7_batchesQuoteTheWholeBatch() public {
        vm.prank(eoa[0]);
        collection.transferFrom(eoa[0], eoa[3], itemP1);
        VaultState memory b = _vaultState();
        uint256[] memory ids = _ids2(itemA, itemP1);
        uint256 pr = b.a * 2 / b.n;
        assertEq(vault.quoteReturn(2), pr, "quoteReturn(2)");
        (uint256 p1, uint256 f1) = _returnItems(eoa[3], ids);
        assertEq(p1, pr, "batch return principal");
        assertEq(f1, AuditU7ClaudeMath.feeOf(pr, RETURN_BPS), "batch return fee");
        VaultState memory c = _vaultState();
        uint256 pp = (c.a * 2 + c.n - 1) / c.n;
        assertEq(vault.quoteWithdraw(2), pp, "quoteWithdraw(2)");
        (uint256 p2, uint256 f2) = _pickBatch(eoa[2], ids);
        assertEq(p2, pp, "batch pick principal");
        assertEq(f2, AuditU7ClaudeMath.feeOf(pp, PICK_BPS), "batch pick fee");
        assertEq(collection.ownerOf(itemA), eoa[2], "A to the picker");
        assertEq(collection.ownerOf(itemP1), eoa[2], "P1 to the picker");
        _assertVlt08("batches");
        _assertCollectionConserved(_holders(_noExtra()), "batches");
        _assertGhostLedger();
    }

    /// @notice P7.4: a named pick takes revealed shelf items only: a hidden id reverts HiddenItem, an outside id or
    /// one listed twice IneligibleId, a foreign id IneligibleId, an empty list InvalidQuantity; a return by anyone but
    /// the owner, of an inside id, of a foreign id reverts NotOwner, a repeated id InvalidIdList, an empty list
    /// InvalidIdList.
    function testProperty_AUDIT_U7_picksAndReturnsRefuseWrongIds() public {
        uint256 deadline = vm.getBlockTimestamp();
        _approveT(eoa[1], a.vault);
        uint256 hidden = _firstHidden();
        vm.startPrank(eoa[1]);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.HiddenItem.selector, hidden));
        vault.withdraw(hidden, type(uint256).max, deadline);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.IneligibleId.selector, itemA));
        vault.withdraw(itemA, type(uint256).max, deadline);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.IneligibleId.selector, 0));
        vault.withdraw(0, type(uint256).max, deadline);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.IneligibleId.selector, editionSize + 1));
        vault.withdraw(editionSize + 1, type(uint256).max, deadline);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.InvalidQuantity.selector, 0, vault.inside()));
        vault.withdrawBatch(new uint256[](0), type(uint256).max, deadline);
        vm.stopPrank();
        // Returns.
        vm.prank(eoa[3]);
        collection.setApprovalForAll(a.vault, true);
        vm.prank(eoa[1]);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotOwner.selector, itemA));
        vault.returnItem(itemA, 0, deadline);
        vm.prank(eoa[3]);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotOwner.selector, hidden));
        vault.returnItem(hidden, 0, deadline);
        vm.prank(eoa[3]);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotOwner.selector, editionSize + 7));
        vault.returnItem(editionSize + 7, 0, deadline);
        vm.prank(eoa[3]);
        vm.expectRevert(IBoxVault.InvalidIdList.selector);
        vault.returnItems(_ids2(itemA, itemA), 0, deadline);
        vm.prank(eoa[3]);
        vm.expectRevert(IBoxVault.InvalidIdList.selector);
        vault.returnItems(new uint256[](0), 0, deadline);
        // A pick of a shelf item listed twice: the second sees it outside already.
        _returnItem(eoa[3], itemA);
        vm.prank(eoa[1]);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.IneligibleId.selector, itemA));
        vault.withdrawBatch(_ids2(itemA, itemA), type(uint256).max, deadline);
        _assertVlt08Light("refusals");
    }

    /// @notice P7.4 and the slippage limits: a late deadline (DeadlineExpired), a total above maxTokenIn
    /// (MaxTokenExceeded), a net below minTokenOut (MinTokenNotMet), a balance below the total (InsufficientToken).
    function testProperty_AUDIT_U7_limitsAreHonoured() public {
        uint256 deadline = vm.getBlockTimestamp();
        vm.prank(eoa[3]);
        collection.setApprovalForAll(a.vault, true);
        uint256 pr = vault.quoteReturn(1);
        uint256 net = pr - AuditU7ClaudeMath.feeOf(pr, RETURN_BPS);
        vm.prank(eoa[3]);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.DeadlineExpired.selector, deadline - 1, deadline));
        vault.returnItem(itemA, 0, deadline - 1);
        vm.prank(eoa[3]);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.MinTokenNotMet.selector, net, net + 1));
        vault.returnItem(itemA, net + 1, deadline);
        vm.prank(eoa[3]);
        vault.returnItem(itemA, net, deadline);
        _noteTChange(0, net, TIn.Other, TOut.Return);
        uint256 pp = vault.quoteWithdraw(1);
        uint256 total = pp + AuditU7ClaudeMath.feeOf(pp, PICK_BPS);
        _approveT(eoa[6], a.vault);
        vm.prank(eoa[6]);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.InsufficientToken.selector, 0, total));
        vault.withdraw(itemA, type(uint256).max, deadline);
        _approveT(eoa[1], a.vault);
        vm.prank(eoa[1]);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.MaxTokenExceeded.selector, total, total - 1));
        vault.withdraw(itemA, total - 1, deadline);
        vm.prank(eoa[1]);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.DeadlineExpired.selector, deadline - 1, deadline));
        vault.withdraw(itemA, total, deadline - 1);
        _assertVlt08Light("limits");
    }

    /// @notice P7.4: only the current owner returns: after a transfer the previous owner cannot, the new one can,
    /// even through an operator approval of the vault set by the previous owner.
    function testProperty_AUDIT_U7_theCurrentOwnerHoldsTheReturnRight() public {
        uint256 deadline = vm.getBlockTimestamp();
        vm.prank(eoa[3]);
        collection.setApprovalForAll(a.vault, true);
        vm.prank(eoa[3]);
        collection.transferFrom(eoa[3], eoa[4], itemA);
        vm.prank(eoa[3]);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotOwner.selector, itemA));
        vault.returnItem(itemA, 0, deadline);
        // eoa[4] has not approved the vault: the vault's pull is refused by the collection.
        vm.prank(eoa[4]);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721InsufficientApproval.selector, a.vault, itemA));
        vault.returnItem(itemA, 0, deadline);
        _returnItem(eoa[4], itemA);
        assertEq(collection.ownerOf(itemA), a.vault, "returned by its owner");
        _assertGhostLedger();
    }

    function _firstHidden() internal view returns (uint256 id) {
        for (id = 1; id <= editionSize; ++id) {
            if (vault.isHidden(id)) return id;
        }
        revert("no hidden id");
    }
}

/// @notice SH-AUDIT-B0-U7 (Claude), L1, L2, L7 in terminal mode (TAKE_DELAY passed): takes by number lock ⌈A/n⌉ plus
/// 1% and deliver at once (BoxTickets.sol:362-388 through BoxVault.sol:145-221); an item that left without its reveal
/// comes back only once revealed or after the adapter's `returnableFrom` (BoxVault.sol:34-35, :521, :571-584; F55),
/// and a failed, short or zero `returnableFrom` reads as "not returnable" (pinned, already recorded); a terminal cancel
/// releases ⌊A/n⌋ with no fee (the gate is open, BoxVault.sol:566-569); the box never pays out more for an item than it
/// took (L7, from A/n never rising).
/// forge-config: default.evm_version = "osaka"
contract AuditU7ClaudeVaultTerminalTest is AuditU7ClaudeBase {
    function setUp() public virtual override {
        super.setUp();
        _toTerminal();
        _warpTo(uint256(tickets.status().terminalAt) + tickets.TAKE_DELAY());
        _buildTree();
    }

    /// @notice P7.1, P7.2: a take by number with its reveal: ⌈A/n⌉ plus ⌈1%⌉ from the pre-state, delivered revealed.
    function testFuzz_AUDIT_U7_takeByNumberQuotesFromThePreState(uint256 seed) public {
        VaultState memory b = _vaultState();
        uint256 p = (b.a + b.n - 1) / b.n;
        uint256 fee = AuditU7ClaudeMath.feeOf(p, DRAW_BPS);
        uint256 t0 = token.balanceOf(eoa[2]);
        uint256 item = _takeItem(eoa[2], seed, true);
        VaultState memory c = _vaultState();
        assertEq(t0 - token.balanceOf(eoa[2]), p + fee, "paid p + fee");
        assertEq(c.e, b.e + p, "E + p");
        assertEq(c.s, b.s - fee, "fee burned");
        assertEq(c.n, b.n - 1, "n - 1");
        assertEq(c.h, b.h - 1, "h - 1");
        assertEq(c.t, b.t, "t unchanged (opened and delivered in one call)");
        assertEq(collection.ownerOf(item), eoa[2], "delivered to the taker");
        assertTrue(collection.isRevealed(item), "revealed");
        _assertVlt08Light("take by number");
        _assertGhostLedger();
    }

    /// @notice P7.4 (F55 safety net): an item taken unrevealed cannot be returned until `returnableFrom` (30 days after
    /// it left); then it can, and it sits on the shelf unrevealed: a pick refuses it (NotRevealed) until anyone reveals
    /// it with the committed data, after which it can be picked.
    function testProperty_AUDIT_U7_unrevealedItemReturnsOnlyAfterTheGrace() public {
        uint256 item = _takeItem(eoa[0], 77, false);
        assertFalse(collection.isRevealed(item), "left unrevealed");
        uint256 from = tickets.returnableFrom(item);
        assertEq(from, block.timestamp + tickets.RETURN_GRACE(), "returnable 30 days after it left");
        vm.prank(eoa[0]);
        collection.setApprovalForAll(a.vault, true);
        uint256 deadline = vm.getBlockTimestamp();
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotRevealed.selector, item));
        vault.returnItem(item, 0, deadline);
        _warpTo(from - 1);
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotRevealed.selector, item));
        vault.returnItem(item, 0, block.timestamp);
        _warpTo(from);
        _returnItem(eoa[0], item);
        assertTrue(vault.isOnShelf(item) && !collection.isRevealed(item), "on the shelf, unrevealed");
        _approveT(eoa[1], a.vault);
        vm.prank(eoa[1]);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotRevealed.selector, item));
        vault.withdraw(item, type(uint256).max, block.timestamp);
        ItemReveal memory r = tree.itemReveal(item);
        vm.prank(eoa[5]);
        collection.reveal(item, r.traitsPacked, r.imageHash, r.avatarHash, r.modelHash, r.salt, r.proof);
        _pick(eoa[1], item);
        assertEq(collection.ownerOf(item), eoa[1], "picked once revealed");
        _assertVlt08Light("safety net");
        _assertGhostLedger();
    }

    /// @notice Pinned (already recorded, BoxVault.sol:571-583): a `returnableFrom` that reverts, answers short (16
    /// bytes), answers zero, or answers a time not yet reached reads as "not returnable" (NotRevealed), past the
    /// grace too; the real answer then lets the item back.
    function testProperty_AUDIT_U7_failedReturnableFromReadsAsNo() public {
        uint256 item = _takeItem(eoa[0], 99, false);
        vm.prank(eoa[0]);
        collection.setApprovalForAll(a.vault, true);
        _warpTo(tickets.returnableFrom(item) + 1);
        bytes memory call = abi.encodeCall(IBoxTickets.returnableFrom, (item));
        vm.mockCallRevert(a.tickets, call, "nope");
        _expectNotRevealed(item);
        vm.clearMockedCalls();
        vm.mockCall(a.tickets, call, abi.encodePacked(bytes16(uint128(1))));
        _expectNotRevealed(item);
        vm.clearMockedCalls();
        vm.mockCall(a.tickets, call, abi.encode(uint256(0)));
        _expectNotRevealed(item);
        vm.clearMockedCalls();
        vm.mockCall(a.tickets, call, abi.encode(block.timestamp + 1));
        _expectNotRevealed(item);
        vm.clearMockedCalls();
        _returnItem(eoa[0], item);
        assertEq(collection.ownerOf(item), a.vault, "the real answer lets it back");
    }

    /// @notice P7.1, P7.2: a terminal cancel (draw C) releases ⌊A/n⌋ to the drawer with no fee (gate open, no waiver
    /// needed), E falls by it, S is unchanged, n and h grow by one, t falls by one.
    function testProperty_AUDIT_U7_terminalCancelReleasesFloorWithoutFee() public {
        VaultState memory b = _vaultState();
        uint256 p = b.a / b.n;
        (uint256 qp, uint256 qf) = vault.quoteHandBack(1);
        assertEq(qp, p, "quoteHandBack(1) == floor(A/n)");
        assertEq(qf, 0, "no fee after graduation");
        uint256 principal = _cancelDraw(eoa[5], drawC);
        assertEq(principal, p, "principal");
        VaultState memory c = _vaultState();
        assertEq(c.e, b.e - p, "E - p");
        assertEq(c.s, b.s, "nothing burned");
        assertEq(c.n, b.n + 1, "n + 1");
        assertEq(c.h, b.h + 1, "h + 1");
        assertEq(c.t, b.t - 1, "t - 1");
        assertTrue(AuditU7ClaudeMath.productGe(b.a, c.n, c.a, b.n), "A/n never rises");
        _assertVlt08("cancel");
        _assertGhostLedger();
    }

    /// @notice P7.12 (L7): the box never pays out more for an item than it took. Across a random walk of takes, picks
    /// and returns by several holders, A/n never rises (each step checked), and every return pays at most what the
    /// item's own last exit cost (principal ≤ principal).
    function testFuzz_AUDIT_U7_boxNeverPaysOutMoreThanItTook(uint256 seed) public {
        for (uint256 step; step < 12; ++step) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            VaultState memory b = _vaultState();
            _walkStep(seed);
            VaultState memory c = _vaultState();
            assertTrue(AuditU7ClaudeMath.productGe(b.a, c.n, c.a, b.n), "A/n never rises");
        }
        _assertVlt08Light("walk");
        _assertGhostLedger();
    }

    uint256[] internal walkItems;
    mapping(uint256 => address) internal walkOwner;
    mapping(uint256 => uint256) internal walkPaid;

    function _walkStep(uint256 seed) internal {
        address[4] memory who = [eoa[0], eoa[1], eoa[2], eoa[3]];
        uint256 action = seed % 3;
        if (action == 0 || walkItems.length == 0) {
            address w = who[(seed >> 8) % 4];
            uint256 p = vault.quoteWithdraw(1);
            uint256 item = _takeItem(w, seed >> 16, true);
            walkItems.push(item);
            walkOwner[item] = w;
            walkPaid[item] = p;
            return;
        }
        uint256 id = walkItems[(seed >> 8) % walkItems.length];
        if (walkOwner[id] == address(0)) return;
        (uint256 out,) = _returnItem(walkOwner[id], id);
        assertLe(out, walkPaid[id], "a return pays at most the item's last exit principal");
        if (action == 1) {
            address picker = who[(seed >> 16) % 4];
            uint256 pp = vault.quoteWithdraw(1);
            _pick(picker, id);
            walkOwner[id] = picker;
            walkPaid[id] = pp;
        } else {
            walkOwner[id] = address(0);
        }
    }

    /// @notice P7.1 / BC-006 "quotes from the pre-action state and E, never balanceOf(vault)": with x raw T written
    /// into the vault's balance (a stand-in for unsolicited T, which BoxToken refuses: state injected with `deal`, T's
    /// supply untouched), every quote and the principals of a take, a return and a cancel equal those without it, and
    /// `unsolicitedToken()` reads x throughout.
    function testFuzz_AUDIT_U7_quotesNeverReadTheVaultsBalance(uint256 x) public {
        x = bound(x, 1, 1e26);
        uint256 snap = vm.snapshotState();
        bytes32 clean = _quotesAndActions();
        vm.revertToState(snap);
        deal(a.token, a.vault, token.balanceOf(a.vault) + x);
        assertEq(vault.unsolicitedToken(), x, "unsolicited T visible");
        assertEq(_quotesAndActions(), clean, "the same quotes and principals");
        assertEq(vault.unsolicitedToken(), x, "it stays outside E");
    }

    function _quotesAndActions() internal returns (bytes32) {
        uint256 q1 = vault.quoteWithdraw(3);
        uint256 q2 = vault.quoteReturn(2);
        (uint256 q3, uint256 q4) = vault.quoteTake(1);
        (uint256 q5, uint256 q6) = vault.quoteHandBack(1);
        uint256 item = _takeItem(eoa[2], 31, true);
        (uint256 r1, uint256 r2) = _returnItem(eoa[2], item);
        uint256 c1 = _cancelDraw(eoa[5], drawC);
        return keccak256(abi.encode(q1, q2, q3, q4, q5, q6, r1, r2, c1, vault.escrowPrincipal(), vault.inside()));
    }

    /// @notice L6 / L1 (events): TicketsOpened, Withdrawn, Returned and TicketsReleased carry the principal, the fee
    /// and the counts the call produced: supplyAfter == S, escrowAfter == E, insideAfter == n (hidden and tickets for
    /// the ticket events) right after the call.
    function testProperty_AUDIT_U7_vaultEventsCarryThePostState() public {
        vm.recordLogs();
        uint256 item = _takeItem(eoa[2], 63, true);
        _checkEvent(IBoxVault.TicketsOpened.selector);
        vm.recordLogs();
        _returnItem(eoa[2], item);
        _checkEvent(IBoxVault.Returned.selector);
        vm.recordLogs();
        _pick(eoa[1], item);
        _checkEvent(IBoxVault.Withdrawn.selector);
        vm.recordLogs();
        _cancelDraw(eoa[5], drawC);
        _checkEvent(IBoxVault.TicketsReleased.selector);
    }

    function _checkEvent(bytes32 sig) internal {
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        uint256 found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != a.vault || logs[i].topics[0] != sig) continue;
            ++found;
            VaultState memory v = _vaultState();
            if (sig == IBoxVault.TicketsOpened.selector) {
                (,,, uint256 sAfter, uint256 eAfter, uint256 nAfter, uint256 hAfter, uint256 tAfter) =
                    abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256));
                // The take's delivery follows in the same call: t is back down by the delivered one.
                assertEq(sAfter, v.s, "supplyAfter");
                assertEq(eAfter, v.e, "escrowAfter");
                assertEq(nAfter, v.n, "insideAfter");
                assertEq(hAfter, v.h, "hiddenAfter");
                assertEq(tAfter, v.t + 1, "ticketsAfter (before the same call's delivery)");
            } else if (sig == IBoxVault.TicketsReleased.selector) {
                (,,, uint256 sAfter, uint256 eAfter, uint256 nAfter, uint256 hAfter, uint256 tAfter) =
                    abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256));
                assertEq(sAfter, v.s, "supplyAfter");
                assertEq(eAfter, v.e, "escrowAfter");
                assertEq(nAfter, v.n, "insideAfter");
                assertEq(hAfter, v.h, "hiddenAfter");
                assertEq(tAfter, v.t, "ticketsAfter");
            } else {
                (,,, uint256 sAfter, uint256 eAfter, uint256 nAfter) =
                    abi.decode(logs[i].data, (uint256[], uint256, uint256, uint256, uint256, uint256));
                assertEq(sAfter, v.s, "supplyAfter");
                assertEq(eAfter, v.e, "escrowAfter");
                assertEq(nAfter, v.n, "insideAfter");
            }
        }
        assertEq(found, 1, "one event");
    }

    function _expectNotRevealed(uint256 item) internal {
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotRevealed.selector, item));
        vault.returnItem(item, 0, block.timestamp);
    }
}
