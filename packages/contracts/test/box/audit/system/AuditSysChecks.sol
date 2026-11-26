// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/console.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {DrawStatus, ItemReveal} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {AuditSysActions} from "./AuditSysActions.sol";
import {Exc} from "./AuditSysWorld.sol";

/// @title AuditSysChecks
/// @notice TEST ONLY (SH-AUDIT-B0 round 2). Plan § 3.1's system invariants X01-X20, all of them after every call (forge's
/// `check_interval = 1`), and the closing driver (`afterInvariant`) that drives each run to its end and asserts X06, X12
/// and X21. Forge 1.8.3 keeps no storage write an invariant function makes (measured: a counter incremented in an
/// invariant reads 0 in the next call), so every comparison with the state before a call (supply never rises, phases
/// never go back, words never change, positions never shrink, J and X never fall, the reserve never falls) runs in the
/// action frame right after each action (`_afterAction`), where its ghosts persist; the invariants check the state
/// itself. Accepted findings are named exceptions (`Exc`), counted and sized, never failures.
abstract contract AuditSysChecks is AuditSysActions {
    uint256 internal safe0;

    // ================================================================================================ after each action

    function _initGhosts() internal override {
        gLiq = _liquidities();
    }

    function _liquidities() internal view returns (uint128[5] memory l) {
        (int24 lo, int24 hi,) = hook.curve();
        l[0] = _posLiq(lo, hi, bytes32(0));
        (l[1], l[2], l[3]) = hook.graduatedLayout();
        l[4] = hook.pairedLiquidity();
    }

    /// @dev The cross-call properties, compared with the state the last action left (state changes only in actions):
    /// X02 supply never rises; X05 the phase never goes back and the curve closes once; X06 graduatedAt never moves;
    /// X09 the reserve minted never falls; X10 J, X, claimed and burned never fall; X16 no position shrinks but the
    /// curve's one removal at migration; X11 every word, once non-zero, never changes. W1-U4-3's next batch observed.
    function _afterAction(uint256 wrote) internal override {
        uint256 s = token.totalSupply();
        if (s > gSupply) _violation("X02: T supply rose");
        gSupply = s;
        uint256 p = uint256(hook.phase());
        if (p < gPhase) _violation("X05: the phase went back");
        gPhase = p;
        uint256 c = hook.closedAtBlock();
        if (gClosedAtBlock != 0 && c != gClosedAtBlock) _violation("X05: closedAtBlock moved (closed twice)");
        gClosedAtBlock = c;
        uint256 g = coordinator.graduatedAt();
        if (gGraduatedAt != 0 && g != gGraduatedAt) _violation("X06: graduatedAt moved");
        gGraduatedAt = g;
        uint256 m = hook.reserveMinted();
        if (m < gReserveMinted) _violation("X09: the reserve minted fell");
        gReserveMinted = m;
        _afterStream();
        if (wrote & (W_PM | W_HOOK) != 0) _afterPositions();
        if (wrote & (W_SRC | W_DRAND) != 0) _afterWords();
        (uint256 qb, uint256 tb) = receiver.booked();
        uint256 heldQ = pm.balanceOf(a.receiver, 0);
        uint256 heldT = pm.balanceOf(a.receiver, uint256(uint160(a.token)));
        // Counted after every action that leaves a next batch (Q or T) held above the ledgers; sized in Q (wei) only,
        // as a T next batch is in raw T units and the two do not add.
        if (heldQ > qb || heldT > tb) _exc(Exc.W1_U4_3, heldQ > qb ? heldQ - qb : 0);
    }

    function _afterStream() internal {
        uint256 j = stream.index();
        uint256 x = stream.streamValue();
        (uint256 claimed, uint256 burned) = stream.totals();
        if (j < gStreamIndex) _violation("X10: J fell");
        if (x < gStreamValue) _violation("X10: X fell");
        if (claimed < gStreamClaimed || burned < gStreamBurned) _violation("X10: a lifetime total fell");
        (gStreamIndex, gStreamValue, gStreamClaimed, gStreamBurned) = (j, x, claimed, burned);
    }

    function _afterPositions() internal {
        uint128[5] memory l = _liquidities();
        bool migrated = hook.migratedAtBlock() != 0;
        if (!migrated && l[0] < gLiq[0]) _violation("X16: the curve shrank before migration");
        for (uint256 i = 1; i < 5; ++i) {
            if (l[i] < gLiq[i]) _violation("X16: a graduated position or the pair shrank");
        }
        gLiq = l;
    }

    /// @dev X11: a word can change only with a write to a source's storage, so this runs after every action that
    /// wrote one (the write recorder's bits; X17 holds every action to its surface).
    function _afterWords() internal {
        uint256 requested = tickets.status().drawsRequested;
        for (uint256 k; k <= requested; ++k) {
            (bytes32 w,) = src.wordOf(a.tickets, k);
            bytes32 seen = gWord[k];
            if (seen != bytes32(0)) {
                if (w != seen) _violation("X11: a word changed once non-zero");
            } else if (w != bytes32(0)) {
                gWord[k] = w;
            }
        }
    }

    // ================================================================================================ X01-X20

    /// X01: ETH conservation at the boundary (the ghost ledger) and in each place: ETH where only forcing can put it
    /// equals what was forced; the launch router holds tax and forced ETH less what it swept; the executor's budget is
    /// what was funded less what it spent plus forced; the DrandSource holds its pots and credits plus forced ETH
    /// (`IDrandSource.sol:23-25`); the Safe holds what payPlatform paid it.
    function _checkX01_ethConservation() internal view {
        _assertGhostLedger();
        address[11] memory noIntake = [
            a.coordinator,
            a.hook,
            a.tickets,
            a.vault,
            a.collection,
            a.itemStream,
            a.table,
            a.token,
            address(src),
            address(factory),
            address(factory.registry())
        ];
        for (uint256 i; i < 11; ++i) {
            assertEq(noIntake[i].balance, gForced[noIntake[i]], "X01: ETH at a no-intake address is only forced ETH");
        }
        assertEq(a.receiver.balance, gForced[a.receiver], "X01: the receiver holds only unswept forced ETH");
        assertEq(
            a.launchRouter.balance + launchRouter.totalSwept(),
            launchRouter.totalTaxCollected() + gForcedTotal[a.launchRouter],
            "X01: router ETH + swept == tax + forced (BC-022)"
        );
        assertEq(
            a.executor.balance + executor.totalEthSpent(),
            executor.totalToBudget() + gForcedTotal[a.executor],
            "X01: executor budget == funded - spent + forced (BC-108)"
        );
        uint256 pots;
        for (uint256 i; i < gRounds.length; ++i) {
            pots += drand.bountyOf(gRounds[i]);
        }
        assertEq(
            address(drand).balance,
            pots + drand.owedTo(poster) + gForcedTotal[address(drand)],
            "X01: DrandSource ETH == pots + credits + forced"
        );
        assertEq(safe.balance, safe0 + gSafePaid, "X01/BC-141: the Safe's ETH rises only by payPlatform");
    }

    /// X02: T supply (supply + burned == 1e27 is in the ledger; "never rises" in `_afterAction`): never below E + n; T
    /// at each system address is what its rule allows (the hook, routers, tickets and others hold only T sent to them
    /// directly: M01, M02, M25; the receiver its pending burn plus M01; the vault E; the coordinator after graduation
    /// only M25).
    function _checkX02_tSupply() internal view {
        assertGe(token.totalSupply(), vault.supplyFloor(), "X02: supply below the floor E + n");
        address[10] memory direct = [
            a.hook,
            a.launchRouter,
            a.tickets,
            a.collection,
            a.table,
            address(drand),
            address(src),
            address(factory),
            address(factory.registry()),
            a.royaltyRouter
        ];
        for (uint256 i; i < 10; ++i) {
            assertEq(token.balanceOf(direct[i]), gDirectT[direct[i]], "X02: T at a box address is only T sent to it");
        }
        assertEq(
            token.balanceOf(a.receiver),
            receiver.tBurnPending() + gDirectT[a.receiver],
            "X02: receiver T == pending + M01"
        );
        assertEq(token.balanceOf(a.vault), vault.escrowPrincipal(), "X02/X15: vault T == E");
        assertEq(token.balanceOf(a.token), 0, "X02: T holds none of itself");
        if (_graduated()) {
            assertEq(
                token.balanceOf(a.coordinator), gDirectT[a.coordinator], "X02: coordinator T after graduation (M25)"
            );
        }
    }

    /// X03: items: Σ balances == N over every known holder, the vault holds n + t, an id is in the vault again only by
    /// a return, a delivered or picked id is never hidden again (X19). The full per-id walk runs in the closing (X21).
    function _checkX03_items() internal view {
        uint256 sum = collection.balanceOf(a.vault);
        assertEq(sum, vault.inside() + vault.pendingTickets(), "X03: the vault holds n + t");
        for (uint256 i; i < 8; ++i) {
            sum += collection.balanceOf(eoa[i]);
        }
        for (uint256 i = 6; i < traders.length; ++i) {
            sum += collection.balanceOf(traders[i]);
        }
        address[9] memory boxes = [
            a.itemStream,
            a.receiver,
            a.coordinator,
            a.hook,
            a.executor,
            a.launchRouter,
            a.tickets,
            a.royaltyRouter,
            a.table
        ];
        for (uint256 i; i < 9; ++i) {
            sum += collection.balanceOf(boxes[i]);
        }
        assertEq(sum, editionSize, "X03: sum of balances over the known holders == N");
        assertEq(collection.totalSupply(), editionSize, "X03: totalSupply == N");
        for (uint256 i; i < gLeft.length; ++i) {
            uint256 id = gLeft[i];
            address owner = collection.ownerOf(id);
            assertTrue(vault.hasLeftVault(id), "X03: a moved id has left the vault");
            assertFalse(vault.isHidden(id), "X19: a delivered or picked id is never hidden again");
            if (owner == a.vault) {
                assertTrue(gReturned[id], "X03: an id back in the vault came by a return");
                assertTrue(vault.isOnShelf(id), "X03: a returned id is on the shelf");
            } else {
                assertTrue(vault.isOutside(id), "X03: an id outside the vault counts as outside");
            }
        }
    }

    /// X04: tickets: pending == live placeholders + open draws, distinct slots below q, minted - burned == live, a
    /// number to at most one placeholder or draw and every reserved item hidden (`IBoxTickets.sol:27-29`).
    function _checkX04_tickets() internal view {
        _assertSlotsAndTickets();
        (uint256[] memory ids,) = _livePlaceholders();
        IBoxTickets.TicketState memory s = tickets.status();
        assertEq(uint256(s.minted) - gBurnedPlaceholders, ids.length, "X04: minted - burned == live placeholders");
        uint256 settled = s.drawsSettled;
        uint256[] memory items = new uint256[](ids.length + settled);
        uint256 m;
        if (s.wordAcceptedAt != 0) {
            for (uint256 i; i < ids.length; ++i) {
                items[m++] = tickets.numberOf(ids[i]);
            }
        }
        for (uint256 k = 1; k <= settled; ++k) {
            IBoxTickets.DrawView memory d = tickets.drawTicket(k);
            if (d.status == DrawStatus.Settled) items[m++] = d.itemId;
        }
        for (uint256 i; i < m; ++i) {
            assertTrue(vault.isHidden(items[i]), "X04: a reserved item waits hidden in the vault");
            for (uint256 j; j < i; ++j) {
                assertTrue(items[i] != items[j], "X04: one number, one ticket");
            }
        }
        assertEq(token.balanceOf(a.tickets), gDirectT[a.tickets], "P6.1: no T stays in the tickets contract (but M25)");
    }

    /// X05: hook, router and tickets agree on openAt; the coordinator reports the hook's phase; closed() iff
    /// closedAtBlock is set ("never goes back" and "closes once" in `_afterAction`).
    function _checkX05_phases() internal view {
        uint256 p = uint256(hook.phase());
        assertEq(uint256(coordinator.phase()), p, "X05: the coordinator reports the hook's phase");
        uint256 openAt = hook.openAt();
        assertEq(launchRouter.openAt(), openAt, "X05: router openAt == hook openAt (AR-15)");
        assertEq(tickets.openAt(), openAt, "X05: tickets openAt == hook openAt (AR-15)");
        assertEq(hook.closed(), hook.closedAtBlock() != 0, "X05: closed() == closedAtBlock set");
    }

    /// X06 (each call): all of graduation's effects together: graduated iff the hook migrated iff the vault gate is
    /// open, and only after the close ("at most once" in `_afterAction` and the action's own oracle).
    function _checkX06_graduationOnce() internal view {
        bool grad = coordinator.graduatedAt() != 0;
        assertEq(hook.migratedAtBlock() != 0, grad, "X06: migrated iff graduated");
        assertEq(vault.gateOpenedAt() != 0, grad, "X06: the gate is open iff graduated");
        if (grad) assertTrue(hook.closed(), "X06: graduated only after the close");
    }

    /// X07: the cap (BC-106, BC-141): credits in the current epoch <= 32 ETH; credits and Safe receipts by the end of
    /// epoch k <= (k + 1) x 32 ETH (the accepted reading of W1-U4-2: one payout may carry earlier epochs' credits).
    function _checkX07_platformCap() internal view {
        uint256 cap = BoxSpecV1.PLATFORM_CAP_WEI;
        (uint256 epoch, uint256 kept, uint256 remaining) = receiver.platformEpoch();
        assertLe(kept, cap, "X07: credited above the cap in one epoch");
        assertEq(kept + remaining, cap, "X07: kept + remaining == cap");
        (, uint256 toPlatform,,,,,) = receiver.totals();
        assertLe(toPlatform, (epoch + 1) * cap, "X07: credits by the end of epoch k <= (k + 1) x cap");
        assertLe(gSafePaid, toPlatform, "X07: the Safe received only what was credited");
        if (!_graduated()) {
            assertEq(receiver.platformOwed(), 0, "X07: nothing owed to the Safe before graduation");
            assertEq(gSafePaid, 0, "X07: nothing paid to the Safe before graduation");
        }
    }

    /// X08: before graduation nothing reaches the executor from the receiver, the executor buys nothing, the gate is
    /// closed and the stream accrues nothing (BC-020, F30 Q3).
    function _checkX08_beforeGraduation() internal view {
        if (_graduated()) return;
        assertEq(executor.totalEthSpent(), 0, "X08: the executor bought before graduation");
        assertEq(executor.totalToBudget(), gOutsideBudget, "X08: the executor got ETH from the receiver");
        assertEq(vault.gateOpenedAt(), 0, "X08: the gate opened before graduation");
        assertEq(stream.index(), 0, "X08: the stream accrued before graduation");
        assertFalse(stream.started(), "X08: the stream started before graduation");
    }

    /// X09: claims match ledgers: receiver claims >= sum of ledgers, the rest the next batch (W1-U4-3's accepted form,
    /// counted in `_afterAction`), carries below one fifteenth; the hook's claims are its depth budget and its reserve
    /// within its cap; the coordinator holds the reserve (and stranger gifts) before graduation, the unclaimed reward
    /// (and gifts) after.
    function _checkX09_claimsMatchLedgers() internal view {
        (uint256 qb, uint256 tb) = receiver.booked();
        assertGe(pm.balanceOf(a.receiver, 0), qb, "X09: receiver Q claims >= its ledgers");
        assertGe(pm.balanceOf(a.receiver, uint256(uint160(a.token))), tb, "X09: receiver T claims >= its ledgers");
        (uint256 qCarry, uint256 tCarry) = receiver.carried();
        assertLt(qCarry, 15, "X09: Q carry below one fifteenth");
        assertLt(tCarry, 15, "X09: T carry below one fifteenth");
        (uint256 hq, uint256 ht) = hook.depthBudget();
        assertEq(hq, pm.balanceOf(a.hook, 0), "X09: hook Q depth budget == its claims");
        assertEq(ht, pm.balanceOf(a.hook, uint256(uint160(a.token))), "X09: hook T depth budget == its claims");
        uint256 minted = hook.reserveMinted();
        assertLe(minted, hook.reserveCap(), "X09: reserve minted within its cap");
        uint256 cq = pm.balanceOf(a.coordinator, 0);
        if (!_graduated()) {
            assertEq(cq, minted + gCoordGiftPre, "X09: coordinator claims == reserve minted + gifts before graduation");
        } else {
            uint256 unclaimed = gRewardClaimed ? 0 : gReward;
            assertEq(cq, unclaimed + gClaimGift[a.coordinator], "X09: coordinator claims == unclaimed reward + gifts");
        }
    }

    /// X10: the stream ("never falls" in `_afterAction`): J = floor((X - X0) / N) once started; after a valid collect
    /// (in a snapshot) its T covers every owner's accrual to within N - 1 raw units (W2-U5-1's accepted bound).
    function _checkX10_stream() internal {
        if (!stream.started()) return;
        assertEq(stream.index(), (stream.streamValue() - stream.startValue()) / editionSize, "X10: J == (X - X0) / N");
        uint256 snap = vm.snapshotState();
        vm.deal(address(this), address(this).balance + 0.01 ether);
        gifter.giftEth{value: 0.01 ether}(a.receiver);
        receiver.collect(keeper);
        uint256 held = token.balanceOf(a.itemStream);
        uint256 owed = stream.liabilities();
        vm.revertToState(snap);
        if (owed > held) {
            assertLe(owed - held, editionSize - 1, "X10: owners uncovered beyond W2-U5-1's N - 1 raw units");
            // An invariant's writes are not kept: the observation goes to the process environment (replays included).
            _sum("W2U5_obs", 1);
            _max("W2U5_max", owed - held);
        }
    }

    /// X11: the stored graduation word and every settled draw's word come from their round's rule (a started backup's
    /// round ignores drand, F143); "never changes once non-zero" for every key in `_afterAction`.
    function _checkX11_words() internal view {
        IBoxTickets.TicketState memory s = tickets.status();
        if (s.wordAcceptedAt != 0) {
            assertEq(tickets.graduationWord(), _expectedWord(0), "X11: the graduation word's rule");
        }
        for (uint256 k = 1; k <= s.drawsSettled; ++k) {
            (bytes32 w,) = src.wordOf(a.tickets, k);
            assertEq(w, _expectedWord(k), "X11: a settled draw's word comes from its round's rule");
        }
    }

    /// X12: never stuck: a dead head lets anyone enter terminal mode, a counting head lets anyone settle (each tried in
    /// a rolled-back snapshot).
    function _checkX12_neverStuck() internal {
        Head memory h = _head();
        if (h.exists && h.dead) {
            uint256 snap = vm.snapshotState();
            (bool ok,) = a.tickets.call(abi.encodeCall(tickets.enterTerminal, ()));
            vm.revertToState(snap);
            assertTrue(ok, "X12: a dead head: terminal mode is open to anyone");
        }
        if (_settleable(1) == 1) {
            uint256 snap = vm.snapshotState();
            (bool ok,) = a.tickets.call(abi.encodeCall(tickets.settle, (1)));
            vm.revertToState(snap);
            assertTrue(ok, "X12: a counting word at the head: anyone settles");
        }
    }

    /// X13: strict order: tickets up to drawsSettled are settled or opened, later ones requested or (terminal mode
    /// only) cancelled; every settled item equals the independent replay (word, position, pi_w).
    function _checkX13_order() internal view {
        IBoxTickets.TicketState memory s = tickets.status();
        for (uint256 k = 1; k <= s.drawsRequested; ++k) {
            DrawStatus st = tickets.drawTicket(k).status;
            if (k <= s.drawsSettled) {
                assertTrue(st == DrawStatus.Settled || st == DrawStatus.Opened, "X13: settled in order");
            } else {
                assertTrue(
                    st == DrawStatus.Requested || st == DrawStatus.Cancelled, "X13: nothing settled out of order"
                );
                if (st == DrawStatus.Cancelled) assertGt(s.terminalAt, 0, "X13: cancels only in terminal mode");
            }
        }
        if (s.drawsSettled != 0) _assertItemsMatchOracle();
    }

    /// X15: vault solvency (VLT-08): T balance == E, E*n >= m*A, n >= 1, h <= n, E + n <= S, n + t in the vault.
    function _checkX15_vaultSolvency() internal view {
        _assertVlt08Light("X15");
    }

    /// X16: the pool: before migration only the curve holds liquidity; after it the three L7 positions exist (the
    /// sentinel may be empty only after T was sent to the coordinator: W2-U2-2, accepted) and the curve is gone; "no
    /// position shrinks" (pair and lock, F72 (B)) in `_afterAction`.
    function _checkX16_pool() internal view {
        uint128[5] memory l = _liquidities();
        if (hook.migratedAtBlock() != 0) {
            assertEq(l[0], 0, "X16: the curve removed at migration");
            assertGt(l[1], 0, "X16: the ask exists after migration");
            assertGt(l[2], 0, "X16: the bid exists after migration");
            if (l[3] == 0) assertGt(gGiftToCoordinator, 0, "X16: an empty sentinel only after a T gift (W2-U2-2)");
        } else {
            assertGt(l[0], 0, "X16: the curve holds liquidity until migration");
            assertEq(uint256(l[1]) + l[2] + l[3] + l[4], 0, "X16: no other position before migration");
        }
    }

    /// X19 (each call): the tickets' deliveries left the vault (`_noteDelivered` counts any repeat as a violation);
    /// X20: the reward is what graduation credited, cleared once claimed, within 0.1% of R.
    function _checkX19X20_deliveriesAndReward() internal view {
        for (uint256 i; i < gDelivered.length; ++i) {
            assertTrue(vault.hasLeftVault(gDelivered[i]), "X19: a delivered item has left the vault");
        }
        if (gRewardHolder != address(0)) {
            assertEq(
                coordinator.rewardOf(gRewardHolder), gRewardClaimed ? 0 : gReward, "X20: the credited reward, paid once"
            );
            assertLe(gReward, raise / 1_000, "X20: reward <= 0.1% of R");
        }
    }

    /// X14, X17, X18 and every action's own oracle (`AuditSysActions`), and the cross-call checks: no violation.
    function _checkeveryActionAsTheRules() internal view {
        assertEq(violations, 0, lastViolation);
    }

    /// @dev Self-call wrappers of two checks (the controls expect their reverts).
    function xc_actions() external view onlySelf {
        _checkeveryActionAsTheRules();
    }

    function xc_x01() external view onlySelf {
        _checkX01_ethConservation();
    }

    // ================================================================================================ closing

    /// Drives the run to its end and asserts X06, X12 and X21; then reports the run (plan § 3.2 "Closing").
    function _afterRun() internal {
        _closing();
        _report();
        _reportClosing();
    }

    function x_closing() external onlySelf {
        _closingSteps();
    }

    function _closing() internal {
        // The closing's own calls are not handler actions: no counters, no write recorder.
        _closingSteps();
        _assertX21();
    }

    function _closingSteps() internal {
        if (!hook.closed()) {
            if (vm.getBlockTimestamp() < hook.windowEndsAt()) _warpT(hook.windowEndsAt());
            _buyTo(eoa[2], 3 * raise, curve.sqrtPriceLowerX96);
            assertTrue(hook.closed(), "closing: the curve closed");
        }
        if (!_graduated()) {
            try this.x_graduate(keeper, GRADUATE_FLOOR) returns (uint256 reward, uint256) {
                gRewardHolder = keeper;
                gReward = reward;
            } catch {
                assertTrue(false, "X06: graduate() with the runbook's gas failed once closed");
            }
        }
        if (!receiver.graduationSettled()) receiver.onGraduation();
        if (!stream.started()) stream.onGraduation();
        _closeQueue();
        _claimEverything();
    }

    /// @dev X12: post what can be posted, accept, settle and open; then 7 days of silence: the head is dead and
    /// terminal mode opens, every remaining draw is cancellable, and the placeholders without a number are handed back.
    function _closeQueue() internal {
        for (uint256 round_; round_ < 6; ++round_) {
            _postDue();
            IBoxTickets.TicketState memory s = tickets.status();
            if (s.terminalAt != 0) break;
            if (s.slots != 0 && s.wordAcceptedAt == 0 && s.wordRequestedAt != 0 && _usable(0, s.wordRequestedAt)) {
                tickets.acceptGraduationWord();
            }
            if (_settleable(1) != 0) tickets.settle(type(uint256).max);
            Head memory h = _head();
            if (!h.exists) break;
            if (h.dead) {
                tickets.enterTerminal();
                break;
            }
            _warpT(h.deadline + 1);
        }
        IBoxTickets.TicketState memory t = tickets.status();
        assertTrue(!_head().exists || t.terminalAt != 0, "X12: after the silence the queue is settled or terminal");
        for (uint256 k = 1; k <= t.drawsRequested; ++k) {
            IBoxTickets.DrawView memory d = tickets.drawTicket(k);
            if (d.status == DrawStatus.Requested) {
                assertTrue(t.terminalAt != 0, "X12: a requested draw outside terminal mode after the silence");
                _cancelDraw(eoa[2], k);
            } else if (d.status == DrawStatus.Settled) {
                ItemReveal memory r = tree.itemReveal(d.itemId);
                vm.prank(d.drawer);
                tickets.openDraw(k, d.drawer, r);
            }
            d = tickets.drawTicket(k);
            assertTrue(d.status == DrawStatus.Opened || d.status == DrawStatus.Cancelled, "X12: every draw ended");
        }
        (uint256[] memory ids,) = _livePlaceholders();
        for (uint256 i; i < ids.length; ++i) {
            address owner = tickets.ownerOf(ids[i]);
            if (tickets.status().wordAcceptedAt != 0) {
                ItemReveal memory r = tree.itemReveal(tickets.numberOf(ids[i]));
                vm.prank(owner);
                tickets.open(ids[i], r);
            } else {
                uint256[] memory one = new uint256[](1);
                one[0] = ids[i];
                _handBack(owner, one);
            }
        }
        (ids,) = _livePlaceholders();
        assertEq(ids.length, 0, "X12: every placeholder opened or handed back");
        assertEq(vault.pendingTickets(), 0, "X12: no ticket left pending");
    }

    function _postDue() internal {
        IBoxTickets.TicketState memory s = tickets.status();
        for (uint256 key; key <= s.drawsRequested; ++key) {
            uint256 round = _pendingRound(key);
            if (round == 0 || !gIsCommitted[round] || vm.getBlockTimestamp() < src.roundTime(round)) continue;
            (, uint64 postedAt) = drand.beaconOf(round);
            if (postedAt == 0) _post(round);
        }
    }

    /// @dev Every claimable balance claimed by its named party (X21's "claimable now").
    function _claimEverything() internal {
        if (gRewardHolder != address(0) && coordinator.rewardOf(gRewardHolder) != 0) {
            _claimReward(gRewardHolder, keeper);
            gRewardClaimed = true;
        }
        if (drand.owedTo(poster) != 0) _withdrawBounty(poster, payable(poster));
        // Moves into the receiver first (royalties as fees, forced ETH to depth, the tax to depth), then the batch,
        // then the payouts, then the executor.
        if (a.launchRouter.balance != 0) {
            vm.prank(keeper);
            launchRouter.sweep();
        }
        if (a.royaltyRouter.balance != 0 || _wethOf(a.royaltyRouter) != 0) {
            vm.prank(keeper);
            royaltyRouter.flush();
            gForced[a.royaltyRouter] = 0;
        }
        if (a.receiver.balance != 0) {
            vm.prank(keeper);
            receiver.fundDepth();
            gForced[a.receiver] = 0;
        }
        try this.x_collect(keeper, keeper) {} catch {}
        if (receiver.fitOwed() != 0) _payFit(keeper);
        if (receiver.platformOwed() != 0) {
            uint256 amount = _payPlatform(keeper);
            _notePlatformPaid(amount);
        }
        try this.x_execute(3) {} catch {}
        gDirectT[a.executor] = 0;
        for (uint256 i; i < traders.length; ++i) {
            uint256[] memory ids = _idsOf(traders[i]);
            if (ids.length != 0 || stream.owedOf(traders[i]) > 1) _claimStreamFor(keeper, traders[i], ids);
        }
        for (uint256 i = 6; i < 8; ++i) {
            uint256[] memory ids = _idsOf(eoa[i]);
            if (ids.length != 0 || stream.owedOf(eoa[i]) > 1) _claimStreamFor(keeper, eoa[i], ids);
        }
        stream.burn();
    }

    /// @dev X21: every wei and every T unit is out (booked by the ghost), claimable by a named party, in the pool
    /// (any seller's exit), or in a documented no-exit class whose size is recorded. The classes partition the
    /// system's holdings exactly.
    function _assertX21() internal {
        _assertGhostLedger();
        // X03 / VLT-08 with every id walked once per run: n + t + outside == N in the vault's bits, the bits agree with
        // the collection's owners, Σ balances == N with one owner per id.
        _assertVlt08("X21");
        // ---- ETH
        uint256 claims;
        for (uint256 k; k < N_REC; ++k) {
            claims += pm.balanceOf(recAddr[k], 0);
        }
        uint256 reserves = address(pm).balance - claims;
        uint256 pots;
        for (uint256 i; i < gRounds.length; ++i) {
            pots += drand.bountyOf(gRounds[i]);
        }
        uint256 forcedNoExit;
        address[11] memory noIntake = [
            a.coordinator,
            a.hook,
            a.tickets,
            a.vault,
            a.collection,
            a.itemStream,
            a.table,
            a.token,
            address(src),
            address(factory),
            address(factory.registry())
        ];
        for (uint256 i; i < 11; ++i) {
            forcedNoExit += noIntake[i].balance;
        }
        uint256 coordGifts = gClaimGift[a.coordinator];
        uint256 sum = reserves + claims + a.launchRouter.balance + a.executor.balance + address(drand).balance
            + a.royaltyRouter.balance + _wethOf(a.royaltyRouter) + a.receiver.balance + forcedNoExit;
        assertEq(sum, _ghostSystemEth(), "X21: the ETH classes partition box 0's ETH");
        assertEq(a.receiver.balance, 0, "X21: no forced ETH left at the receiver (fundDepth takes it)");
        assertEq(a.launchRouter.balance, 0, "X21: no tax left unswept after graduation");
        assertEq(a.royaltyRouter.balance + _wethOf(a.royaltyRouter), 0, "X21: no royalty left unflushed");
        assertEq(drand.owedTo(poster), 0, "X21: the poster's credits withdrawn");
        assertEq(coordinator.rewardOf(gRewardHolder), 0, "X21: the reward claimed");
        assertEq(receiver.fitOwed() + receiver.platformOwed(), 0, "X21: FIT and the Safe paid");
        gEnd[0] = reserves;
        gEnd[1] = pm.balanceOf(a.receiver, 0);
        gEnd[2] = pm.balanceOf(a.hook, 0);
        gEnd[3] = a.executor.balance;
        gEnd[4] = pots;
        gEnd[5] = forcedNoExit + gForcedTotal[address(drand)] + coordGifts;
        if (gEnd[5] != 0) _exc(Exc.M27, gEnd[5]);
        // ---- T
        uint256 tSys = _ghostSystemT();
        uint256 e = vault.escrowPrincipal();
        uint256 st = token.balanceOf(a.itemStream);
        uint256 pmT = token.balanceOf(address(pm));
        uint256 directSum;
        address[13] memory direct = [
            a.hook,
            a.launchRouter,
            a.tickets,
            a.collection,
            a.table,
            address(drand),
            address(src),
            address(factory),
            address(factory.registry()),
            a.royaltyRouter,
            a.receiver,
            a.coordinator,
            a.executor
        ];
        for (uint256 i; i < 13; ++i) {
            directSum += token.balanceOf(direct[i]);
        }
        assertEq(e + st + pmT + directSum, tSys, "X21: the T classes partition box 0's T");
        assertEq(token.balanceOf(a.executor), 0, "X21: the executor burned what it held");
        assertEq(receiver.tBurnPending() + gDirectT[a.receiver], token.balanceOf(a.receiver), "X21: receiver T classes");
        (uint256 kFloor,) = vault.escrowSurplus();
        gEnd[6] = e;
        gEnd[7] = kFloor;
        gEnd[8] = st;
        gEnd[9] = stream.liabilities();
        gEnd[10] = pmT;
        gEnd[11] = directSum - receiver.tBurnPending();
        gEnd[12] = gStuck.length;
        uint256 stuckShare;
        for (uint256 i; i < gStuck.length; ++i) {
            if (gStuckAt[gStuck[i]] == a.itemStream) {
                (, uint256 pend) = stream.pendingOf(gStuck[i]);
                stuckShare += pend;
            }
        }
        gEnd[13] = stuckShare + stream.owedOf(a.itemStream);
        // The stream holds the owners' accrual plus one raw unit per outside slot (the margin) after its burn: what is
        // left there beyond that is the W3-U7-1 share of items it holds and the refused burns.
        if (gDirectT[a.receiver] != 0) _exc(Exc.M01, gDirectT[a.receiver]);
    }

    function _reportClosing() internal {
        console.log("closing ETH: pool reserves", gEnd[0], "receiver claims", gEnd[1]);
        console.log("closing ETH: hook depth claims", gEnd[2], "executor budget", gEnd[3]);
        console.log("closing ETH: unposted pots", gEnd[4], "no-exit forced and gifts (M27, FQ-19)", gEnd[5]);
        console.log("closing T: vault E", gEnd[6], "escrow surplus kFloor (F23 C2)", gEnd[7]);
        console.log("closing T: stream", gEnd[8], "liabilities", gEnd[9]);
        console.log("closing T: PoolManager", gEnd[10], "direct at box addresses (M01, M02, M25)", gEnd[11]);
        console.log("closing items at box contracts (W3-U7-1)", gEnd[12], "their stream share", gEnd[13]);
        bool exact = runCalls == _depth();
        console.log("closing max over runs: no-exit forced ETH and gifts", _max("END_FORCED", gEnd[5]));
        console.log("closing max over runs: raw T at box addresses (M01, M02, M25)", _max("END_DIRECT_T", gEnd[11]));
        console.log("closing max over runs: items at box contracts (W3-U7-1)", _max("END_STUCK_ITEMS", gEnd[12]));
        console.log(
            "closing sum over exact runs: items at box contracts", _sum("END_STUCK_ITEMS_SUM", exact ? gEnd[12] : 0)
        );
        console.log("closing max over runs: their stream share", _max("END_STUCK_SHARE", gEnd[13]));
        console.log("closing max over runs: unposted pots", _max("END_POTS", gEnd[4]));
        console.log("closing max over runs: escrow surplus kFloor (F23 C2)", _max("END_SURPLUS", gEnd[7]));
        console.log("closing max over runs: pool reserves ETH", _max("END_RESERVES", gEnd[0]));
        console.log("closing max over runs: executor budget left", _max("END_BUDGET", gEnd[3]));
        console.log("closing max over runs: hook depth claims left", _max("END_DEPTH", gEnd[2]));
        console.log("closing runs closed", _sum("END_RUNS", 1), "exact", _sum("END_XRUNS", exact ? 1 : 0));
        uint256 leastOk = _minEnv("GRAD_LEAST_OK", gLeastGraduateGas);
        uint256 mostRefused = _max("GRAD_MOST_REFUSED", gMostRefusedGraduateGas);
        console.log("closing graduate gas limits: least that passed", leastOk, "most that was refused", mostRefused);
        console.log("closing graduation poke failures (this run)", gGraduatePokeFailures);
    }
}
