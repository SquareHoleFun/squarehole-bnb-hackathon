// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {TicketPhase} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IDrandSource} from "../../../../src/box/interfaces/IDrandSource.sol";
import {BoxBackedSource} from "../../../../src/box/randomness/BoxBackedSource.sol";
import {DrandWords} from "../../../../src/box/randomness/DrandWords.sol";
import {HeaderVectors} from "../../backup/HeaderVectors.sol";
import {AuditHeaders} from "../common/AuditHeaders.sol";
import {AuditU8FableBase, AuditU8FableWordsConsumer} from "./AuditU8FableBase.sol";

/// @title AuditU8FableBackupTest (SH-AUDIT-B0-U8-F, lenses L4, L5 and L6 on the backup and the reads)
/// @notice Box 0's backed source in the shared world with drand silent: words never change once non-zero under any
/// order of post, start and fix; a drand post after a start is ignored for good; one target per round; the starter,
/// drawer and fixer cannot choose the word, which for a fixed target is a function of that block's prevRandao and the
/// request id only (BoxBackedSource.sol:7-54, F143 DECISION-LOG.md:158, ADR-0013 § 3.3 rule 3 amendment, BC-053,
/// X11); `wordOf` within the consumers' 50,000 gas in every state on three EVMs and `GasTooLow` for a starved
/// consumer (DrandWords.sol:23-31, :113-130; BoxTickets.sol:82-84); the timeline at 12-second and 6-second blocks
/// (BoxBackedSource.sol:38-41, BoxSpecV1.sol:170-182); EIP-2935 absent or outside its window (:254-260). The header
/// shapes and malformed encodings are in `AuditU8FableHeadersTest` below.
/// forge-config: default.evm_version = "osaka"
contract AuditU8FableBackupTest is AuditU8FableBase {
    /// @dev Back to a snapshot with its clock (the block number and time are set again explicitly).
    function _back(uint256 snap, uint256 t0, uint256 b0) internal {
        vm.revertToState(snap);
        vm.warp(t0);
        vm.roll(b0);
    }

    // ------------------------------------------------------------------------------------------------ L4 P8.6

    /// P8.6: with the graduation word's round silent (r0 unposted, the clock where its backup may start), every order
    /// of post, start and fix leaves each key's word unchanged once non-zero: post first (a start is then refused);
    /// start, post (ignored), fix; start, fix, post (ignored); start and never fix (no word, ever). The tickets store
    /// exactly the word the source shows.
    bytes32 internal mixA;
    bytes32 internal drandWordA;
    bytes32 internal backupWordA;

    function testProperty_AUDIT_U8_wordsNeverChangeUnderEveryOrderOfPostStartAndFix() public {
        _toSilentFromGraduation();
        mixA = keccak256("audit.u8.order.mix");
        drandWordA = _word(src.DRAND_TAG(), _boxDrand(r0).randomness, 0);
        backupWordA = _word(src.BACKUP_TAG(), mixA, 0);
        uint256 snap = vm.snapshotState();
        uint256 t0 = vm.getBlockTimestamp();
        uint256 b0 = vm.getBlockNumber();
        _orderPostThenStartRefused();
        _back(snap, t0, b0);
        _orderStartPostFix();
        _back(snap, t0, b0);
        _orderStartFixPost();
        _back(snap, t0, b0);
        _orderStartNeverFix();
        _back(snap, t0, b0);
    }

    /// Order A: post, then a start is refused; the word is drand's and stays.
    function _orderPostThenStartRefused() internal {
        _post(r0);
        (bytes32 w, uint64 at) = src.wordOf(a.tickets, 0);
        assertEq(w, drandWordA);
        assertEq(at, uint64(vm.getBlockTimestamp()));
        (bool ok, bytes memory ret) = _tryStart(r0, vm.getBlockNumber() - 1, _parentHeader(), eoa[1]);
        assertFalse(ok);
        assertEq(_sel(ret), BoxBackedSource.RoundAlreadyPosted.selector);
        _advance(300);
        (bytes32 w2, uint64 at2) = src.wordOf(a.tickets, 0);
        assertEq(w2, w);
        assertEq(at2, at);
        vm.prank(keeper);
        tickets.acceptGraduationWord();
        assertEq(tickets.graduationWord(), drandWordA, "the tickets store drand's word");
    }

    /// Order B: start, post (ignored, the pot still paid: F7, recorded), fix: the backup word, then stays.
    function _orderStartPostFix() internal {
        uint256 target = _startBackup(r0, eoa[1]);
        (bytes32 w, uint64 at) = src.wordOf(a.tickets, 0);
        assertEq(w, bytes32(0), "no word after the start");
        assertEq(at, 0);
        _advance(1);
        _post(r0);
        (w, at) = src.wordOf(a.tickets, 0);
        assertEq(w, bytes32(0), "the post is ignored");
        assertEq(at, 0);
        (bytes32 seen, uint64 postedAt) = drand.beaconOf(r0);
        assertEq(seen, _boxDrand(r0).randomness, "drand's round is known on the DrandSource");
        assertGt(postedAt, 0);
        _advance(src.TARGET_BLOCKS());
        _fixBackup(r0, mixA, eoa[2]);
        (w, at) = src.wordOf(a.tickets, 0);
        assertEq(w, backupWordA);
        assertEq(at, uint64(vm.getBlockTimestamp()));
        (bool ok, bytes memory ret) = _tryStart(r0, vm.getBlockNumber() - 1, _parentHeader(), eoa[1]);
        assertFalse(ok);
        assertEq(_sel(ret), BoxBackedSource.BackupAlreadyStarted.selector, "no second target");
        (ok, ret) = _tryFix(r0, AuditHeaders.header(target, keccak256("other")), eoa[3]);
        assertEq(_sel(ret), BoxBackedSource.BackupAlreadyFixed.selector, "no second fix");
        _advance(9_000);
        (bytes32 w2, uint64 at2) = src.wordOf(a.tickets, 0);
        assertEq(w2, w);
        assertEq(at2, at);
        vm.prank(keeper);
        tickets.acceptGraduationWord();
        assertEq(tickets.graduationWord(), backupWordA, "the tickets store the backup word");
    }

    /// Order C: start, fix, post (ignored): the backup word stays.
    function _orderStartFixPost() internal {
        _backup(r0, mixA, eoa[4]);
        (bytes32 w, uint64 at) = src.wordOf(a.tickets, 0);
        assertEq(w, backupWordA);
        _post(r0);
        (bytes32 w2, uint64 at2) = src.wordOf(a.tickets, 0);
        assertEq(w2, backupWordA, "a post after the fix changes nothing");
        assertEq(at2, at);
    }

    /// Order D: start and never fix: no word within the window, none after, the post ignored, silence at 7 days.
    function _orderStartNeverFix() internal {
        _startBackup(r0, eoa[5]);
        _advance(src.TARGET_BLOCKS() + src.HISTORY_WINDOW() + 1);
        (bytes32 w,) = src.wordOf(a.tickets, 0);
        assertEq(w, bytes32(0));
        _post(r0);
        (w,) = src.wordOf(a.tickets, 0);
        assertEq(w, bytes32(0), "drand's late post cannot fill the gap");
        uint256 requestedAt = tickets.status().wordRequestedAt;
        _warpTo(requestedAt + src.SILENCE() + 1);
        assertTrue(src.isSilent(a.tickets, 0), "silent for good");
        vm.prank(eoa[5]);
        tickets.enterTerminal();
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Terminal));
    }

    /// P8.6: a backup target is set once per round and never re-set; the draw's word is a function of the target's
    /// prevRandao and its own id only: a forged header is refused, every fixer gets the same word, and the same
    /// prevRandao at another target (another start block, another starter, another fixer, another time) gives the
    /// same word: the start block, the starter, the fixer and the fix time do not enter it.
    bytes32 internal mixB;
    bytes32 internal expectedDrawB;

    function testProperty_AUDIT_U8_oneTargetPerRoundAndTheWordIsAFunctionOfPrevRandaoOnly() public {
        _toSilent();
        (, uint64 r2) = src.requestOf(a.tickets, drawC);
        assertEq(r2, silentRound);
        // Written before the snapshot: a snapshot revert takes this contract's storage back with the chain's.
        mixB = keccak256("audit.u8.randao");
        expectedDrawB = _word(src.BACKUP_TAG(), mixB, drawC);
        uint256 snap = vm.snapshotState();
        uint256 t0 = vm.getBlockTimestamp();
        uint256 b0 = vm.getBlockNumber();
        (uint256 target1, uint64 at1) = _drawerStartsAndCannotForge();
        _back(snap, t0, b0);
        _anotherTargetSameMixSameWord(target1, at1);
        _back(snap, t0, b0);
        _anotherMixAnotherWord();
        _back(snap, t0, b0);
    }

    /// The drawer itself starts (one target); a few blocks later nobody can start again; the drawer forges a header
    /// with a mix of its choice: refused; the chain's header is the only one accepted. Returns the target and readyAt.
    function _drawerStartsAndCannotForge() internal returns (uint256 target1, uint64 at1) {
        target1 = _startBackup(silentRound, eoa7702);
        _advance(5);
        (bool ok, bytes memory ret) = _tryStart(silentRound, vm.getBlockNumber() - 1, _parentHeader(), eoa[0]);
        assertFalse(ok);
        assertEq(_sel(ret), BoxBackedSource.BackupAlreadyStarted.selector);
        _advance(src.TARGET_BLOCKS());
        bytes memory honest = _mineHeader(target1, mixB);
        (ok, ret) = _tryFix(silentRound, AuditHeaders.header(target1, keccak256("the drawer's choice")), eoa7702);
        assertEq(_sel(ret), BoxBackedSource.WrongHeader.selector, "the fixer cannot choose the mix");
        (ok, ret) = _tryFix(silentRound, honest, eoa7702);
        assertTrue(ok);
        assertEq(abi.decode(ret, (bytes32)), mixB);
        bytes32 wDraw;
        (wDraw, at1) = src.wordOf(a.tickets, drawC);
        assertEq(wDraw, expectedDrawB);
        (, uint64 t1,,) = src.backupOf(silentRound);
        assertEq(t1, uint64(target1));
    }

    /// Another starter 40 blocks later (another target), another fixer, the same prevRandao at the target: the same
    /// word, a different readyAt.
    function _anotherTargetSameMixSameWord(uint256 target1, uint64 at1) internal {
        _advance(40);
        uint256 target2 = _startBackup(silentRound, eoa[3]);
        assertEq(target2, target1 + 40, "the start block moves the target only");
        _advance(src.TARGET_BLOCKS() + 100);
        _fixBackup(silentRound, mixB, eoa[4]);
        (bytes32 wDraw2, uint64 at2) = src.wordOf(a.tickets, drawC);
        assertEq(wDraw2, expectedDrawB, "the word is the same function of the prevRandao and the id");
        assertTrue(at2 != at1, "only readyAt differs");
    }

    /// A different prevRandao at the same target: a different word, still per id.
    function _anotherMixAnotherWord() internal {
        _startBackup(silentRound, eoa[3]);
        _advance(src.TARGET_BLOCKS() + 1);
        _fixBackup(silentRound, keccak256("another randao"), eoa[4]);
        (bytes32 wDraw3,) = src.wordOf(a.tickets, drawC);
        assertTrue(wDraw3 != expectedDrawB);
        assertEq(wDraw3, _word(src.BACKUP_TAG(), keccak256("another randao"), drawC));
    }

    /// P8.6 (recorded F7, pinned) on the graduation word: start, then drand's post of r0 lands on the DrandSource
    /// with its pot paid to the poster; the backed source ignores it before and after the fix.
    function testProperty_AUDIT_U8_drandPostAfterAStartIsIgnoredForGood() public {
        _toSilentFromGraduation();
        _addBounty(eoa[1], r0, 0.01 ether, true);
        _startBackup(r0, eoa[0]);
        _advance(1);
        _post(r0);
        assertEq(drand.owedTo(poster), 0.01 ether, "the pot pays the ignored post (F7, recorded)");
        (bytes32 w, uint64 at) = src.wordOf(a.tickets, 0);
        assertEq(w, bytes32(0));
        assertEq(at, 0);
        assertFalse(src.isSilent(a.tickets, 0), "not silent yet: the deadline is ahead");
        _advance(src.TARGET_BLOCKS());
        _fixBackup(r0, keccak256("mix"), eoa[2]);
        (w, at) = src.wordOf(a.tickets, 0);
        assertEq(w, _word(src.BACKUP_TAG(), keccak256("mix"), 0));
        (bytes32 randomness,) = drand.beaconOf(r0);
        assertTrue(w != _word(src.DRAND_TAG(), randomness, 0), "never drand's word");
        _assertGhostLedger();
    }

    /// P8.6 (recorded residual, not reported again: backup review finding 3 in SH-BOX0-BACKUP-SOURCE.md § Limitations;
    /// BoxBackedSource.sol:16-32; F143): quicknet's randomness is public from a round's time, so a round left unposted
    /// for 5 days with drand live (every poster asleep) gives whoever acts first at day 5 a one-time choice: post the
    /// round (the word everyone can compute) or start the backup (a word nobody knows until the target). The two
    /// exclude each other in either order, the choice closes with the first action, and before day 5 only the post
    /// exists, so for five days the public word is anyone's to claim. Pinned as the accepted behaviour (mitigated by
    /// the pot and outside posters).
    function testProperty_AUDIT_U8_recordedDay5ChoiceIsPostOrStartNeverBoth() public {
        _toGraduated();
        bytes32 known = _word(src.DRAND_TAG(), _boxDrand(r0).randomness, 0);
        _warpTo(drand.roundTime(r0) + src.BACKUP_AFTER());
        (bool ok, bytes memory ret) = _tryStart(r0, vm.getBlockNumber() - 1, _parentHeader(), eoa[0]);
        assertFalse(ok);
        assertEq(_sel(ret), BoxBackedSource.BackupTooEarly.selector, "for five days only the post exists");
        _advance(1);
        uint256 snap = vm.snapshotState();
        uint256 t0 = vm.getBlockTimestamp();
        uint256 b0 = vm.getBlockNumber();
        // A: the first actor posts: the word everyone could compute stands and the start is refused for good.
        _post(r0);
        (bytes32 w,) = src.wordOf(a.tickets, 0);
        assertEq(w, known, "the public drand word");
        (ok, ret) = _tryStart(r0, vm.getBlockNumber() - 1, _parentHeader(), eoa[1]);
        assertFalse(ok);
        assertEq(_sel(ret), BoxBackedSource.RoundAlreadyPosted.selector, "no re-roll after a post");
        _back(snap, t0, b0);
        // B: the first actor starts: the known word is gone for every request on r0; the post still lands on the
        // DrandSource (its pot, F7) and the word is the target's, unknown now and fixed later.
        uint256 target = _startBackup(r0, eoa[1]);
        _post(r0);
        (w,) = src.wordOf(a.tickets, 0);
        assertEq(w, bytes32(0), "the known word is gone");
        _advance(src.TARGET_BLOCKS() + 1);
        _fixBackup(r0, keccak256("the target's mix"), eoa[2]);
        (w,) = src.wordOf(a.tickets, 0);
        assertEq(w, _word(src.BACKUP_TAG(), keccak256("the target's mix"), 0));
        assertTrue(w != known, "one re-roll of the public drand word, by whoever acted first");
        (, uint64 t,,) = src.backupOf(r0);
        assertEq(t, uint64(target));
        _back(snap, t0, b0);
    }

    // ------------------------------------------------------------------------------------------------ L5 P8.8

    /// P8.8: `wordOf` on the backed source answers within 50,000 gas, cold, in every state (none, requested, posted,
    /// started, fixed, silent) under this contract's EVM and under Cancun (switched at the CALL boundary for the
    /// reads: the states were built with the BLS precompiles); the worst read is pinned at BackupGas's 21,000 and
    /// logged. The DrandSource's own `wordOf` is measured alongside (DrandSource.sol:37 says 8,000 to 13,000 cold).
    function testProperty_AUDIT_U8_wordOfAnswersWithinTheConsumersGasInEveryState() public {
        _toDrawing();
        _advance(1);
        uint256 startedRound = _requestRound(eoa[0], 1, 0, true);
        _requestRound(eoa[0], 2, 0, false);
        _toSilent();
        uint256 fixedRound = silentRound;
        assertGt(fixedRound, startedRound);
        _requestRound(eoa[1], 1, 0, true);
        _startBackup(startedRound, eoa[2]);
        _backup(fixedRound, keccak256("fixed mix"), eoa[3]);
        _measureAll("this EVM");
        vm.setEvmVersion("cancun");
        _measureAll("cancun");
        vm.setEvmVersion(_evm());
        // Silent: the started round's window passes without a fix; 7 days after its request nothing is ready.
        (uint64 requestedAt,) = src.requestOf(eoa[0], 1);
        _warpTo(uint256(requestedAt) + src.SILENCE() + 1);
        assertTrue(src.isSilent(eoa[0], 1));
        (bool ok, bytes32 w,, uint256 used) = _coldRead(address(src), eoa[0], 1);
        assertTrue(ok && w == bytes32(0), "silent reads as no word");
        emit log_named_uint("wordOf backed, silent (started, never fixed), this EVM", used);
        assertLe(used, 21_000);
    }

    function _measureAll(string memory evm) internal {
        uint256 worst;
        (bool ok,,, uint256 used) = _coldRead(address(src), a.tickets, 99_999);
        assertTrue(ok, "none");
        emit log_named_uint(string.concat("wordOf backed, none, ", evm), used);
        worst = used;
        bytes32 w;
        (ok, w,, used) = _coldRead(address(src), eoa[1], 1);
        assertTrue(ok && w == bytes32(0), "requested");
        emit log_named_uint(string.concat("wordOf backed, requested, ", evm), used);
        if (used > worst) worst = used;
        (ok, w,, used) = _coldRead(address(src), a.tickets, 0);
        assertTrue(ok && w != bytes32(0), "posted");
        emit log_named_uint(string.concat("wordOf backed, drand posted, ", evm), used);
        if (used > worst) worst = used;
        (ok, w,, used) = _coldRead(address(src), eoa[0], 1);
        assertTrue(ok && w == bytes32(0), "started");
        emit log_named_uint(string.concat("wordOf backed, backup started, ", evm), used);
        if (used > worst) worst = used;
        (ok, w,, used) = _coldRead(address(src), a.tickets, drawC);
        assertTrue(ok && w != bytes32(0), "fixed");
        emit log_named_uint(string.concat("wordOf backed, backup fixed, ", evm), used);
        if (used > worst) worst = used;
        emit log_named_uint(string.concat("worst wordOf backed, ", evm), worst);
        assertLe(worst, WORD_READ_GAS, "within the consumers' 50,000");
        assertLe(worst, 21_000, "BackupGas's pin");
        (ok, w,, used) = _coldRead(address(drand), eoa[0], 2);
        assertTrue(ok && w == bytes32(0), "DrandSource, requested");
        emit log_named_uint(string.concat("wordOf DrandSource, requested, ", evm), used);
        (ok, w,, used) = _coldRead(address(drand), address(src), uint256(keccak256(abi.encode(a.tickets, uint256(0)))));
        assertTrue(ok && w != bytes32(0), "DrandSource, posted");
        emit log_named_uint(string.concat("wordOf DrandSource, posted, ", evm), used);
        assertLe(used, 21_000);
    }

    /// P8.8: a consumer that leaves too little gas for the read reverts `GasTooLow` and never reads "no word": for
    /// every gas cap from 30,000 to 80,000 (steps of 250) the `DrandWords` consumer either reverts GasTooLow or
    /// returns the word (a stand-in consumer, the library being internal; BoxTickets inlines the same code,
    /// BoxTickets.sol:776-790).
    function testProperty_AUDIT_U8_aStarvedConsumerRevertsGasTooLowNotNoWord() public {
        _toGraduated();
        AuditU8FableWordsConsumer c = new AuditU8FableWordsConsumer(IDrandSource(address(src)));
        vm.deal(address(c), 1 ether);
        uint256 round = c.request(1);
        assertEq(round, r0);
        _advance(1);
        _post(r0);
        (bytes32 expected,) = src.wordOf(address(c), 1);
        assertTrue(expected != bytes32(0));
        uint256 lowest;
        uint256 highestLow;
        for (uint256 g = 30_000; g <= 80_000; g += 250) {
            vm.cool(address(src));
            vm.cool(address(drand));
            (bool ok, bytes memory ret) = address(c).call{gas: g}(abi.encodeCall(c.wordOf, (1)));
            if (!ok) {
                assertEq(_sel(ret), DrandWords.GasTooLow.selector, "a starved consumer reverts GasTooLow");
                highestLow = g;
            } else {
                (bytes32 w, uint256 at) = abi.decode(ret, (bytes32, uint256));
                assertEq(w, expected, "or reads the word");
                assertGt(at, 0);
                if (lowest == 0) lowest = g;
            }
        }
        assertGt(lowest, 0);
        assertGt(highestLow, 0);
        assertLt(highestLow, lowest, "GasTooLow below, the word above");
        emit log_named_uint("lowest cap at which the consumer reads the word", lowest);
        uint256 wordGas = 50_000;
        assertEq(DrandWords.WORD_GAS_REQUIRED, wordGas + wordGas / 63 + 5_000);
    }

    // ------------------------------------------------------------------------------------------------ L5 P8.10

    /// P8.10: at 12-second blocks the latest start (5 d 18 h after the round), its target 256 blocks on and the last
    /// fix 8,191 blocks after that end 6 d 22 h 9 min 36 s after the request, 1 h 50 min 24 s before the tickets'
    /// 7 days (BoxBackedSource.sol:38-41); at 6-second blocks (EIP-7782's Glamsterdam proposal) the same path ends
    /// 15 h 55 min 6 s before the deadline, but the fix window itself (target + 1 … target + 8,191) halves from
    /// 27 h 18 min to 13 h 39 min: the keeper's fix job (F4) must meet the shorter one. Both are run in the world.
    function testProperty_AUDIT_U8_timelineAtTwelveAndAtSixSecondBlocks() public {
        _toGraduated();
        assertEq(src.TARGET_BLOCKS(), 256);
        assertEq(src.HISTORY_WINDOW(), 8191);
        uint256 window = src.HISTORY_WINDOW();
        uint256 path = src.TARGET_BLOCKS() + window;
        assertEq(window * 12, 98_292, "the fix window in seconds at 12-s blocks: 27 h 18 min 12 s");
        assertEq(window * 6, 49_146, "at 6-s blocks: 13 h 39 min 6 s");
        assertEq(path * 12, 101_364);
        assertEq(path * 6, 50_682);
        uint256 snap = vm.snapshotState();
        uint256 t0 = vm.getBlockTimestamp();
        uint256 b0 = vm.getBlockNumber();
        _runTimeline(12, 6624);
        _back(snap, t0, b0);
        _runTimeline(6, 57_306);
        _back(snap, t0, b0);
    }

    /// The latest start, the target, the last served fix at `slot`-second blocks; `spare` is the pinned margin.
    function _runTimeline(uint256 slot, uint256 spare) internal {
        uint256 requestedAt = tickets.status().wordRequestedAt;
        uint256 deadline = requestedAt + tickets.SILENCE();
        _warpTo(drand.roundTime(r0) + src.LATEST_START());
        uint256 target = _startBackup(r0, eoa[0]);
        uint256 blocks = src.TARGET_BLOCKS() + src.HISTORY_WINDOW();
        vm.roll(vm.getBlockNumber() + blocks);
        vm.warp(vm.getBlockTimestamp() + slot * blocks);
        bytes memory h = AuditHeaders.header(target, keccak256("last provable mix"));
        _serve(target, h);
        uint256 inner = vm.snapshotState();
        uint256 ti = vm.getBlockTimestamp();
        uint256 bi = vm.getBlockNumber();
        (bool ok,) = _tryFix(r0, h, eoa[1]);
        assertTrue(ok, "fixed at the last block EIP-2935 serves");
        (,, uint64 fixedAt,) = src.backupOf(r0);
        assertLe(fixedAt, deadline, "inside the 7 days");
        assertEq(fixedAt - requestedAt, 12 + 5 days + 18 hours + blocks * slot, "the request-to-fix path");
        assertEq(deadline - fixedAt, spare, "the pinned spare before the deadline");
        emit log_named_uint(string.concat("spare before the deadline at ", vm.toString(slot), "-s blocks"), spare);
        vm.prank(keeper);
        tickets.acceptGraduationWord();
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Drawing), "the word counts");
        _back(inner, ti, bi);
        vm.roll(vm.getBlockNumber() + 1);
        vm.warp(vm.getBlockTimestamp() + slot);
        _serve(target, h);
        (ok,) = _tryFix(r0, h, eoa[1]);
        assertFalse(ok, "one block later the target is gone");
    }

    // ------------------------------------------------------------------------------------------------ L6 P8.12

    /// P8.12: with no code at EIP-2935's address a fix beyond 256 blocks is refused cleanly (HeaderUnavailable);
    /// the history contract's answers for the current block, a future block, a block 8,192 back and a slot never
    /// written are treated as no answer; a history stand-in that reverts, answers short or long, or answers another
    /// hash leaves the round unfixed (HeaderUnavailable or WrongHeader), and nothing is stored in any case. The
    /// stand-ins replace only the history contract's code; the real code's own window is checked first.
    function testProperty_AUDIT_U8_historyContractAbsentOrOutsideItsWindowReadsAsNoAnswer() public {
        _toSilent();
        uint256 target = _startBackup(silentRound, eoa[0]);
        bytes memory h = AuditHeaders.header(target, keccak256("history mix"));
        assertEq(src.HISTORY(), 0x0000F90827F1C53a10cb7A02335B175320002935);
        vm.roll(target + 300);
        vm.warp(vm.getBlockTimestamp() + 12 * 300);
        uint256 snap = vm.snapshotState();
        uint256 t0 = vm.getBlockTimestamp();
        uint256 b0 = vm.getBlockNumber();
        _historyNoCode(h);
        _back(snap, t0, b0);
        _historyRealCodeWindow(target, h);
        _back(snap, t0, b0);
        _historyStandIns(h);
        _back(snap, t0, b0);
        _serve(target, h);
        (bool ok, bytes memory ret) = _tryFix(silentRound, h, eoa[1]);
        assertTrue(ok, "the real code with the right hash: fixed");
        assertEq(abi.decode(ret, (bytes32)), keccak256("history mix"));
    }

    /// No code at EIP-2935's address: refused cleanly.
    function _historyNoCode(bytes memory h) internal {
        vm.etch(src.HISTORY(), "");
        (, bytes memory ret) = _tryFix(silentRound, h, eoa[1]);
        assertEq(_sel(ret), BoxBackedSource.HeaderUnavailable.selector, "no history contract: refused cleanly");
    }

    /// The real code: a slot never written is no answer; the current block, a future block and a block 8,192 back
    /// are refused by the contract itself (a revert); 8,191 back it answers.
    function _historyRealCodeWindow(uint256 target, bytes memory h) internal {
        address history = src.HISTORY();
        vm.etch(history, _history2935Code());
        vm.store(history, bytes32(target % 8191), bytes32(0));
        (, bytes memory ret) = _tryFix(silentRound, h, eoa[1]);
        assertEq(_sel(ret), BoxBackedSource.HeaderUnavailable.selector, "an empty slot is no answer");
        uint256 n = vm.getBlockNumber();
        (bool c1, bytes memory r1) = history.staticcall(abi.encode(n));
        assertTrue(!c1 && r1.length == 0, "the current block: a revert");
        (bool c2,) = history.staticcall(abi.encode(n + 1));
        assertFalse(c2, "a future block: a revert");
        (bool c3,) = history.staticcall(abi.encode(n - 8192));
        assertFalse(c3, "8,192 back: a revert");
        (bool c4, bytes memory r4) = history.staticcall(abi.encode(n - 8191));
        assertTrue(c4 && r4.length == 32, "8,191 back it answers (the slot's content)");
    }

    /// Stand-ins for the history contract's answer: short, long, reverting, another hash: nothing stored.
    function _historyStandIns(bytes memory h) internal {
        bytes[4] memory codes = [
            bytes(hex"601f6000f3"),
            bytes(hex"60216000f3"),
            bytes(hex"600080fd"),
            bytes.concat(hex"7f", keccak256("another block"), hex"60005260206000f3")
        ];
        bytes4[4] memory expected = [
            BoxBackedSource.HeaderUnavailable.selector,
            BoxBackedSource.HeaderUnavailable.selector,
            BoxBackedSource.HeaderUnavailable.selector,
            BoxBackedSource.WrongHeader.selector
        ];
        for (uint256 i; i < 4; ++i) {
            vm.etch(src.HISTORY(), codes[i]);
            (bool ok, bytes memory ret) = _tryFix(silentRound, h, eoa[1]);
            assertFalse(ok);
            assertEq(_sel(ret), expected[i], string.concat("history stand-in ", vm.toString(i)));
            (,, uint64 fixedAt,) = src.backupOf(silentRound);
            assertEq(fixedAt, 0, "nothing stored");
        }
    }
}

/// @notice The same under Amsterdam (Glamsterdam's repricing and header shape).
/// forge-config: default.evm_version = "amsterdam"
contract AuditU8FableBackupAmsterdamTest is AuditU8FableBackupTest {
    function _evm() internal pure override returns (string memory) {
        return "amsterdam";
    }
}

/// @title AuditU8FableHeadersTest (SH-AUDIT-B0-U8-F, lens L6 on the header parser)
/// @notice The world with draw C's round silent and its backup started, 257 blocks on: the target's header is proved
/// through `fixBackup` for every post-London shape and the two real vectors, malformed RLP is refused, and the one
/// observation of this review (proof 25: non-canonical RLP that hashes to the target is taken; no effect) is pinned
/// (BoxBackedSource.sol:262-302). Built once in setUp so the fuzz runs stay cheap.
/// forge-config: default.evm_version = "osaka"
contract AuditU8FableHeadersTest is AuditU8FableBase {
    uint256 internal target;

    function setUp() public virtual override {
        super.setUp();
        _toSilent();
        target = _startBackup(silentRound, eoa[0]);
        _advance(src.TARGET_BLOCKS() + 1);
    }

    /// P8.11: keccak256(RLP) == blockhash and field 13 is prevRandao for header shapes of 15 (pre-London), 16
    /// (London), 17 (Shanghai), 20 (Cancun), 21 (Prague, Osaka), 22 and 23 (Amsterdam: the block-access-list hash
    /// and the slot number) fields, and for the two real vectors: mainnet block 26,233,781 (21 fields) and Sepolia
    /// block 11,955,279 (23 fields), each hashing to its block hash. Every shape is proved through `fixBackup` and
    /// through `startBackup`'s header check.
    function testProperty_AUDIT_U8_headerShapesFromLondonToAmsterdamParseField13() public {
        uint256 snap = vm.snapshotState();
        uint256 t0 = vm.getBlockTimestamp();
        uint256 b0 = vm.getBlockNumber();
        uint256[7] memory shapes = [uint256(15), 16, 17, 20, 21, 22, 23];
        for (uint256 i; i < 7; ++i) {
            _fixWithShape(shapes[i]);
            vm.revertToState(snap);
            vm.warp(t0);
            vm.roll(b0);
        }
        _fixWithRealVector(HeaderVectors.MAINNET, HeaderVectors.MAINNET_HASH, HeaderVectors.MAINNET_MIX, 21);
        vm.revertToState(snap);
        vm.warp(t0);
        vm.roll(b0);
        _fixWithRealVector(HeaderVectors.SEPOLIA, HeaderVectors.SEPOLIA_HASH, HeaderVectors.SEPOLIA_MIX, 23);
        vm.revertToState(snap);
        vm.warp(t0);
        vm.roll(b0);
        _startWithEveryShape(shapes);
    }

    function _fixWithShape(uint256 fields) internal {
        bytes32 mix = keccak256(abi.encode("shape", fields));
        bytes memory h = _shapedHeader(target, mix, fields);
        assertEq(_rlpItemCount(h), fields, "the shape's field count");
        _serve(target, h);
        (bool ok, bytes memory ret) = _tryFix(silentRound, h, eoa[1]);
        assertTrue(ok, string.concat("fixed with a ", vm.toString(fields), "-field header"));
        assertEq(abi.decode(ret, (bytes32)), mix, "field 13");
    }

    function _fixWithRealVector(bytes memory h, bytes32 hash, bytes32 mix, uint256 fields) internal {
        assertEq(keccak256(h), hash, "the real header hashes to its block hash");
        assertEq(_rlpItemCount(h), fields, "the real header's field count");
        vm.setBlockhash(target, hash);
        (bool ok, bytes memory ret) = _tryFix(silentRound, h, eoa[1]);
        assertTrue(ok);
        assertEq(abi.decode(ret, (bytes32)), mix);
    }

    /// The start's own header check takes every shape too (a later round, startable then).
    function _startWithEveryShape(uint256[7] memory shapes) internal {
        uint256 later = _requestRound(eoa[2], 8, 0, true);
        _warpTo(drand.roundTime(later) + src.BACKUP_AFTER() + 1);
        uint256 startSnap = vm.snapshotState();
        uint256 ts = vm.getBlockTimestamp();
        uint256 bs = vm.getBlockNumber();
        for (uint256 i; i < 7; ++i) {
            bytes memory h = _shapedHeader(bs - 1, keccak256("recent"), shapes[i]);
            vm.setBlockhash(bs - 1, keccak256(h));
            (bool ok,) = _tryStart(later, bs - 1, h, eoa[2]);
            assertTrue(ok, "a start proves every shape");
            vm.revertToState(startSnap);
            vm.warp(ts);
            vm.roll(bs);
        }
    }

    /// P8.11: malformed RLP is refused with BadHeader and nothing stored: a short-form outer list (a real header is
    /// always long-form), trailing bytes, an outer length one byte off, a nested list among the first 13 fields or
    /// as field 13, a field 13 of 31 or 33 bytes, a truncated list, a long string overrunning the input, a one-byte
    /// input, an empty input. Non-minimal lengths (a long-form length for a short string, a leading zero length
    /// byte) are taken by the walker: observed, with no effect (proof 25 below), because the hash binds the exact
    /// bytes and a real header is canonical RLP, so a non-minimal re-encoding never hashes to a block's hash.
    function testFuzz_AUDIT_U8_malformedHeadersRefusedNonMinimalLengthsTakenButHashBound(uint256 seed, uint8 how)
        public
    {
        bytes32 mix = keccak256(abi.encode("mix", seed));
        uint256 kind = how % 11;
        (bytes memory h, bool accepted) = _malformed(seed, kind, mix);
        _serve(target, h);
        (bool ok, bytes memory ret) = _tryFix(silentRound, h, eoa[1]);
        if (accepted) {
            assertTrue(ok, "a non-minimal length is taken by the walker (bound by the hash: no effect)");
            assertEq(abi.decode(ret, (bytes32)), mix);
        } else {
            assertFalse(ok, string.concat("malformed kind ", vm.toString(kind)));
            assertEq(_sel(ret), BoxBackedSource.BadHeader.selector, "BadHeader, never a panic or a wrong field");
            (,, uint64 fixedAt,) = src.backupOf(silentRound);
            assertEq(fixedAt, 0, "nothing stored");
        }
    }

    /// @notice Proof 25 (severity: note). Property: `fixBackup` (and `startBackup`) take only the block's RLP header:
    /// `BadHeader` is "Not an RLP list whose field 13 is a 32-byte string" (BoxBackedSource.sol:85-86, :262-293);
    /// the unit brief's P8.11 reads it as "malformed RLP (long-form lengths, non-minimal lengths, trailing bytes,
    /// nested lists in a field) refused"; F143: the mix is "read from that block's header proved against its hash".
    /// Expected (the strict reading): `BadHeader` for every non-canonical encoding of the target's header. Observed:
    /// the walker is an authenticated field extractor, not an RLP validator: (a) the outer list length written in
    /// three bytes with a leading zero (`fa 00 LL LL`), (b) a long-form length for the 3-byte extraData (`b8 03 …`)
    /// and (c) anything inside the declared length after field 13 (here an empty nested list, `c0`) are taken, and
    /// field 13 is stored as the mix. Steps: the world with draw C's round silent and its backup started, 257 blocks
    /// on; each encoding is served as the target's hash (as the chain serves its own canonical bytes); `fixBackup` by
    /// eoa[1]; the mix is stored, readyAt set. Amounts: no ETH moves. Reason for "note": no effect. The header is
    /// bound by its hash to the one byte string the chain produced, which is canonical RLP, so a non-canonical string
    /// can never prove a real block (it would need a keccak collision), and (c) is what keeps the fix working when a
    /// later fork appends a list-typed field. `BadHeader`'s text promises no canonical check; whether U8.11 should
    /// mean a strict RLP validator (a change to the pinned bytecode, BackedSourcePins) is a question for the founder.
    /// Osaka and Amsterdam (the derived contract).
    function test_AUDIT_U8_25_nonCanonicalRlpTakenWhenItHashesToTheTarget() public {
        bytes32 mix = keccak256("audit.u8.proof25");
        bytes memory body = bytes.concat(_headFields(target, mix, hex"83616263"), hex"880000000000000000", hex"07");
        bytes memory canonical = _rlpList(body);
        bytes[3] memory nonCanonical = [
            bytes.concat(hex"fa00", abi.encodePacked(uint16(body.length)), body),
            _rlpList(bytes.concat(_headFields(target, mix, hex"b803616263"), hex"880000000000000000", hex"07")),
            _rlpList(bytes.concat(body, hex"c0"))
        ];
        uint256 snap = vm.snapshotState();
        uint256 t0 = vm.getBlockTimestamp();
        uint256 b0 = vm.getBlockNumber();
        for (uint256 i; i < 3; ++i) {
            bytes memory h = nonCanonical[i];
            assertTrue(keccak256(h) != keccak256(canonical), "another byte string than the canonical header");
            _serve(target, h);
            (bool ok, bytes memory ret) = _tryFix(silentRound, h, eoa[1]);
            assertTrue(ok, string.concat("observed: taken, encoding ", vm.toString(i)));
            assertEq(abi.decode(ret, (bytes32)), mix, "field 13 stored as the mix");
            (,, uint64 fixedAt, bytes32 stored) = src.backupOf(silentRound);
            assertEq(stored, mix);
            assertEq(fixedAt, uint64(vm.getBlockTimestamp()));
            vm.revertToState(snap);
            vm.warp(t0);
            vm.roll(b0);
        }
    }

    /// @dev The malformed (or non-minimal, `accepted`) header of `kind` for the target.
    function _malformed(uint256 seed, uint256 kind, bytes32 mix) internal view returns (bytes memory h, bool accepted) {
        bytes memory body = _headFields(target, mix, hex"83616263");
        bytes memory fields = _fieldsOf(target, mix);
        if (kind == 0) {
            h = bytes.concat(abi.encodePacked(uint8(0xc0 + 50)), new bytes(50));
        } else if (kind == 1) {
            h = bytes.concat(_rlpList(bytes.concat(body, hex"880000000000000000", hex"07")), hex"00");
        } else if (kind == 2) {
            h = _rlpList(bytes.concat(body, hex"880000000000000000", hex"07"));
            h[1] = bytes1(uint8(h[1]) + 1);
            h[2] = bytes1(uint8(h[2]) + 1);
        } else if (kind == 3) {
            h = _rlpList(bytes.concat(_withListAt(fields, seed % 13), hex"a0", mix, hex"880000000000000000", hex"07"));
        } else if (kind == 4) {
            h = _rlpList(bytes.concat(fields, hex"e1a0", mix));
        } else if (kind == 5) {
            h = _rlpList(bytes.concat(fields, hex"9f", bytes31(mix), hex"880000000000000000"));
        } else if (kind == 6) {
            h = _rlpList(bytes.concat(fields, hex"a1", mix, hex"00", hex"880000000000000000"));
        } else if (kind == 7) {
            h = _rlpList(_slice(body, 0, 1 + (seed % (body.length - 40))));
        } else if (kind == 8) {
            h = _rlpList(bytes.concat(hex"bbffffffff", _slice(fields, 33, fields.length - 33), hex"a0", mix));
        } else if (kind == 9) {
            h = seed % 2 == 0 ? bytes(hex"f8") : bytes(hex"");
        } else if (seed % 2 == 0) {
            bytes memory inner = bytes.concat(body, hex"880000000000000000", hex"07");
            h = bytes.concat(hex"fa", hex"00", abi.encodePacked(uint16(inner.length)), inner);
            accepted = true;
        } else {
            h = _rlpList(bytes.concat(_headFields(target, mix, hex"b803616263"), hex"880000000000000000", hex"07"));
            accepted = true;
        }
    }

    /// @dev The 13 fields with field `k` replaced by a short list.
    function _withListAt(bytes memory fields, uint256 k) internal pure returns (bytes memory b) {
        uint256 p;
        for (uint256 i; i < 13; ++i) {
            (bytes memory f, uint256 next) = _nextItem(fields, p);
            b = bytes.concat(b, i == k ? bytes(hex"c3010203") : f);
            p = next;
        }
    }

    /// @dev The first 13 fields alone (no field 13).
    function _fieldsOf(uint256 number, bytes32 mix) internal pure returns (bytes memory f) {
        bytes memory withMix = _headFields(number, mix, hex"83616263");
        f = _slice(withMix, 0, withMix.length - 33);
    }

    /// @dev The RLP item at `p` of a concatenation of items and the position after it (byte strings only).
    function _nextItem(bytes memory items, uint256 p) internal pure returns (bytes memory item, uint256 next) {
        uint256 b = uint8(items[p]);
        if (b < 0x80) next = p + 1;
        else if (b <= 0xb7) next = p + 1 + (b - 0x80);
        else next = p + 1 + (b - 0xb7) + _beOf(items, p + 1, b - 0xb7);
        item = _slice(items, p, next - p);
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU8FableHeadersAmsterdamTest is AuditU8FableHeadersTest {
    function _evm() internal pure override returns (string memory) {
        return "amsterdam";
    }
}
