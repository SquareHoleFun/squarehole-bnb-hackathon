// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BoxItemStreamHarness, S8World} from "./BoxS8World.sol";

/// @notice R1 (Codex architecture review 2026-10-07): every draw earns from its own request, at its opening and at its
/// cancel, for any number of open draws, in any order. On the test world (BoxS8World), whose fees move J by whole numbers:
/// a fee of 15·N·k raw T after graduation raises J by exactly 13·k, so the stream must match each draw's exact accrual
/// (J at the opening or cancel − J at its own request) to the raw unit. Before the fix every opening and cancel took the
/// open draws' mean J at request (exact only while one draw was open).
contract BoxItemStreamExactDrawsTest is Test {
    S8World internal w;
    BoxItemStreamHarness internal s;
    uint256 internal n;
    address internal alice = makeAddr("r1.alice");
    address internal bob = makeAddr("r1.bob");
    address internal carol = makeAddr("r1.carol");
    address internal dave = makeAddr("r1.dave");
    bytes32 internal constant WORD = keccak256("r1.word");

    function setUp() public {
        _world(10);
    }

    function _world(uint256 n_) internal {
        n = n_;
        w = new S8World(n_, 1);
        w.boot();
        s = w.stream();
    }

    /// J rises by exactly 13·k (a fee of 15·N·k raw T: 13/15 to the stream, ÷ N).
    function _bump(uint256 k) internal {
        w.fee(15 * n * k);
    }

    function _pending(uint256 id) internal view returns (uint256 amount) {
        (, amount) = s.pendingOf(id);
    }

    function _openTickets() internal view returns (uint256 d, uint256 sum) {
        (, d, sum) = s.openTickets();
    }

    // ------------------------------------------------------------------------------------------------ the review's case

    /// The review's counterexample (N 20): ten draws at J 0, one at J 130, opened oldest first. The late draw earned
    /// nothing before its request; each early draw earned 130 (before the fix: 118 for the late one, 131 for the first
    /// early ones; the documented half-spread bound was 65).
    function test_R1_reviewCase_oldestFirst() public {
        _world(20);
        w.graduate(WORD);
        for (uint256 i; i < 10; ++i) {
            w.draw();
        }
        w.fee(3000);
        assertEq(s.index(), 130);
        w.draw();
        for (uint256 i; i < 10; ++i) {
            assertEq(_pending(w.openDraw(alice)), 130, "an early draw: since J 0");
        }
        assertEq(_pending(w.openDraw(bob)), 0, "the late draw: nothing before its request");
        (uint256 d, uint256 sum) = _openTickets();
        assertEq(d, 0);
        assertEq(sum, 0, "every request's J left the sum");
        assertEq(s.liabilities(), 10 * 130, "the early draws' accrual, nothing more");
    }

    /// The same, the late draw opened first.
    function test_R1_reviewCase_lateFirst() public {
        _world(20);
        w.graduate(WORD);
        for (uint256 i; i < 10; ++i) {
            w.draw();
        }
        w.fee(3000); // J 130
        uint256 late = w.draw();
        assertEq(_pending(w.openDrawTicket(late, bob)), 0, "the late draw: nothing before its request");
        for (uint256 t = 1; t <= 10; ++t) {
            assertEq(_pending(w.openDrawTicket(t, alice)), 130, "an early draw: since J 0");
        }
    }

    // ------------------------------------------------------------------------------------------------ 1 versus N

    /// `early` draws at J 0 and one at J 13·1,000, all opened at J 13·2,000 with the late draw opened at position `at`
    /// (0: first; `early`: last): each early draw 26,000, the late one 13,000, whatever the count and the order. The
    /// mean gave the late draw 13,000 + 13,000·early/(early + 1) (up to the whole spread, not its half).
    function testFuzz_R1_oneVersusN_anyPosition(uint16 earlyRaw, uint16 atRaw) public {
        _world(4269);
        uint256 early = 1 + uint256(earlyRaw) % 200;
        uint256 at = uint256(atRaw) % (early + 1);
        w.graduate(WORD);
        for (uint256 i; i < early; ++i) {
            w.draw();
        }
        _bump(1000); // J 13,000
        uint256 late = w.draw();
        _bump(1000); // J 26,000
        uint256 nextEarly = 1;
        for (uint256 k; k <= early; ++k) {
            if (k == at) {
                assertEq(_pending(w.openDrawTicket(late, bob)), 13_000, "the late draw: since its own request");
            } else {
                assertEq(_pending(w.openDrawTicket(nextEarly++, alice)), 26_000, "an early draw: since its request");
            }
        }
        (uint256 d, uint256 sum) = _openTickets();
        assertEq(d, 0);
        assertEq(sum, 0);
    }

    /// The response's sizing case at its largest: one late draw against 1,000 early ones (N 4,269, spread 13,000), the
    /// late one opened first and last. The mean gave it 12,988 of the 13,000 it did not earn. Gas metering is paused: the
    /// 4,004 requests and openings run in one test call, which under `--hardfork amsterdam` passes EIP-7825's 16,777,216
    /// per call (out of gas at the 961st request); the test checks the accounting, not gas.
    function test_R1_oneVersusAThousand_bothOrders() public {
        vm.pauseGasMetering();
        for (uint256 order; order < 2; ++order) {
            _world(4269);
            w.graduate(WORD);
            for (uint256 i; i < 1000; ++i) {
                w.draw();
            }
            _bump(1000); // J 13,000
            uint256 late = w.draw();
            if (order == 0) assertEq(_pending(w.openDrawTicket(late, bob)), 0, "late first: nothing");
            for (uint256 t = 1; t <= 1000; ++t) {
                assertEq(_pending(w.openDrawTicket(t, alice)), 13_000);
            }
            if (order == 1) assertEq(_pending(w.openDrawTicket(late, bob)), 0, "late last: nothing");
            assertEq(s.liabilities(), 1000 * 13_000, "exactly the early draws' accrual");
        }
    }

    // ------------------------------------------------------------------------------------------------ delayed openings

    /// Requests at J 0, 130 and 260; openings at J 390 (the middle one), 520 (the newest), 650 (the oldest).
    function test_BC065_drawShareFromItsOwnRequestPassesToItsMisfit() public {
        w.graduate(WORD);
        uint256 t1 = w.draw(); // J 0
        _bump(10);
        uint256 t2 = w.draw(); // J 130
        _bump(10);
        uint256 t3 = w.draw(); // J 260
        (uint256 d, uint256 sum) = _openTickets();
        assertEq(d, 3);
        assertEq(sum, 0 + 130 + 260);
        _bump(10); // J 390
        uint256 i2 = w.openDrawTicket(t2, alice);
        assertEq(_pending(i2), 260, "ticket 2: 390 - 130");
        (d, sum) = _openTickets();
        assertEq(sum, 260, "its own J left the sum, not the mean");
        _bump(10); // J 520
        uint256 i3 = w.openDrawTicket(t3, bob);
        assertEq(_pending(i3), 260, "ticket 3: 520 - 260");
        _bump(10); // J 650
        uint256 i1 = w.openDrawTicket(t1, carol);
        assertEq(_pending(i1), 650, "ticket 1: 650 - 0");
        assertEq(_pending(i2), 520);
        assertEq(_pending(i3), 390);
        assertEq(s.liabilities(), 650 + 520 + 390, "every owner's accrual, nothing else");
    }

    /// A stale draw (J 0, never opened) while 50 others are requested and opened one by one, J rising 1,300 between
    /// them and 650 between each request and its opening: each passer gets its 650, the stale draw all 65,650. With the
    /// mean the stale draw kept 1,300 and the passers took the rest (the sum stayed exact).
    function test_R1_staleDrawPassedByOthers() public {
        _world(4269);
        w.graduate(WORD);
        uint256 stale = w.draw(); // J 0
        for (uint256 i; i < 50; ++i) {
            _bump(100); // +1,300
            uint256 t = w.draw();
            _bump(50); // +650
            uint256 id = w.openDrawTicket(t, address(uint160(0x1000 + i)));
            assertEq(_pending(id), 650, "a passer: since its own request");
        }
        assertEq(s.index(), 50 * 1950);
        uint256 staleItem = w.openDrawTicket(stale, carol);
        assertEq(_pending(staleItem), 50 * 1950, "the stale draw: everything since its request");
    }

    // ------------------------------------------------------------------------------------------------ transfers

    /// Other Misfits change hands, return and are picked while draws wait; then the draws open (to the drawer or to an
    /// address the drawer names) and their Misfits are sold: each first holder is booked from its ticket's request to the
    /// sale, each buyer from the sale.
    function test_R1_transfersBetweenRequestAndDelivery() public {
        w.take(1);
        w.graduate(WORD);
        uint256 ph = w.openPlaceholder(dave); // since J 0
        uint256 t1 = w.draw(); // J 0
        _bump(10); // J 130
        w.transfer(dave, alice, ph);
        assertEq(s.owedOf(dave), 130);
        uint256 t2 = w.draw(); // J 130
        _bump(10); // J 260
        uint256[] memory ids = new uint256[](1);
        ids[0] = ph;
        w.returnItems(alice, ids);
        assertEq(s.owedOf(alice), 130);
        _bump(10); // J 390
        w.withdraw(bob, ids); // a named pick: from J 390
        uint256 i2 = w.openDrawTicket(t2, carol); // to an address the drawer names
        assertEq(_pending(i2), 260, "ticket 2 from J 130");
        _bump(10); // J 520
        w.transfer(carol, alice, i2);
        assertEq(s.owedOf(carol), 390, "carol: from ticket 2's request to the sale");
        uint256 i1 = w.openDrawTicket(t1, bob);
        assertEq(_pending(i1), 520, "ticket 1 from J 0");
        _bump(10); // J 650
        w.transfer(bob, dave, i1);
        assertEq(s.owedOf(bob), 650, "bob: ticket 1 from J 0 to the sale");
        assertEq(_pending(i2), 130, "alice from her purchase");
        assertEq(_pending(ph), 260, "bob's named pick from J 390");
        (uint256 d, uint256 sum) = _openTickets();
        assertEq(d, 0);
        assertEq(sum, 0);
    }

    // ------------------------------------------------------------------------------------------------ terminal mode

    /// Twenty draws requested evenly (J +1,300 between them), all cancelled in terminal mode, oldest first: each drawer
    /// gets exactly its own accrual, from 26,000 down to 1,300. The mean gave each 13,650.
    function test_R1_terminalCancels_even() public {
        _world(4269);
        w.graduate(WORD);
        uint256[20] memory reqJ;
        for (uint256 i; i < 20; ++i) {
            reqJ[i] = s.index();
            w.draw();
            _bump(100);
        }
        w.enterTerminal(true);
        uint256 j = s.index();
        assertEq(j, 26_000);
        for (uint256 i; i < 20; ++i) {
            address drawer = address(uint160(0x2000 + i));
            w.cancelDraw(i + 1, drawer);
            assertEq(s.owedOf(drawer), j - reqJ[i], "a cancel: from its own request");
        }
        (uint256 d, uint256 sum) = _openTickets();
        assertEq(d, 0);
        assertEq(sum, 0);
    }

    /// Skewed: 30 draws at J 0 and one at J 13,000, cancelled at J 26,000, the late one first and then last.
    function test_R1_terminalCancels_skewed() public {
        for (uint256 order; order < 2; ++order) {
            _world(4269);
            w.graduate(WORD);
            for (uint256 i; i < 30; ++i) {
                w.draw();
            }
            _bump(1000); // J 13,000
            uint256 late = w.draw();
            _bump(1000); // J 26,000
            w.enterTerminal(true);
            if (order == 0) w.cancelDraw(late, bob);
            for (uint256 t = 1; t <= 30; ++t) {
                w.cancelDraw(t, alice);
            }
            if (order == 1) w.cancelDraw(late, bob);
            assertEq(s.owedOf(bob), 13_000, "the late draw: since its own request");
            assertEq(s.owedOf(alice), 30 * 26_000, "the early draws: since J 0");
        }
    }

    /// Cancels newest first with the word stored, to different drawers.
    function test_R1_terminalCancels_newestFirst() public {
        w.graduate(WORD);
        uint256 t1 = w.draw(); // J 0
        _bump(10);
        uint256 t2 = w.draw(); // J 130
        _bump(10);
        uint256 t3 = w.draw(); // J 260
        _bump(10); // J 390
        w.enterTerminal(true);
        w.cancelDraw(t3, carol);
        assertEq(s.owedOf(carol), 130);
        w.cancelDraw(t1, alice);
        assertEq(s.owedOf(alice), 390);
        w.cancelDraw(t2, bob);
        assertEq(s.owedOf(bob), 260);
        assertEq(s.liabilities(), 130 + 390 + 260);
    }

    /// Without the word: a placeholder handed back and a draw's cancel are told apart by the ticket in flight, not by the
    /// release's size (the tie-break of SH-S8-stream § 3 item 5 is gone): one placeholder handed back while a draw is open
    /// is booked from graduation, the cancel from its request, in either order.
    function test_R1_terminalWithoutTheWord_handBacksAndCancels() public {
        for (uint256 order; order < 2; ++order) {
            _world(10);
            w.take(2);
            w.graduate(WORD);
            _bump(10); // J 130
            uint256 t1 = w.draw(); // J 130
            _bump(10); // J 260
            w.enterTerminal(false);
            if (order == 0) w.cancelDraw(t1, bob);
            w.releaseTickets(alice, 1); // one placeholder handed back
            if (order == 1) w.cancelDraw(t1, bob);
            assertEq(s.owedOf(alice), 260, "a placeholder: from graduation");
            assertEq(s.owedOf(bob), 130, "the cancel: from its request");
            w.releaseTickets(carol, 1);
            assertEq(s.owedOf(carol), 260);
            (uint256 p, uint256 d,) = s.openTickets();
            assertEq(p, 0);
            assertEq(d, 0);
        }
    }

    // ------------------------------------------------------------------------------------------------ a missed request

    /// A request the stream did not see (the vault's capped call failed: never expected at 2x headroom) starts at its
    /// opening and books nothing at a cancel; it takes nothing from the draws the stream saw, and no placeholder.
    function test_R1_aRequestTheStreamDidNotSee() public {
        w.take(1);
        w.graduate(WORD);
        uint256 t1 = w.draw(); // J 0, seen
        _bump(10); // J 130
        uint256 t2 = w.drawSkippingObserver(); // not seen
        uint256 t3 = w.drawSkippingObserver(); // not seen
        _bump(10); // J 260
        (uint256 d, uint256 sum) = _openTickets();
        assertEq(d, 1);
        assertEq(sum, 0);
        uint256 i2 = w.openDrawTicket(t2, alice);
        assertEq(_pending(i2), 0, "unseen: from its opening");
        assertEq(_pending(w.openDrawTicket(t1, bob)), 260, "seen: from its request");
        w.enterTerminal(true);
        w.cancelDraw(t3, carol);
        assertEq(s.owedOf(carol), 0, "unseen: nothing booked at its cancel");
        (uint256 p,,) = s.openTickets();
        assertEq(p, 1, "the open placeholder is not taken for it");
    }

    /// A request the stream saw whose delivery checkpoint was skipped (the collection's capped call failed; never
    /// expected at 2x headroom, the floor stops gas starvation): the ticket stays in the open draws' count and J sum for
    /// good, so `openTickets()` drifts (only that view reads them). Nobody is credited the draw's accrual from its request
    /// to the next checkpoint: it stays in the liabilities, neither paid nor burned, and does not grow after the repair.
    /// Every other draw stays exact (SH-box0-r1 review round 1, finding 10; SH-box0-r1 Limitation 3).
    function test_R1_aDeliveryTheStreamDidNotSee() public {
        w.take(1);
        w.graduate(WORD);
        _bump(5); // J 65
        uint256 t1 = w.draw(); // J 65, seen
        _bump(10); // J 195
        uint256 t2 = w.draw(); // J 195, seen
        _bump(10); // J 325
        uint256 i1 = w.openDrawTicketSkippingObserver(t1, alice); // the delivery not seen
        assertEq(_pending(i1), 0, "no record for the skipped delivery");
        (uint256 d, uint256 sum) = _openTickets();
        assertEq(d, 2, "the skipped delivery's ticket stays among the open draws");
        assertEq(sum, 65 + 195);
        _bump(10); // J 455
        w.transfer(alice, bob, i1); // repaired: the record starts at bob, now
        assertEq(s.owedOf(alice), 0, "nobody is credited the skipped draw's accrual");
        assertEq(_pending(i1), 0);
        uint256 i2 = w.openDrawTicket(t2, carol);
        assertEq(_pending(i2), 455 - 195, "the other draw: exact from its own request");
        (d, sum) = _openTickets();
        assertEq(d, 1, "drift: the skipped ticket stays in the count for good");
        assertEq(sum, 65, "with its J at request");
        for (uint256 k; k < 2; ++k) {
            _bump(10); // J 585, then 715
            uint256 j = s.index();
            (uint256 p,,) = s.openTickets();
            assertEq(p, 1);
            // Owed and pending of every record, plus the open placeholder's accrual since the start.
            uint256 known = s.owedOf(alice) + s.owedOf(bob) + s.owedOf(carol) + _pending(i1) + _pending(i2) + p * j;
            assertEq(_pending(i1), j - 455, "bob: from the repair");
            assertEq(s.liabilities() - known, 455 - 65, "the skipped accrual, from the request to the repair, only");
        }
    }

    // ------------------------------------------------------------------------------------------------ the exact model

    /// Ticket id − 1 → J at request, status (1 open, 2 opened, 3 cancelled), drawer.
    uint256[] internal mReqJ;
    uint8[] internal mStatus;
    address[] internal mDrawer;
    mapping(address => uint256) internal mOwed;
    mapping(address => uint256) internal mPaid;
    mapping(uint256 => address) internal mOwner;
    mapping(uint256 => uint256) internal mSince;
    uint256[] internal mItems;
    uint256[] internal mShelf;
    uint256 internal mPlaceholders;
    uint256 internal mPlaceholdersToOpen;
    address[5] internal actors;

    /// Many open draws at once (up to 59 at N 64), against an exact per-request model in J units: placeholders taken on
    /// the curve, then random fees, gifts, batches, draws, openings in any order to any address, placeholder openings,
    /// transfers, returns, named picks and claims; then terminal mode with cancels in any order (with the word stored:
    /// openings still; without it, as BoxTickets allows: nothing opened before, hand-backs after). After every step: each
    /// account's booked T, each item's record and pending accrual, the open draws' count and J sum and the liabilities
    /// equal the model to the raw unit; each opening and each cancel equal its draw's own accrual.
    function testFuzz_BC065_drawsAgainstAnExactPerRequestModel(uint256 seed) public {
        _world(64);
        actors = [alice, bob, carol, dave, makeAddr("r1.erin")];
        vm.etch(actors[4], hex"00"); // a contract holder (F61 X1)
        mPlaceholders = seed % 5;
        if (mPlaceholders != 0) w.take(mPlaceholders);
        mPlaceholdersToOpen = mPlaceholders;
        w.graduate(keccak256(abi.encode("r1.model", seed)));
        uint256 terminalAt = 40 + (seed >> 8) % 60;
        bool withWord = (seed >> 16) & 3 != 0;
        for (uint256 step; step < 120; ++step) {
            uint256 r = uint256(keccak256(abi.encode(seed, step)));
            if (step == terminalAt) {
                w.enterTerminal(withWord);
            }
            if (step < terminalAt) _modelStep(r, withWord);
            else _modelTerminalStep(r, withWord);
            _check();
        }
    }

    function _modelStep(uint256 r, bool opens) internal {
        uint256 op = r % 100;
        address a = actors[(r >> 8) % 5];
        address b = actors[(r >> 16) % 5];
        if (op < 20) {
            _bump(1 + (r >> 24) % 40);
        } else if (op < 23) {
            w.gift(1 + (r >> 24) % 1e18);
        } else if (op < 26) {
            w.collect();
        } else if (op < 50) {
            _modelDraw(a);
        } else if (!opens) {
            _bump(1 + (r >> 24) % 40);
        } else if (op < 66) {
            _modelOpen(r >> 40, b);
        } else if (op < 70) {
            _modelOpenPlaceholder(a);
        } else if (op < 82) {
            _modelTransfer(r >> 48, b);
        } else if (op < 86) {
            _modelReturn(r >> 48);
        } else if (op < 90) {
            _modelPick(r >> 56, b);
        } else {
            _modelClaim(a);
        }
    }

    function _modelTerminalStep(uint256 r, bool withWord) internal {
        uint256 op = r % 100;
        address a = actors[(r >> 8) % 5];
        address b = actors[(r >> 16) % 5];
        if (op < 25) {
            _bump(1 + (r >> 24) % 40);
        } else if (op < 55) {
            _modelCancel(r >> 40);
        } else if (op < 65 && !withWord && mPlaceholdersToOpen != 0) {
            uint256 k = 1 + (r >> 32) % mPlaceholdersToOpen;
            uint256 j = s.index();
            w.releaseTickets(a, k); // a hand-back: from graduation
            mOwed[a] += k * j;
            mPlaceholdersToOpen -= k;
            mPlaceholders -= k;
        } else if (op < 75 && withWord) {
            _modelOpen(r >> 40, b); // a settled draw may still be opened
        } else if (op < 88) {
            _modelTransfer(r >> 48, b);
        } else {
            _modelClaim(a);
        }
    }

    function _modelDraw(address drawer) internal {
        if (w.inside() <= 1) return;
        mReqJ.push(s.index());
        mStatus.push(1);
        mDrawer.push(drawer);
        assertEq(w.draw(), mStatus.length, "tickets numbered in order");
    }

    function _modelOpen(uint256 r, address to) internal {
        uint256 t = _someOpen(r);
        if (t == 0) return;
        uint256 j = s.index();
        uint256 id = w.openDrawTicket(t, to);
        mStatus[t - 1] = 2;
        mOwner[id] = to;
        mSince[id] = mReqJ[t - 1];
        mItems.push(id);
        assertEq(_pending(id), j - mSince[id], "the opened draw: exactly since its own request");
    }

    function _modelOpenPlaceholder(address to) internal {
        if (mPlaceholdersToOpen == 0) return;
        uint256 id = w.openPlaceholder(to);
        --mPlaceholdersToOpen;
        --mPlaceholders;
        mOwner[id] = to;
        mSince[id] = 0; // from graduation (G07 point 4)
        mItems.push(id);
    }

    function _modelCancel(uint256 r) internal {
        uint256 t = _someOpen(r);
        if (t == 0) return;
        uint256 j = s.index();
        address drawer = mDrawer[t - 1];
        uint256 before = s.owedOf(drawer);
        w.cancelDraw(t, drawer);
        mStatus[t - 1] = 3;
        uint256 due = j - mReqJ[t - 1];
        mOwed[drawer] += due;
        assertEq(s.owedOf(drawer) - before, due, "the cancel: exactly since its own request");
    }

    function _modelTransfer(uint256 r, address to) internal {
        if (mItems.length == 0) return;
        uint256 id = mItems[r % mItems.length];
        address from = mOwner[id];
        if (from == to) return;
        uint256 j = s.index();
        w.transfer(from, to, id);
        mOwed[from] += j - mSince[id];
        mOwner[id] = to;
        mSince[id] = j;
    }

    function _modelReturn(uint256 r) internal {
        if (mItems.length == 0) return;
        uint256 k = r % mItems.length;
        uint256 id = mItems[k];
        uint256 j = s.index();
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        w.returnItems(mOwner[id], ids);
        mOwed[mOwner[id]] += j - mSince[id];
        mOwner[id] = address(0);
        mItems[k] = mItems[mItems.length - 1];
        mItems.pop();
        mShelf.push(id);
    }

    function _modelPick(uint256 r, address to) internal {
        if (mShelf.length == 0) return;
        uint256 k = r % mShelf.length;
        uint256[] memory ids = new uint256[](1);
        ids[0] = mShelf[k];
        uint256 j = s.index();
        w.withdraw(to, ids);
        mOwner[ids[0]] = to;
        mSince[ids[0]] = j;
        mItems.push(ids[0]);
        mShelf[k] = mShelf[mShelf.length - 1];
        mShelf.pop();
    }

    function _modelClaim(address a) internal {
        w.collect(); // T to pay with (X, so J, unchanged)
        uint256 c;
        for (uint256 i; i < mItems.length; ++i) {
            if (mOwner[mItems[i]] == a) ++c;
        }
        uint256[] memory ids = new uint256[](c);
        c = 0;
        uint256 j = s.index();
        for (uint256 i; i < mItems.length; ++i) {
            uint256 id = mItems[i];
            if (mOwner[id] != a) continue;
            ids[c++] = id;
            mOwed[a] += j - mSince[id];
            mSince[id] = j;
        }
        vm.prank(a);
        uint256 got = s.claim(ids, a);
        mPaid[a] += got;
        mOwed[a] -= got;
    }

    function _someOpen(uint256 r) internal view returns (uint256) {
        uint256 c = mStatus.length;
        if (c == 0) return 0;
        uint256 start = r % c;
        for (uint256 k; k < c; ++k) {
            uint256 i = (start + k) % c;
            if (mStatus[i] == 1) return i + 1;
        }
        return 0;
    }

    function _check() internal view {
        uint256 j = s.index();
        uint256 owedAll;
        uint256 pendingAll;
        for (uint256 k; k < 5; ++k) {
            address a = actors[k];
            assertEq(s.owedOf(a), mOwed[a], "booked, per account");
            owedAll += mOwed[a];
            for (uint256 i; i < mItems.length; ++i) {
                uint256 id = mItems[i];
                if (mOwner[id] != a) continue;
                (address o, uint256 p) = s.pendingOf(id);
                assertEq(o, a, "the record names the holder");
                assertEq(p, j - mSince[id], "pending, per item");
                pendingAll += p;
            }
        }
        uint256 open;
        uint256 sum;
        for (uint256 i; i < mStatus.length; ++i) {
            if (mStatus[i] == 1) {
                ++open;
                sum += mReqJ[i];
            }
        }
        (uint256 p_, uint256 d, uint256 ssum) = s.openTickets();
        assertEq(p_, mPlaceholders, "open placeholders");
        assertEq(d, open, "open draws");
        assertEq(ssum, sum, "their J at request, summed exactly");
        assertEq(s.liabilities(), owedAll + pendingAll + p_ * j + (d * j - ssum), "liabilities, exactly");
    }
}
