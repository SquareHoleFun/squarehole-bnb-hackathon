// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BoxItemStreamHarness, S8World} from "../../s8/BoxS8World.sol";

/// @notice S8's differential fuzz (BC-065, plan § 4 row S8): the stream's checkpoint allocation against a naive per-swap
/// allocation. The reference keeps, for every swap, the share 13·f/(15·N) of each outside slot (exact, scaled by 15·N)
/// and adds it to the slot's holder at that moment: every owner of an outside item, every open placeholder (passed to
/// its Misfit's recipient at the opening, G07 point 4) and every open draw on its own (passed at its opening to the
/// recipient, or at its cancel in terminal mode to the drawer: exactly that draw's accrual since its own request; R1,
/// Codex review 2026-10-07; up to 24 draws open at once, opened and cancelled in any order). The stream sees only
/// checkpoints: the vault's calls before n changes, the collection's per transfer, the receiver's batches.
///
/// **Rounding bound (stated, SH-S8-stream § 4):** per booked interval of one item, |stream − reference| < 1 + 26/N raw
/// units (J is floored once; X differs from the exact 13/15 by less than 13 raw units at each end, the receiver's
/// fifteenths and carry); a draw's opening or cancel adds one more interval. The test counts every interval it causes
/// and asserts |Δ| ≤ intervals·(2 + ⌈26/N⌉) + 2 per owner, each opened or cancelled draw within one interval's bound of
/// its own reference, and conservation to the raw unit.
/// @dev Requested replay of the existing controlled-callee differential; factory coverage is in LaneStreamInvariants.
/// forge-config: default.fuzz.runs = 1000
contract AuditU5LaneDifferential is Test {
    uint256 internal constant ACTORS = 5;
    /// The most draws open at once (the stream keeps each one's J at request, so any number is exact).
    uint256 internal constant MAX_OPEN_DRAWS = 24;
    uint256 internal constant FIRST = 1;

    S8World internal w;
    BoxItemStreamHarness internal s;
    uint256 internal n;
    address[ACTORS] internal actors;

    // ---------------------------------------------------------------- the reference (scaled by 15·N)
    mapping(address => uint256) internal ref;
    mapping(address => uint256) internal intervals;
    mapping(address => uint256) internal paid;
    mapping(address => uint256[]) internal held;
    mapping(address => uint256) internal placeholders;
    uint256 internal placeholderAcc;
    uint256 internal openPlaceholders;
    /// Open draws: the drawer, the ticket and the exact accrual since its request of each.
    address[] internal drawers;
    uint256[] internal drawTickets;
    uint256[] internal drawAcc;
    /// Openings and cancels checked against their own draw's reference.
    uint256 internal drawsChecked;
    uint256[] internal shelf;
    uint256 internal minted;
    uint256 internal insideRef;
    /// Slot events (a slot in or out, a checkpoint): each may move one raw unit between the owners and the burn.
    uint256 internal events;

    function _setUpWorld(uint256 n_) internal {
        n = n_;
        w = new S8World(n_, FIRST);
        w.boot();
        s = w.stream();
        for (uint256 i; i < ACTORS; ++i) {
            actors[i] = makeAddr(string.concat("s8.actor.", vm.toString(i)));
        }
        // The fifth holder is a contract (F61 X1: any owner earns, contracts included).
        vm.etch(actors[4], hex"00");
    }

    // ------------------------------------------------------------------------------------------------ the fuzz

    /// The whole life: placeholders on the curve, graduation, then `steps` random operations (swaps' fees, batches,
    /// openings, draws, transfers, returns, named picks, claims, burns, gifts), then every owner checkpointed.
    function testFuzz_AUDIT_U5_checkpointsEqualPerSwapAllocation_N4269(uint256 seed) public {
        _setUpWorld(4269);
        _life(seed, 70);
    }

    function testFuzz_AUDIT_U5_checkpointsEqualPerSwapAllocation_N69(uint256 seed) public {
        _setUpWorld(69);
        _life(seed, 70);
    }

    function _life(uint256 seed, uint256 steps) internal {
        // The curve: placeholders taken by each holder (G07 point 4: they earn from graduation).
        for (uint256 i; i < ACTORS; ++i) {
            uint256 k = _rand(seed, 1000 + i) % 4;
            if (k == 0) continue;
            w.take(k);
            events += k;
            placeholders[actors[i]] += k;
            openPlaceholders += k;
        }
        assertEq(s.index(), 0, "no index before the start");
        w.graduate(keccak256(abi.encode("s8.word", seed)));
        assertTrue(s.started());
        for (uint256 step; step < steps; ++step) {
            _step(_rand(seed, step));
        }
        _settleEverything(seed);
        _compare();
    }

    function _step(uint256 r) internal {
        uint256 op = r % 100;
        address a = actors[(r >> 8) % ACTORS];
        address b = actors[(r >> 16) % ACTORS];
        if (op < 34) {
            _fee(1 + (r >> 24) % 1e23);
        } else if (op < 42) {
            minted += w.collect();
        } else if (op < 50) {
            _openPlaceholder(a, r);
        } else if (op < 56) {
            _draw(a);
        } else if (op < 62) {
            _openDraw(b, r);
        } else if (op < 76) {
            _transfer(a, b, r);
        } else if (op < 83) {
            _return(a, r);
        } else if (op < 88) {
            _withdraw(a, r);
        } else if (op < 95) {
            _claim(a);
        } else if (op < 98) {
            s.burn();
        } else {
            _gift(1 + (r >> 24) % 1e21);
        }
    }

    // ------------------------------------------------------------------------------------------------ operations

    /// A swap's T fee f: every outside slot's holder gets 13·f/(15·N) now (scaled: 13·f).
    function _fee(uint256 f) internal {
        w.fee(f);
        _allocate(13 * f);
    }

    /// T given to the stream directly: X rises by x, each outside slot gets x/N (scaled: 15·x).
    function _gift(uint256 x) internal {
        w.gift(x);
        minted += x;
        _allocate(15 * x);
    }

    function _allocate(uint256 perSlot) internal {
        uint256 outside;
        for (uint256 i; i < ACTORS; ++i) {
            address a = actors[i];
            uint256 c = held[a].length;
            ref[a] += c * perSlot;
            outside += c;
        }
        placeholderAcc += perSlot;
        outside += openPlaceholders;
        for (uint256 i; i < drawAcc.length; ++i) {
            drawAcc[i] += perSlot;
        }
        outside += drawers.length;
        insideRef += (n - outside) * perSlot;
    }

    function _openPlaceholder(address a, uint256 r) internal {
        address h = a;
        for (uint256 i; i < ACTORS && placeholders[h] == 0; ++i) {
            h = actors[(i + r) % ACTORS];
        }
        if (placeholders[h] == 0) return;
        uint256 id = w.openPlaceholder(h);
        ++events;
        --placeholders[h];
        --openPlaceholders;
        ref[h] += placeholderAcc;
        held[h].push(id);
    }

    function _draw(address a) internal {
        if (drawers.length >= MAX_OPEN_DRAWS || w.inside() <= 1) return;
        drawTickets.push(w.draw());
        ++events;
        drawers.push(a);
        drawAcc.push(0);
    }

    /// A draw opens (in any order, as a drawer's page or the keeper opens it), to its drawer or to the address `b` it
    /// names: its item starts at its own request.
    function _openDraw(address b, uint256 r) internal {
        uint256 d = drawers.length;
        if (d == 0) return;
        uint256 k = (r >> 40) % d;
        address to = (r >> 64) & 1 == 0 ? drawers[k] : b;
        uint256 id = w.openDrawTicket(drawTickets[k], to);
        ++events;
        (, uint256 pending) = s.pendingOf(id);
        _checkDraw(pending, drawAcc[k], "an opened draw against its own accrual");
        ref[to] += drawAcc[k];
        ++intervals[to];
        _removeDraw(k);
        held[to].push(id);
    }

    /// Terminal mode with the word stored: a draw cancelled, booked to its drawer from its own request.
    function _cancelDraw(uint256 k) internal {
        address drawer = drawers[k];
        uint256 before = s.owedOf(drawer);
        w.cancelDraw(drawTickets[k], drawer);
        ++events;
        _checkDraw(s.owedOf(drawer) - before, drawAcc[k], "a cancelled draw against its own accrual");
        ref[drawer] += drawAcc[k];
        ++intervals[drawer];
        _removeDraw(k);
    }

    function _checkDraw(uint256 got, uint256 refScaled, string memory what) internal {
        assertApproxEqAbs(got, refScaled / (15 * n), 2 + (26 + n - 1) / n, what);
        ++drawsChecked;
    }

    function _removeDraw(uint256 k) internal {
        uint256 last = drawers.length - 1;
        drawers[k] = drawers[last];
        drawers.pop();
        drawTickets[k] = drawTickets[last];
        drawTickets.pop();
        drawAcc[k] = drawAcc[last];
        drawAcc.pop();
    }

    function _transfer(address a, address b, uint256 r) internal {
        uint256 c = held[a].length;
        if (c == 0 || a == b) return;
        uint256 k = (r >> 48) % c;
        uint256 id = held[a][k];
        w.transfer(a, b, id);
        ++events;
        ++intervals[a];
        _removeHeld(a, k);
        held[b].push(id);
    }

    function _return(address a, uint256 r) internal {
        uint256 c = held[a].length;
        if (c == 0) return;
        uint256 k = (r >> 48) % c;
        uint256[] memory ids = new uint256[](1);
        ids[0] = held[a][k];
        w.returnItems(a, ids);
        ++events;
        ++intervals[a];
        _removeHeld(a, k);
        shelf.push(ids[0]);
    }

    function _withdraw(address a, uint256 r) internal {
        uint256 c = shelf.length;
        if (c == 0) return;
        uint256 k = (r >> 48) % c;
        uint256[] memory ids = new uint256[](1);
        ids[0] = shelf[k];
        w.withdraw(a, ids);
        ++events;
        shelf[k] = shelf[c - 1];
        shelf.pop();
        held[a].push(ids[0]);
    }

    function _claim(address a) internal {
        uint256[] memory ids = held[a];
        intervals[a] += ids.length;
        events += ids.length;
        vm.prank(a);
        paid[a] += s.claim(ids, a);
    }

    function _removeHeld(address a, uint256 k) internal {
        uint256 last = held[a].length - 1;
        held[a][k] = held[a][last];
        held[a].pop();
    }

    // ------------------------------------------------------------------------------------------------ the end

    /// Every fee collected, every owner's items checkpointed (claimFor by anyone: the contract holder too), a burn. In
    /// half the runs the box ends in terminal mode first (the word stored) and every open draw is cancelled, in a random
    /// order.
    function _settleEverything(uint256 seed) internal {
        if (seed & 1 == 1 && drawers.length != 0) {
            w.enterTerminal(true);
            _fee(1 + (seed >> 8) % 1e23);
            for (uint256 i; drawers.length != 0; ++i) {
                _cancelDraw(_rand(seed, 9000 + i) % drawers.length);
            }
        }
        minted += w.collect();
        for (uint256 i; i < ACTORS; ++i) {
            address a = actors[i];
            uint256[] memory ids = held[a];
            intervals[a] += ids.length;
            events += ids.length;
            paid[a] += s.claimFor(a, ids);
        }
        s.burn();
    }

    function _compare() internal view {
        uint256 scale = 15 * n;
        uint256 perInterval = 2 + (26 + n - 1) / n;
        uint256 owed;
        for (uint256 i; i < ACTORS; ++i) {
            address a = actors[i];
            uint256 got = s.owedOf(a) + paid[a];
            owed += s.owedOf(a);
            uint256 want = ref[a] / scale;
            uint256 bound = intervals[a] * perInterval + 2;
            assertApproxEqAbs(got, want, bound, string.concat("owner ", vm.toString(i), " against per-swap"));
        }
        // Conservation, to the raw unit: what arrived = held + paid + burned.
        (uint256 claimed, uint256 burned) = s.totals();
        uint256 balance = w.token().balanceOf(address(s));
        assertEq(balance + claimed + burned, _received(), "T in = held + paid + burned");
        // Every slot's accrual is booked to an owner or waits on an open ticket, exactly (J units).
        uint256 j = s.index();
        (uint256 p, uint256 d, uint256 sum) = s.openTickets();
        assertEq(p, openPlaceholders, "open placeholders");
        assertEq(d, drawers.length, "open draws");
        assertEq(s.liabilities(), owed + p * j + (d * j - sum), "liabilities: owners' booked + open tickets'");
        // After the last batch and a burn: the owners are covered, and only the per-slot margin stays unburned.
        assertGe(balance, s.liabilities(), "owners covered");
        assertLe(balance - s.liabilities(), s.outsideCount(), "only the margin of one raw unit per outside slot");
        // The burn is the items-inside share (per swap), less the owners' floors and the margin.
        uint256 insideWant = insideRef / scale;
        assertApproxEqAbs(burned, insideWant, events * perInterval + 2 * n + 30, "burned = the inside share");
    }

    function _received() internal view returns (uint256) {
        return minted;
    }

    function _rand(uint256 seed, uint256 i) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed, i)));
    }
}
