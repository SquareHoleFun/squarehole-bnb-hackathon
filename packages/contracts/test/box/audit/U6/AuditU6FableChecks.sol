// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/console.sol";
import {DrawStatus} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {AuditU6FableCampaign} from "./AuditU6FableHandler.sol";

/// @notice SH-AUDIT-B0 U6 (Fable): the campaign's three checks (the invariants of `AuditU6FableInvariants.t.sol` and
/// the per-step checks of the coverage walks), on the handler's ghosts and box 0's live state.
abstract contract AuditU6FableChecks is AuditU6FableCampaign {
    // ================================================================================================ invariants

    /// X04 / IBoxTickets.sol:27-29: minted − burned == live placeholders == Σ balances; every live placeholder in a
    /// distinct slot below q (q == live on the curve); the vault's pending tickets == live + open draws; the vault
    /// holds n + t items; nothing stays in the tickets contract.
    function _checkPlaceholdersAndPendingTickets() internal view {
        IBoxTickets.TicketState memory s = _st();
        (uint256[] memory ids, uint256 live) = _livePlaceholders();
        assertEq(uint256(s.minted) - burned, live, "minted - burned == live");
        uint256 balances;
        for (uint256 i; i < ACTORS; ++i) {
            balances += tickets.balanceOf(actors[i]);
        }
        assertEq(balances, live, "sum of balances == live");
        uint256 q = s.slots;
        if (vault.gateOpenedAt() == 0) assertEq(q, live, "on the curve q == live");
        bool[] memory seen = new bool[](q);
        for (uint256 i; i < live; ++i) {
            uint256 slot = tickets.slotOf(ids[i]);
            assertLt(slot, q, "slot below q");
            assertFalse(seen[slot], "distinct slots");
            seen[slot] = true;
        }
        uint256 openDraws = uint256(s.drawsRequested) - drawsOpened - drawsCancelled;
        assertEq(vault.pendingTickets(), live + openDraws, "pending tickets == live placeholders + open draws");
        assertEq(collection.balanceOf(a.vault), vault.inside() + vault.pendingTickets(), "the vault holds n + t");
        assertEq(token.balanceOf(a.tickets), 0, "no T stays");
        assertEq(a.tickets.balance, 0, "no ETH stays");
    }

    /// ADR-0013 § 3.3 rule 2, § 9 rows 9/17; BoxTickets.sol:34-35: draws settle strictly in request order (ids up to
    /// drawsSettled are Settled or Opened, later ones Requested or Cancelled, cancels only in terminal mode); a settled
    /// draw's item and word never change; items are distinct, never a live placeholder's number, hidden in the vault
    /// until opened, and no item is delivered twice.
    function _checkDrawOrderAndItems() internal {
        IBoxTickets.TicketState memory s = _st();
        assertGe(s.drawsSettled, lastSettled, "drawsSettled never falls");
        lastSettled = s.drawsSettled;
        assertLe(s.drawsSettled, s.drawsRequested);
        assertEq(settledOutOfOrder, 0, "settled in order");
        assertEq(cancelledOutsideTerminal, 0, "cancels only in terminal mode");
        assertEq(itemChanged, 0);
        assertEq(wordChanged, 0);
        assertEq(doubleDelivery, 0, "no item delivered twice");
        uint256[] memory items = new uint256[](s.drawsSettled);
        for (uint256 id = 1; id <= s.drawsRequested; ++id) {
            IBoxTickets.DrawView memory d = _dv(id);
            if (id <= s.drawsSettled) {
                assertTrue(d.status == DrawStatus.Settled || d.status == DrawStatus.Opened, "settled ids");
                if (itemOfDraw[id] != 0 && itemOfDraw[id] != d.itemId) ++itemChanged;
                (bytes32 word,) = src.wordOf(a.tickets, id);
                if (wordOfDraw[id] != bytes32(0) && wordOfDraw[id] != word) ++wordChanged;
                _assertBackupWordIfFixed(id, word);
                items[id - 1] = d.itemId;
                for (uint256 k; k + 1 < id; ++k) {
                    assertTrue(items[k] != d.itemId, "distinct items");
                }
                if (d.status == DrawStatus.Settled) {
                    assertEq(collection.ownerOf(d.itemId), a.vault, "hidden until opened");
                    assertTrue(vault.isHidden(d.itemId));
                }
            } else {
                assertTrue(d.status == DrawStatus.Requested || d.status == DrawStatus.Cancelled, "unsettled ids");
                if (d.status == DrawStatus.Cancelled) assertTrue(s.terminalAt != 0);
            }
        }
        if (s.wordAcceptedAt != 0) {
            (uint256[] memory ids, uint256 live) = _livePlaceholders();
            for (uint256 i; i < live; ++i) {
                uint256 number = tickets.numberOf(ids[i]);
                assertEq(collection.ownerOf(number), a.vault, "a placeholder's item waits in the vault");
                for (uint256 k; k < s.drawsSettled; ++k) {
                    assertTrue(items[k] != number, "never a placeholder's number");
                }
                for (uint256 j; j < i; ++j) {
                    assertTrue(tickets.numberOf(ids[j]) != number, "distinct numbers");
                }
            }
        }
        assertEq(itemChanged, 0, "a settled draw's item never changes");
        assertEq(wordChanged, 0, "a settled draw's word never changes");
    }

    /// @dev Once a backup was fixed for the draw's round, its word is the backup's (a drand post is ignored).
    function _assertBackupWordIfFixed(uint256 id, bytes32 word) internal view {
        uint256 round = _roundOf(id);
        (uint64 startedAt,, uint64 fixedAt, bytes32 mix) = src.backupOf(round);
        if (startedAt == 0) return;
        if (fixedAt == 0) return;
        assertEq(word, _word(src.BACKUP_TAG(), mix, id), "a backed round's word is the backup's");
    }

    /// X01/X02 at the boundary (the ghost ledger), VLT-08 (the vault's solvency), and the rule ghosts: terminal entry
    /// exactly when the reference head rule says dead, QueueDead exactly then, operator moves exactly per the era
    /// rule.
    function _checkLedgerAndRules() internal view {
        _assertGhostLedger();
        uint256 e = vault.escrowPrincipal();
        uint256 n = vault.inside();
        assertEq(token.balanceOf(a.vault), e, "T balance == E");
        assertGe(n, 1, "n >= 1");
        assertGe(e * n, vault.outside() * (token.totalSupply() - e), "E n >= m A");
        assertEq(badTerminal, 0, "terminal entry only by the head rule");
        assertEq(badDrawGate, 0, "QueueDead exactly when the head is dead");
        assertEq(badOperatorMove, 0, "operator moves follow the era rule");
    }

    /// @notice Every check at once, as an external call (its own memory frame; the coverage walk calls it).
    function check_AUDIT_U6_all() external {
        _checkPlaceholdersAndPendingTickets();
        _checkDrawOrderAndItems();
        _checkLedgerAndRules();
    }

    function afterInvariant() external view {
        console.log("calls", calls, "takes", okTakes);
        console.log("hand-backs", okHandBacks, "transfers", okTransfers);
        console.log("operator moves", okOperatorMoves, "close", okClose);
        console.log("graduate", okGraduate, "request word", okRequestWord);
        console.log("accept word", okAcceptWord, "draws", okDraws);
        console.log("refused draws", refusedDraws, "settles", okSettles);
        console.log("settled draws", settledDraws, "opens", okOpens);
        console.log("draw opens", okOpenDraws, "terminal", okTerminal);
        console.log("cancels", okCancels, "takes by number", okTakesByNumber);
        console.log("posts", okPosts, "backup starts", okStarts);
        console.log("backup fixes", okFixes, "bounties", okBounties);
        console.log("withdrawals", okWithdrawals, "buys", okBuys);
        console.log("warps", warps);
    }
}
