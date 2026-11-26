// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {DrawStatus, TicketPhase} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {IDrandSource} from "../../../../src/box/interfaces/IDrandSource.sol";
import {BoxShuffle} from "../../../../src/box/libraries/BoxShuffle.sol";
import {BackedSourcePins} from "../../../../src/box/randomness/BackedSourcePins.sol";
import {AuditU6FableBase} from "./AuditU6FableBase.sol";

/// @notice SH-AUDIT-B0 U6 (Fable): L4 randomness and fairness (P6.9, P6.10, P6.11), L5 gas, liveness and bounded cost
/// (P6.12, P6.13) and L8 deployment (P6.17), on the factory's box 0 with the real sources. Draws requested in one
/// block share one quicknet round, so a single post (committed rounds r0 + 4, r0 + 8, r0 + 12) or a single backup
/// gives every draw of that block its own word.
/// forge-config: default.evm_version = "osaka"
contract AuditU6FableFairnessTest is AuditU6FableBase {
    bytes32 internal constant MIX = keccak256("audit.u6.fable fairness mix");

    function setUp() public virtual override {
        super.setUp();
        _buildRevealCache();
    }

    // ================================================================================================ P6.9 order

    /// P6.9 (ADR-0013 § 3.3 rule 2, § 9 rows 9 and 17; BoxTickets.sol:581-608): draws settle strictly in request order:
    /// with the words of draws 2 and 3 posted and draw 1's not, nothing settles and draw 2 cannot be opened; once
    /// draw 1's word is posted, settle(1) settles exactly draw 1, then the rest follow in order.
    function testProperty_AUDIT_U6_drawsSettleStrictlyInRequestOrder() public {
        _toWordAccepted();
        uint256 d1 = _draw(eoa[3], AUDIT_DRAW_VALUE); // r0 + 4
        _advance(1);
        uint256 d2 = _draw(eoa[4], AUDIT_DRAW_VALUE); // r0 + 8
        _advance(1);
        uint256 d3 = _draw(eoa[5], AUDIT_DRAW_VALUE); // r0 + 12
        assertEq(_roundOf(d1), r0 + 4);
        assertEq(_roundOf(d2), r0 + 8);
        assertEq(_roundOf(d3), r0 + 12);
        _advance(1);
        _post(r0 + 8);
        _post(r0 + 12);
        assertTrue(_refUsable(d2, _dv(d2).requestedAt) && _refUsable(d3, _dv(d3).requestedAt));
        vm.expectRevert(IBoxTickets.NothingSettled.selector);
        tickets.settle(3);
        vm.prank(eoa[4]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.NotSettled.selector, d2));
        tickets.openDraw(d2, address(0), _noReveal());
        assertEq(uint8(_dv(d2).status), uint8(DrawStatus.Requested));
        _post(r0 + 4);
        assertEq(_settle(keeper, 1), 1);
        assertEq(_st().drawsSettled, d1);
        assertEq(uint8(_dv(d1).status), uint8(DrawStatus.Settled));
        assertEq(uint8(_dv(d2).status), uint8(DrawStatus.Requested));
        assertEq(_settle(keeper, 10), 2);
        assertEq(_st().drawsSettled, d3);
        // openDraw settles the queue up to its ticket when needed: a fourth draw, posted, opened without a settle call.
        uint256 d4 = _draw(eoa[3], AUDIT_DRAW_VALUE); // r0 + 16: silent
        _silentBackup(_roundOf(d4), MIX, eoa[5]);
        uint256 snap = vm.snapshotState();
        _settle(keeper, 1);
        uint256 want = _dv(d4).itemId;
        vm.revertToState(snap);
        assertEq(uint8(_dv(d4).status), uint8(DrawStatus.Requested));
        vm.prank(eoa[3]);
        uint256 item = tickets.openDraw(d4, eoa[3], _rv(want));
        assertEq(item, want, "openDraw settled the ticket itself and delivered the same item");
        assertEq(collection.ownerOf(item), eoa[3]);
        assertEq(uint8(_dv(d4).status), uint8(DrawStatus.Opened));
        assertEq(_st().drawsSettled, d4, "openDraw settled the queue up to its ticket");
        _assertGhostLedger();
    }

    /// P6.9: a draw's item is a function of its own word, its queue position and the words of the draws before it
    /// (the lazy Fisher-Yates over the pool mapped through π_w), all fixed by the beacon before anyone can act: no call
    /// between request and settlement (placeholder opens and transfers, fee intake, bounties, time, other draws' opens)
    /// changes it, and settling one at a time or all at once gives the same items.
    function testProperty_AUDIT_U6_drawItemIndependentOfInterleavedCalls() public {
        _toWordAccepted();
        uint256 first = _drawMany(eoa[3], 3, AUDIT_DRAW_VALUE); // r0 + 4, three draws
        _advance(1);
        uint256 fourth = _draw(eoa[4], AUDIT_DRAW_VALUE); // r0 + 8
        _post(r0 + 4);
        _advance(1);
        _post(r0 + 8);
        uint256 snap = vm.snapshotState();
        // Path A: settle everything now.
        assertEq(_settle(keeper, 10), 4);
        uint256[4] memory itemsA = [_dv(first).itemId, _dv(first + 1).itemId, _dv(first + 2).itemId, _dv(fourth).itemId];
        vm.revertToState(snap);
        // Path B: interleave unrelated calls, then settle one by one with more calls in between.
        _open(eoa[0], 2, true);
        vm.prank(eoa[1]);
        tickets.transferFrom(eoa[1], eoa[5], 4);
        _fundFees(eoa[7], 1 ether);
        _addBounty(eoa[7], r0 + 20, 0.01 ether, true);
        _advance(100);
        assertEq(_settle(keeper, 1), 1);
        _open(eoa[0], 3, true);
        _openDraw(eoa[3], first, eoa[7], true);
        _advance(7_000);
        assertEq(_settle(keeper, 1), 1);
        _addBounty(eoa[7], r0 + 24, 0.02 ether, false);
        assertEq(_settle(keeper, 2), 2);
        uint256[4] memory itemsB = [_dv(first).itemId, _dv(first + 1).itemId, _dv(first + 2).itemId, _dv(fourth).itemId];
        for (uint256 i; i < 4; ++i) {
            assertEq(itemsB[i], itemsA[i], "the same item whatever happened in between");
        }
        _assertGhostLedger();
    }

    /// P6.9 / P6.10 (BoxShuffle.sol:14-16; BoxTickets.sol:639-651): every settled draw's item equals firstId +
    /// π_w(position) where position comes from a lazy Fisher-Yates over [q, N) indexed by keccak256(word ‖ id) mod R,
    /// recomputed here from the source's words; the pool view agrees at every step; items are distinct and never a
    /// placeholder's number.
    function testProperty_AUDIT_U6_drawItemsFollowTheReferenceShuffle() public {
        _toWordAccepted();
        uint256 q = _st().slots;
        uint256 first = _drawMany(eoa[3], 4, AUDIT_DRAW_VALUE);
        _advance(1);
        _post(r0 + 4);
        uint256 more = _drawMany(eoa[4], 2, AUDIT_DRAW_VALUE);
        _advance(1);
        _post(r0 + 8);
        // Reference pool: positions q … N − 1 in order (the contract's lazy array starts as the identity).
        uint256 left = editionSize - q;
        uint256[] memory pool = new uint256[](left);
        for (uint256 i; i < left; ++i) {
            pool[i] = q + i;
        }
        uint256[] memory numbers = new uint256[](q);
        for (uint256 slot; slot < q; ++slot) {
            numbers[slot] = _itemAtPosition(slot);
        }
        uint256[] memory items = new uint256[](6);
        for (uint256 id = first; id < more + 2; ++id) {
            assertEq(_settle(keeper, 1), 1);
            (bytes32 word,) = src.wordOf(a.tickets, id);
            uint256 index = BoxShuffle.pickIndex(word, id, left);
            uint256 position = pool[index];
            pool[index] = pool[left - 1];
            --left;
            uint256 want = _itemAtPosition(position);
            uint256 got = _dv(id).itemId;
            assertEq(got, want, "item = firstId + permute(position taken by the reference Fisher-Yates)");
            assertEq(_left(), left, "R");
            for (uint256 i; i < left; ++i) {
                assertEq(tickets.poolPositionAt(i), pool[i], "the pool view is the reference array");
            }
            items[id - first] = got;
            for (uint256 k; k < id - first; ++k) {
                assertTrue(items[k] != got, "distinct items");
            }
            for (uint256 slot; slot < q; ++slot) {
                assertTrue(numbers[slot] != got, "never a placeholder's number");
            }
            assertEq(collection.ownerOf(got), a.vault, "hidden in the vault until opened");
            assertTrue(vault.isHidden(got));
        }
        _assertGhostLedger();
    }

    // ================================================================================================ P6.10 shuffle

    /// P6.10 (BoxShuffle.sol:8-14): for every q from 1 to 10,000, π_key is a permutation of [0, q): sampled x < q map
    /// below q and invert back to x (a left inverse on a finite set makes the map a bijection); exhaustively for q ≤ 64.
    function testFuzz_AUDIT_U6_shuffleIsABijection(uint16 qSeed, bytes32 key, uint256 xSeed) public pure {
        uint256 q = 1 + uint256(qSeed) % 10_000;
        (uint256 u, uint256 v) = BoxShuffle.halves(q);
        uint256 samples = q <= 64 ? q : 48;
        for (uint256 i; i < samples; ++i) {
            uint256 x = q <= 64 ? i : uint256(keccak256(abi.encode(xSeed, i))) % q;
            uint256 y = BoxShuffle.permute(key, x, q, u, v);
            assertLt(y, q, "into [0, q)");
            assertEq(BoxShuffle.invert(key, y, q, u, v), x, "the inverse walks back");
        }
    }

    /// P6.10 exhaustively: q = 1 … 64, 1,969 (mainnet's N, F141), 4,269 (the Sepolia test set) and 10,000 (the spec's
    /// MAX_N), with three keys (zero, all ones, a hash): every x < q lands on a distinct y < q and inverts back.
    function testProperty_AUDIT_U6_shuffleBijectionExhaustive() public pure {
        bytes32[3] memory keys = [bytes32(0), bytes32(type(uint256).max), keccak256("audit.u6.fable shuffle key")];
        for (uint256 k; k < keys.length; ++k) {
            for (uint256 q = 1; q <= 64; ++q) {
                _checkBijection(keys[k], q);
            }
            _checkBijection(keys[k], 1_969);
        }
        _checkBijection(keys[2], 4_269);
        _checkBijection(keys[2], BoxSpecV1.MAX_N);
        assertEq(BoxSpecV1.MAX_N, 10_000);
    }

    function _checkBijection(bytes32 key, uint256 q) internal pure {
        (uint256 u, uint256 v) = BoxShuffle.halves(q);
        bool[] memory seen = new bool[](q);
        for (uint256 x; x < q; ++x) {
            uint256 y = BoxShuffle.permute(key, x, q, u, v);
            assertLt(y, q);
            assertFalse(seen[y], "distinct");
            seen[y] = true;
            assertEq(BoxShuffle.invert(key, y, q, u, v), x);
        }
    }

    /// P6.10 (BoxShuffle.sol:29-38): the Feistel halves are b = max(2, ⌈log₂ n⌉) split u = ⌊b/2⌋, v = b − u, so every
    /// N the spec allows fits one word per half; n = 0 is refused.
    function testProperty_AUDIT_U6_shuffleHalves() public {
        (uint256 u, uint256 v) = BoxShuffle.halves(1_969);
        assertEq(u + v, 11, "2^11 = 2,048 covers 1,969");
        assertEq(u, 5);
        (u, v) = BoxShuffle.halves(4_269);
        assertEq(u + v, 13);
        (u, v) = BoxShuffle.halves(1);
        assertEq(u + v, 2, "at least 2 bits");
        (u, v) = BoxShuffle.halves(1_024);
        assertEq(u + v, 10, "an exact power of two needs no extra bit");
        (u, v) = BoxShuffle.halves(1_025);
        assertEq(u + v, 11);
        vm.expectRevert(BoxShuffle.EmptyDomain.selector);
        this.halvesOf(0);
    }

    function halvesOf(uint256 n) external pure returns (uint256, uint256) {
        return BoxShuffle.halves(n);
    }

    // ================================================================================================ P6.11 requests

    /// P6.11 (DrandSource.sol:18-23, 90-99; F54): a draw's round is fixed in its own block, at least MARGIN = 12 s
    /// ahead and strictly later than the block, and never changes; two draws of one block share it; the graduation
    /// word is stored once from the request's round.
    function testProperty_AUDIT_U6_roundFixedAtRequestTwelveSecondsAhead() public {
        _toWordAccepted();
        uint256 now_ = vm.getBlockTimestamp();
        uint256 d1 = _draw(eoa[3], AUDIT_DRAW_VALUE);
        uint256 round = _roundOf(d1);
        assertEq(_requestedAtOf(d1), now_);
        assertGe(src.roundTime(round), now_ + drand.MARGIN(), "at least 12 s ahead");
        assertEq(round, src.roundAt(now_ + 12));
        assertLt(src.roundTime(round - 1), now_ + 12, "the first such round");
        uint256 d2 = _draw(eoa[4], AUDIT_DRAW_VALUE);
        assertEq(_roundOf(d2), round, "one block, one round");
        vm.warp(now_ + 1);
        vm.roll(vm.getBlockNumber() + 1);
        uint256 d3 = _draw(eoa[5], AUDIT_DRAW_VALUE);
        assertGe(_roundOf(d3), round);
        _advance(10);
        assertEq(_roundOf(d1), round, "fixed for good");
        assertEq(_requestedAtOf(d1), now_);
        // The graduation word: stored once, from round r0.
        assertEq(_roundOf(0), r0);
        (bytes32 randomness,) = drand.beaconOf(r0);
        assertEq(tickets.graduationWord(), _word(src.DRAND_TAG(), randomness, 0));
        vm.expectRevert(IBoxTickets.WordAlreadyAccepted.selector);
        tickets.acceptGraduationWord();
        _assertGhostLedger();
    }

    /// P6.11 / BC-053: one word per (consumer, key): the words of draws sharing a round differ from each other and
    /// from the graduation word, and a draw's word stays what it was once read.
    function testProperty_AUDIT_U6_wordsAreDomainSeparatedPerKey() public {
        _toWordAccepted();
        uint256 first = _drawMany(eoa[3], 3, AUDIT_DRAW_VALUE);
        _advance(1);
        _post(r0 + 4);
        (bytes32 randomness,) = drand.beaconOf(r0 + 4);
        bytes32[3] memory words;
        for (uint256 i; i < 3; ++i) {
            (words[i],) = src.wordOf(a.tickets, first + i);
            assertEq(words[i], _word(src.DRAND_TAG(), randomness, first + i), "keccak(tag, randomness, (tickets, key))");
            for (uint256 k; k < i; ++k) {
                assertTrue(words[i] != words[k], "distinct per key");
            }
            assertTrue(words[i] != tickets.graduationWord());
        }
        _settle(keeper, 3);
        _advance(1_000);
        for (uint256 i; i < 3; ++i) {
            (bytes32 w,) = src.wordOf(a.tickets, first + i);
            assertEq(w, words[i], "immutable");
        }
    }

    // ================================================================================================ P6.12 liveness

    /// P6.12 (BC-051; F61 R4; F143): with drand silent, every draw is settled, opened or cancellable within 7 days plus
    /// a bounded number of public calls: (a) the backup path, 3 calls for a round of three draws (start, fix, settle);
    /// (b) nobody runs the backup: at 7 days + 1 s one `enterTerminal` and one `cancelDraw` per draw; (c) mixed: a
    /// backup for the first round only, then the next head dies and terminal mode frees the rest.
    function testProperty_AUDIT_U6_neverStuckWithinSevenDaysAndBoundedCalls() public {
        _toDrawing();
        _advance(1);
        uint256 first = _drawMany(eoa[3], 3, AUDIT_DRAW_VALUE); // one silent round
        uint256 roundA = _roundOf(first);
        _advance(1);
        uint256 fourth = _draw(eoa[4], AUDIT_DRAW_VALUE); // another silent round
        uint256 roundB = _roundOf(fourth);
        assertTrue(roundB > roundA && !_committed(roundA) && !_committed(roundB));
        uint256 snap = vm.snapshotState();

        // (a) three public calls settle the first round's three draws; three more the fourth.
        _silentBackup(roundA, MIX, eoa[5]);
        assertEq(_settle(eoa[7], 10), 3, "start, fix, settle: all three settled");
        _silentBackup(roundB, keccak256("second"), eoa[6]);
        assertEq(_settle(eoa[7], 10), 1);
        for (uint256 i; i < 4; ++i) {
            uint256 id = i < 3 ? first + i : fourth;
            assertEq(uint8(_dv(id).status), uint8(DrawStatus.Settled));
            uint256 item = _openDraw(_dv(id).drawer, id, address(0), true);
            assertEq(collection.ownerOf(item), _dv(id).drawer);
        }
        vm.expectRevert(IBoxTickets.NothingPending.selector);
        tickets.enterTerminal();
        vm.revertToState(snap);

        // (b) nobody acts: 7 days + 1 s after the head's request, terminal mode and one cancel per draw.
        _warpTo(uint256(_dv(first).requestedAt) + SILENCE + 1);
        vm.prank(eoa[7]);
        tickets.enterTerminal();
        for (uint256 i; i < 4; ++i) {
            uint256 id = i < 3 ? first + i : fourth;
            assertGt(_cancelDraw(eoa[7], id), 0);
            assertEq(uint8(_dv(id).status), uint8(DrawStatus.Cancelled));
        }
        assertEq(vault.pendingTickets(), 5, "placeholders 2-5 and draw B: no draw ticket left pending");
        vm.revertToState(snap);

        // (c) the first round saved, the second not: its head dies at its own 7 days, terminal frees it.
        _silentBackup(roundA, MIX, eoa[5]);
        assertEq(_settle(eoa[7], 10), 3);
        _warpTo(uint256(_dv(fourth).requestedAt) + SILENCE);
        (bool exists, bool dead, uint256 key,) = _refHead();
        assertTrue(exists && !dead && key == fourth, "at exactly 7 days the head still lives");
        vm.expectRevert();
        tickets.enterTerminal();
        _warpTo(vm.getBlockTimestamp() + 1);
        vm.prank(eoa[7]);
        tickets.enterTerminal();
        assertGt(_cancelDraw(eoa[7], fourth), 0);
        for (uint256 i; i < 3; ++i) {
            uint256 item = _openDraw(eoa[7], first + i, eoa[7], true);
            assertEq(collection.ownerOf(item), eoa[3], "settled draws open in terminal mode, to the drawer");
        }
        _assertGhostLedger();
    }

    /// P6.12: a head whose word is usable but unapplied is never "dead": `enterTerminal` is refused until someone
    /// settles it, and the following dead head then opens terminal mode (bounded: one settle, one enter).
    function testProperty_AUDIT_U6_liveHeadMustBeSettledBeforeTerminal() public {
        _toWordAccepted();
        uint256 d1 = _draw(eoa[3], AUDIT_DRAW_VALUE); // r0 + 4
        _advance(1);
        uint256 d2 = _draw(eoa[4], AUDIT_DRAW_VALUE); // r0 + 8, never posted
        _post(r0 + 4);
        _warpTo(uint256(_dv(d2).requestedAt) + SILENCE + 1);
        (, bool dead, uint256 key, uint256 deadline) = _refHead();
        assertTrue(!dead && key == d1, "the head's word is usable: alive");
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.HeadNotDead.selector, d1, deadline));
        tickets.enterTerminal();
        assertEq(_settle(keeper, 1), 1);
        (, dead, key,) = _refHead();
        assertTrue(dead && key == d2);
        tickets.enterTerminal();
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Terminal));
    }

    /// P6.12: a late drand post (after the 7 days) does not revive a dead draw head: the word is unusable, the draw is
    /// refused `QueueDead` and terminal entry stays open (the dead state of a requested key is final).
    function testProperty_AUDIT_U6_latePostDoesNotReviveADeadDrawHead() public {
        _toWordAccepted();
        uint256 d1 = _draw(eoa[3], AUDIT_DRAW_VALUE); // r0 + 4
        uint256 deadline = uint256(_dv(d1).requestedAt) + SILENCE;
        _warpTo(deadline + 1);
        _post(r0 + 4);
        assertFalse(_refUsable(d1, _dv(d1).requestedAt), "posted a second late: unusable");
        (, bool dead,,) = _refHead();
        assertTrue(dead);
        vm.expectRevert(IBoxTickets.NothingSettled.selector);
        tickets.settle(1);
        _approveT(eoa[4], a.tickets);
        uint256 t = vm.getBlockTimestamp();
        vm.prank(eoa[4]);
        vm.expectRevert(abi.encodeWithSelector(IBoxTickets.QueueDead.selector, d1, deadline));
        tickets.draw(type(uint256).max, t);
        _warpTo(t + 30 days);
        (, dead,,) = _refHead();
        assertTrue(dead, "still dead a month later");
        tickets.enterTerminal();
    }

    // ================================================================================================ P6.13 gas

    /// P6.13: `settle(k)` grows linearly in k; the slope and intercept are measured on both EVMs (the variant below),
    /// with k draws of one backed round; `draw` and `openDraw` with the reveal are bounded (measured, logged).
    function testProperty_AUDIT_U6_settleGasLinearInK() public {
        _toDrawing();
        _advance(1);
        uint256 first = _drawMany(eoa[3], 8, AUDIT_DRAW_VALUE);
        _silentBackup(_roundOf(first), MIX, eoa[5]);
        uint256 snap = vm.snapshotState();
        uint256[8] memory gas;
        for (uint256 k = 1; k <= 8; ++k) {
            vm.revertToState(snap);
            vm.prank(keeper);
            uint256 g0 = gasleft();
            tickets.settle(k);
            gas[k - 1] = g0 - gasleft();
        }
        uint256 slope = (gas[7] - gas[0]) / 7;
        uint256 intercept = gas[0] - slope;
        emit log_named_string("evm", _evm());
        emit log_named_uint("settle(1) gas", gas[0]);
        emit log_named_uint("settle(8) gas", gas[7]);
        emit log_named_uint("slope per draw", slope);
        emit log_named_uint("intercept", intercept);
        for (uint256 k = 2; k <= 8; ++k) {
            uint256 expected = intercept + slope * k;
            uint256 diff = gas[k - 1] > expected ? gas[k - 1] - expected : expected - gas[k - 1];
            assertLe(diff, 6_000, "linear within 6,000 gas");
        }
        assertLe(slope, _isAmsterdam() ? 150_000 : 60_000, "slope per settled draw");
        assertLe(gas[0], _isAmsterdam() ? 250_000 : 120_000, "settle(1)");
        // draw and openDraw with the reveal.
        vm.revertToState(snap);
        _settle(keeper, 8);
        _advance(1);
        _prepareDraw(eoa[4], AUDIT_DRAW_VALUE);
        uint256 t = vm.getBlockTimestamp();
        vm.prank(eoa[4]);
        uint256 g1 = gasleft();
        tickets.draw{value: AUDIT_DRAW_VALUE}(type(uint256).max, t);
        uint256 drawGas = g1 - gasleft();
        emit log_named_uint("draw gas (later draw of a funded round)", drawGas);
        assertLe(drawGas, _isAmsterdam() ? 900_000 : 600_000, "draw (includes the vault's observer call)");
        uint256 item = _dv(first).itemId;
        vm.prank(eoa[3]);
        g1 = gasleft();
        tickets.openDraw(first, address(0), _rv(item));
        uint256 openGas = g1 - gasleft();
        emit log_named_uint("openDraw gas with the reveal", openGas);
        assertLe(
            openGas, _isAmsterdam() ? 1_500_000 : 1_000_000, "openDraw (the collection's reveal and observer included)"
        );
    }

    /// P6.13 (BC-069; EIP-170): the tickets implementation's runtime stays at least 1,000 bytes under 24,576.
    function testProperty_AUDIT_U6_ticketsCodeBelowEip170ByAThousandBytes() public {
        uint256 size = _ticketsImpl().code.length;
        emit log_named_uint("BoxTickets runtime bytes", size);
        emit log_named_uint("margin under EIP-170", EIP170 - size);
        assertLe(size, EIP170 - 1_000);
        assertGt(size, 20_000, "the real implementation, not a stub");
    }

    // ================================================================================================ P6.17 deployment

    /// P6.17 (BoxTickets.sol:121-124; IBoxTickets.sol:136-139; F80): `initialize` stored the hook's open time (the spec's
    /// clock time, here an hour after creation) and the pinned BoxBackedSource; the clone arguments name box 0's
    /// contracts and the mainnet edition.
    function testProperty_AUDIT_U6_initializeOpenTimeAndPinnedSource() public view {
        assertEq(tickets.openAt(), hook.openAt(), "the hook's rule");
        assertEq(tickets.openAt(), createdAt + AUDIT_OPEN_DELAY);
        assertEq(tickets.source(), BackedSourcePins.ADDRESS_MAINNET, "the pinned BoxBackedSource (F143)");
        assertEq(tickets.source(), coordinator.randomness());
        assertEq(tickets.coordinator(), a.coordinator);
        assertEq(tickets.vault(), a.vault);
        assertEq(tickets.collection(), a.collection);
        assertEq(tickets.token(), a.token);
        assertEq(tickets.collectionSize(), 1_969);
        assertEq(tickets.firstId(), 1);
        assertEq(token.allowance(a.tickets, a.vault), type(uint256).max, "the vault may pull from the adapter");
        assertEq(tickets.SILENCE(), SILENCE);
        assertEq(tickets.SILENCE_UNREQUESTED(), SILENCE_UNREQUESTED);
        assertEq(tickets.REVEAL_GRACE(), REVEAL_GRACE);
        assertEq(tickets.TAKE_DELAY(), TAKE_DELAY);
        assertEq(tickets.RETURN_GRACE(), RETURN_GRACE);
        assertEq(BoxSpecV1.DRAND_BOUNTY_GAS, 600_000);
    }
}

/// The same under Amsterdam (settle's slope and intercept differ: logged by the gas test).
/// forge-config: default.evm_version = "amsterdam"
contract AuditU6FableFairnessAmsterdamTest is AuditU6FableFairnessTest {}

/// P6.10 (BoxTickets.sol:639-651): the lazy Fisher-Yates returns each remaining pool position exactly once, to the end
/// of the pool: on a 16-item edition (the spec's minimum is 10) with 5 placeholders, the ten draws that empty the pool
/// down to the last item (F23 C2) deliver ten distinct items covering every pool position but one, in the reference
/// order, and the eleventh draw is refused by the vault. The drawer's T comes from `deal` (adjusting the supply: with
/// the lock/release prices proportional to A, draining the vault needs almost all T outside it; harness only).
/// forge-config: default.evm_version = "osaka"
contract AuditU6FableSmallEditionTest is AuditU6FableBase {
    bytes32 internal constant MIX = keccak256("audit.u6.fable small mix");

    function _auditN() internal pure override returns (uint256) {
        return 16;
    }

    /// @dev The fixture's edition specials (add-on 3) name counts above 16: capped to N (field 302's rule), nothing
    /// else changes.
    function _auditSpec() internal view override returns (BoxSpecV1.BoxSpec memory s) {
        s = super._auditSpec();
        for (uint256 i; i < s.addOns.length; ++i) {
            if (s.addOns[i].id != BoxSpecV1.ADD_ON_EDITION_SPECIALS) continue;
            (string memory label, uint32 count) = abi.decode(s.addOns[i].params, (string, uint32));
            if (count > s.n) s.addOns[i].params = abi.encode(label, uint32(s.n));
        }
    }

    function setUp() public override {
        super.setUp();
        _buildRevealCache();
    }

    function testProperty_AUDIT_U6_lazyFisherYatesEmptiesThePoolOnce() public {
        _toWordAccepted();
        uint256 q = _st().slots;
        assertEq(q, 5);
        assertEq(editionSize, 16);
        uint256 poolSize = editionSize - q; // 11 positions; 10 drawable (the last item stays)
        deal(a.token, eoa[3], 1e33, true);
        _approveT(eoa[3], a.tickets);
        uint256 first;
        for (uint256 i; i < poolSize - 1; ++i) {
            _fund(eoa[3], AUDIT_DRAW_VALUE);
            uint256 t = vm.getBlockTimestamp();
            vm.prank(eoa[3]);
            uint256 id = tickets.draw{value: AUDIT_DRAW_VALUE}(type(uint256).max, t);
            if (i == 0) first = id;
        }
        _fund(eoa[3], AUDIT_DRAW_VALUE);
        uint256 t2 = vm.getBlockTimestamp();
        vm.prank(eoa[3]);
        vm.expectRevert(); // LastItem: the vault keeps one
        tickets.draw{value: AUDIT_DRAW_VALUE}(type(uint256).max, t2);
        _advance(1);
        _post(r0 + 4);
        // Reference lazy Fisher-Yates.
        uint256 left = poolSize;
        uint256[] memory pool = new uint256[](left);
        for (uint256 i; i < left; ++i) {
            pool[i] = q + i;
        }
        bool[] memory taken = new bool[](editionSize);
        for (uint256 id = first; id < first + poolSize - 1; ++id) {
            assertEq(_settle(keeper, 1), 1);
            (bytes32 word,) = src.wordOf(a.tickets, id);
            uint256 index = BoxShuffle.pickIndex(word, id, left);
            uint256 position = pool[index];
            pool[index] = pool[left - 1];
            --left;
            assertEq(_dv(id).itemId, _itemAtPosition(position), "the reference position's item");
            assertFalse(taken[position], "each position once");
            taken[position] = true;
            assertGe(position, q, "never a placeholder slot");
        }
        assertEq(left, 1, "one position left");
        assertEq(tickets.poolPositionAt(0), pool[0], "the pool view holds the last position");
        uint256 untaken;
        for (uint256 p = q; p < editionSize; ++p) {
            if (!taken[p]) ++untaken;
        }
        assertEq(untaken, 1, "every pool position but one was drawn");
        assertEq(_left(), 1);
        assertEq(vault.inside(), 1, "the last item stays");
        vm.expectRevert(IBoxTickets.NothingSettled.selector);
        tickets.settle(1);
    }
}
