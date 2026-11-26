// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IDrandSource} from "../../../../src/box/interfaces/IDrandSource.sol";
import {BoxBackedSource} from "../../../../src/box/randomness/BoxBackedSource.sol";
import {DrandSource} from "../../../../src/box/randomness/DrandSource.sol";
import {HeaderVectors} from "../../backup/HeaderVectors.sol";
import {History2935} from "../../backup/History2935.sol";
import {BoxDrandVectors} from "../../randomness/utils/BoxDrandVectors.sol";
import {PinnedBackedSource} from "../../randomness/utils/PinnedBackedSource.sol";
import {PinnedDrandSource} from "../../randomness/utils/PinnedDrandSource.sol";
import {AuditHeaders} from "../common/AuditHeaders.sol";

/// @notice TEST ONLY (U8). Random sequences against the pinned DrandSource and BoxBackedSource: three consumers request
/// keys through the backed source and one consumer directly on the DrandSource (any bounty); anyone adds bounties
/// through either; three posters post the 16 committed quicknet rounds (from their time, also after a backup start),
/// try them early and with a neighbour's signature; posters withdraw; anyone starts backups (with a recent header of
/// any age, or a wrong one) and fixes them (with the target's honest header or a forged one); ETH is forced onto both
/// sources; time and blocks advance by single blocks, hours, days, and onto the edges that matter: a round's time
/// + 5 d − 1 s / + 5 d / + 5 d + 1 s / + 5 d 18 h / + 5 d 18 h + 1 s, a request's 7 days ± 1 s, a target + 256 /
/// + 8,191 / + 8,192 blocks. The chain's prevRandao of block n is a fixed function of n (`chainMix`). Every action is
/// wrapped (fail-safe: the campaign runs with `fail_on_revert`); the ghosts record what must never happen, and every
/// request's word is checked after every action.
contract AuditU8ClaudeSourcesHandler is BoxDrandVectors {
    struct Req {
        address consumer;
        uint256 key;
        bool viaBacked;
        uint256 at;
        uint256 round;
        bytes32 firstWord;
        uint64 firstReady;
        bool silentSeen;
    }

    struct Backup {
        bool started;
        bool fixedYet;
        uint256 target;
        bool postedAfterStart;
    }

    DrandSource internal immutable drand;
    BoxBackedSource internal immutable src;
    uint256 internal immutable first;
    address[3] internal consumers;
    address internal direct;
    address[3] internal posters;
    address internal payee;
    bytes[16] internal sigs;

    uint256 public clock;
    uint256 public blockNumber;
    /// @notice Requests land only until two hours after the first committed round: the first 47 s fix committed
    /// rounds (drand can answer), the rest rounds with no signature (only the backup can).
    uint256 public immutable requestsUntil;

    Req[] internal reqs;
    mapping(bytes32 => bool) internal requested;
    mapping(uint256 => Backup) internal backups;
    mapping(uint256 => bool) internal posted;
    mapping(uint256 => uint256) public pot;
    uint256[] internal potRounds;
    mapping(uint256 => bool) internal potRoundSeen;
    mapping(address => uint256) public owed;
    uint256 public forcedDrand;
    uint256 public forcedBacked;
    uint256 public withdrawnOut;

    // what must never happen
    bool public wordMoved;
    bool public wrongWord;
    bool public dishonestReady;
    bool public silenceUndone;
    bool public silenceDisagrees;
    bool public roundTooClose;
    bool public doubleRequestPassed;
    bool public firstRequestFailed;
    bool public startRuleBroken;
    bool public fixRuleBroken;
    bool public targetMoved;
    bool public postRuleBroken;
    bool public bountyRuleBroken;
    bool public withdrawBroken;

    // coverage
    uint256 public nRequests;
    uint256 public nPosts;
    uint256 public nPostsAfterStart;
    uint256 public nStarts;
    uint256 public nStartRefusals;
    uint256 public nFixes;
    uint256 public nFixRefusals;
    uint256 public nFixesThroughHistory;
    uint256 public nWithdrawals;
    uint256 public nBounties;
    uint256 public nForced;
    uint256 public nDrandWords;
    uint256 public nBackupWords;
    uint256 public nSilent;

    constructor(DrandSource drand_, BoxBackedSource src_) {
        drand = drand_;
        src = src_;
        _loadBoxDrand();
        first = _localFirst();
        for (uint256 i; i < 16; ++i) {
            sigs[i] = _localSig(i);
        }
        consumers = [makeAddr("u8inv.c0"), makeAddr("u8inv.c1"), makeAddr("u8inv.c2")];
        direct = makeAddr("u8inv.direct");
        posters = [makeAddr("u8inv.p0"), makeAddr("u8inv.p1"), makeAddr("u8inv.p2")];
        payee = makeAddr("u8inv.payee");
        for (uint256 i; i < 3; ++i) {
            vm.deal(consumers[i], 1_000 ether);
        }
        vm.deal(direct, 1_000 ether);
        vm.deal(address(this), 1_000 ether);
        clock = drand_.roundTime(_localFirst()) - 14;
        requestsUntil = clock + 2 hours;
        blockNumber = 23_000_000;
    }

    // ------------------------------------------------------------------------------------------------------------
    // The chain

    function chainMix(uint256 n) public pure returns (bytes32) {
        return keccak256(abi.encode("u8inv.chain.prevRandao", n));
    }

    function _sync() internal {
        vm.warp(clock);
        vm.roll(blockNumber);
    }

    function _advanceTo(uint256 t) internal {
        if (t <= clock) return;
        blockNumber += (t - clock + 11) / 12;
        clock = t;
        _sync();
    }

    function _advanceBlocks(uint256 blocks) internal {
        blockNumber += blocks;
        clock += 12 * blocks;
        _sync();
    }

    // ------------------------------------------------------------------------------------------------------------
    // Actions

    function request(uint256 c, uint256 key, uint256 bountySeed, bool viaBacked) external {
        _sync();
        if (reqs.length >= 24 || clock > requestsUntil) return;
        address consumer = viaBacked ? consumers[c % 3] : direct;
        key = key % 6;
        uint256 value = bound(bountySeed, 0, 0.1 ether);
        bytes32 tag = keccak256(abi.encode(consumer, key, viaBacked));
        vm.prank(consumer);
        (bool ok, bytes memory ret) = viaBacked
            ? address(src).call{value: value}(abi.encodeCall(BoxBackedSource.request, (key)))
            : address(drand).call{value: value}(abi.encodeCall(IDrandSource.request, (key)));
        if (requested[tag]) {
            if (ok) doubleRequestPassed = true;
            return;
        }
        if (!ok) {
            firstRequestFailed = true;
            return;
        }
        uint256 round = abi.decode(ret, (uint256));
        uint256 gap = drand.roundTime(round) - clock;
        if (gap < 12 || gap > 14) roundTooClose = true;
        requested[tag] = true;
        reqs.push(
            Req({
                consumer: consumer,
                key: key,
                viaBacked: viaBacked,
                at: clock,
                round: round,
                firstWord: 0,
                firstReady: 0,
                silentSeen: false
            })
        );
        _addPot(round, value);
        ++nRequests;
        _observe();
    }

    function bounty(uint256 sel, uint256 amount, bool viaBacked) external {
        _sync();
        uint256 round = _pickRound(sel);
        amount = bound(amount, 0, 0.05 ether);
        (bool ok,) = viaBacked
            ? address(src).call{value: amount}(abi.encodeCall(BoxBackedSource.addBounty, (round)))
            : address(drand).call{value: amount}(abi.encodeCall(IDrandSource.addBounty, (round)));
        if (ok == posted[round]) bountyRuleBroken = true; // allowed exactly while the round is unposted
        if (ok) {
            _addPot(round, amount);
            ++nBounties;
        }
        _observe();
    }

    function post(uint256 idx, uint256 p) external {
        _sync();
        idx = idx % 16;
        uint256 round = first + idx;
        address poster = posters[p % 3];
        bool due = clock >= drand.roundTime(round);
        vm.prank(poster);
        (bool ok,) = address(drand).call(abi.encodeCall(IDrandSource.postRound, (round, sigs[idx])));
        if (ok != (due && !posted[round])) postRuleBroken = true;
        if (!ok) return;
        posted[round] = true;
        owed[poster] += pot[round];
        pot[round] = 0;
        ++nPosts;
        if (backups[round].started) {
            backups[round].postedAfterStart = true;
            ++nPostsAfterStart;
        }
        _observe();
    }

    /// @dev A neighbour's valid signature for a due, unposted round: always refused, nothing changes.
    function postWrong(uint256 idx) external {
        _sync();
        idx = idx % 16;
        uint256 round = first + idx;
        bytes memory sig = sigs[(idx + 1) % 16];
        (bool ok,) = address(drand).call{gas: 2_000_000}(abi.encodeCall(IDrandSource.postRound, (round, sig)));
        if (ok) postRuleBroken = true;
        _observe();
    }

    function withdraw(uint256 p, bool toPayee) external {
        _sync();
        address poster = posters[p % 3];
        address to = toPayee ? payee : poster;
        uint256 b0 = to.balance;
        vm.prank(poster);
        (bool ok,) = address(drand).call(abi.encodeCall(IDrandSource.withdrawBounty, (payable(to))));
        if (ok != (owed[poster] != 0)) withdrawBroken = true;
        if (!ok) return;
        if (to.balance - b0 != owed[poster]) withdrawBroken = true;
        withdrawnOut += owed[poster];
        owed[poster] = 0;
        ++nWithdrawals;
        _observe();
    }

    function startBackup(uint256 sel, uint256 ageSeed) external {
        _sync();
        uint256 round = _pickRound(sel);
        uint256 a = ageSeed % 16;
        // Ages 1-8 (a < 12, and 6 at a = 15), 0 (the current block), 9 or 10.
        uint256 age = a < 12 ? 1 + a % 8 : (a == 12 ? 0 : 6 + a % 5);
        bool wrongHeader = (ageSeed >> 8) % 4 == 0;
        uint256 headerBlock = blockNumber - age;
        bytes memory h = HeaderVectors.MAINNET;
        if (age != 0) vm.setBlockhash(headerBlock, wrongHeader ? keccak256("u8inv.another block") : keccak256(h));
        uint256 rt = drand.roundTime(round);
        bool expected = clock > rt + 5 days && clock <= rt + 5 days + 18 hours && !backups[round].started
            && !posted[round] && age >= 1 && age <= 8 && !wrongHeader;
        (bool ok, bytes memory ret) =
            address(src).call(abi.encodeCall(BoxBackedSource.startBackup, (round, headerBlock, h)));
        if (ok != expected) startRuleBroken = true;
        if (!ok) {
            ++nStartRefusals;
            return;
        }
        uint256 target = abi.decode(ret, (uint256));
        if (target != blockNumber + 256) startRuleBroken = true;
        backups[round].started = true;
        backups[round].target = target;
        ++nStarts;
        _observe();
    }

    function fixBackup(uint256 sel, uint256 forgedSeed) external {
        _sync();
        bool forged = forgedSeed % 4 == 0;
        uint256 round = _pickStarted(sel);
        if (round == 0) return;
        Backup memory b = backups[round];
        uint256 t = b.target;
        bytes memory honest = AuditHeaders.header(t, chainMix(t));
        // The chain serves the target's own hash: BLOCKHASH within 256 blocks, EIP-2935's ring slot after.
        if (blockNumber > t && blockNumber - t <= 256) vm.setBlockhash(t, keccak256(honest));
        History2935.put(vm, t, keccak256(honest));
        bytes memory sent = forged ? AuditHeaders.header(t, keccak256(abi.encode("forged", t, clock))) : honest;
        bool expected = !b.fixedYet && !forged && blockNumber > t && blockNumber - t <= 8191;
        (bool ok,) = address(src).call(abi.encodeCall(BoxBackedSource.fixBackup, (round, sent)));
        if (ok != expected) fixRuleBroken = true;
        if (!ok) {
            ++nFixRefusals;
            return;
        }
        backups[round].fixedYet = true;
        ++nFixes;
        if (blockNumber - t > 256) ++nFixesThroughHistory;
        _observe();
    }

    function forceEth(uint256 amount, bool atBacked) external {
        _sync();
        amount = bound(amount, 1, 1 ether);
        address at = atBacked ? address(src) : address(drand);
        vm.deal(at, at.balance + amount);
        if (atBacked) forcedBacked += amount;
        else forcedDrand += amount;
        ++nForced;
        _observe();
    }

    /// @dev Time and blocks: one block, a few seconds, an hour, a day (rarely), or one of the edges above for a random
    /// request (its round's time + 5 d − 1 s, + 5 d, + 5 d + 1 s, + 5 d 18 h, + 5 d 18 h + 1 s; its 7 days ± 1 s) or
    /// a random started round (its target + 1, + 256, + 257, + 8,191, + 8,192 blocks). Never backwards.
    function wait(uint256 how, uint256 sel) external {
        uint256 kind = how % 16;
        if (kind < 2) {
            _advanceBlocks(1);
        } else if (kind < 4) {
            _advanceTo(clock + (sel % 5));
        } else if (kind == 4) {
            _advanceTo(clock + 1 hours);
        } else if (kind == 5) {
            if ((sel >> 16) % 4 == 0) _advanceTo(clock + 1 days);
        } else if (kind < 11 && reqs.length != 0) {
            uint256 rt = drand.roundTime(reqs[sel % reqs.length].round);
            int256[5] memory edges = [
                int256(5 days) - 1,
                int256(5 days),
                int256(5 days) + 1,
                int256(5 days + 18 hours),
                int256(5 days + 18 hours) + 1
            ];
            _advanceTo(uint256(int256(rt) + edges[kind - 6]));
        } else if (kind == 11 && reqs.length != 0) {
            Req memory q = reqs[sel % reqs.length];
            _advanceTo(q.at + 7 days + (sel >> 8) % 2);
        } else if (kind >= 12) {
            uint256 round = _pickStarted(sel);
            if (round != 0) {
                uint256 t = backups[round].target;
                uint256[5] memory offs = [uint256(1), 256, 257, 8191, 8192];
                uint256 want = t + offs[(sel >> 8) % 5];
                if (want > blockNumber) _advanceBlocks(want - blockNumber);
            } else {
                _advanceBlocks(1 + sel % 300);
            }
        }
        _observe();
    }

    // ------------------------------------------------------------------------------------------------------------
    // Helpers

    function _addPot(uint256 round, uint256 amount) internal {
        pot[round] += amount;
        if (!potRoundSeen[round]) {
            potRoundSeen[round] = true;
            potRounds.push(round);
        }
    }

    /// @dev A requested round (mostly), a committed round, or a round far in the future.
    function _pickRound(uint256 sel) internal view returns (uint256) {
        uint256 k = sel % 8;
        if (k < 6 && reqs.length != 0) return reqs[(sel >> 8) % reqs.length].round;
        if (k < 7) return first + (sel >> 8) % 16;
        return first + 1_000_000 + (sel >> 8) % 1000;
    }

    function _pickStarted(uint256 sel) internal view returns (uint256) {
        uint256 n = reqs.length;
        if (n == 0) return 0;
        uint256 start = sel % n;
        for (uint256 i; i < n; ++i) {
            uint256 round = reqs[(start + i) % n].round;
            if (backups[round].started) return round;
        }
        return 0;
    }

    function _id(address c, uint256 key) internal pure returns (bytes32) {
        return keccak256(abi.encode(c, key));
    }

    /// @dev Every request's word against its first sighting and against the formula its source documents.
    function _observe() internal {
        for (uint256 i; i < reqs.length; ++i) {
            Req storage q = reqs[i];
            (bytes32 w, uint64 ready) = q.viaBacked ? src.wordOf(q.consumer, q.key) : drand.wordOf(q.consumer, q.key);
            if (q.firstWord != bytes32(0)) {
                if (w != q.firstWord || ready != q.firstReady) wordMoved = true;
            } else if (w != bytes32(0)) {
                q.firstWord = w;
                q.firstReady = ready;
                if (ready < q.at + 12 || ready > clock) dishonestReady = true;
                _checkFormula(q, w, ready);
            } else if (ready != 0) {
                dishonestReady = true;
            }
            bool silent = q.viaBacked ? src.isSilent(q.consumer, q.key) : drand.isSilent(q.consumer, q.key);
            if (q.silentSeen && !silent) silenceUndone = true;
            // The consumer's own rule (DrandWords.usable, BoxTickets._usableWord): past the 7 days without a word that
            // counts. The keeper reads `isSilent`; both must say the same at every moment.
            bool usable = w != bytes32(0) && ready >= q.at && ready <= clock && ready <= q.at + 7 days;
            if (silent != (clock > q.at + 7 days && !usable)) silenceDisagrees = true;
            if (silent && !q.silentSeen) {
                q.silentSeen = true;
                ++nSilent;
            }
            if (q.viaBacked) {
                (, uint64 target,,) = src.backupOf(q.round);
                Backup memory b = backups[q.round];
                if (target != (b.started ? b.target : 0)) targetMoved = true;
            }
        }
    }

    function _checkFormula(Req storage q, bytes32 w, uint64 ready) internal {
        bytes32 id = _id(q.consumer, q.key);
        (bytes32 randomness,) = drand.beaconOf(q.round);
        Backup memory b = backups[q.round];
        bytes32 want;
        if (!q.viaBacked) {
            want = keccak256(abi.encode(drand.WORD_TAG(), randomness, id));
            ++nDrandWords;
        } else if (b.started) {
            want = keccak256(abi.encode(src.BACKUP_TAG(), chainMix(b.target), id));
            // A backup word is ready only after its round's 5 days (the start) and its target block (the fix).
            if (ready <= drand.roundTime(q.round) + 5 days) dishonestReady = true;
            ++nBackupWords;
        } else {
            want = keccak256(abi.encode(src.DRAND_TAG(), randomness, id));
            ++nDrandWords;
        }
        if (w != want) wrongWord = true;
    }

    // ------------------------------------------------------------------------------------------------------------
    // Views for the invariants

    function heldGhost() external view returns (uint256 sum) {
        for (uint256 i; i < potRounds.length; ++i) {
            sum += pot[potRounds[i]];
        }
        for (uint256 i; i < 3; ++i) {
            sum += owed[posters[i]];
        }
        sum += forcedDrand;
    }

    function viewsAgree() external view returns (bool) {
        for (uint256 i; i < potRounds.length; ++i) {
            if (drand.bountyOf(potRounds[i]) != pot[potRounds[i]]) return false;
        }
        for (uint256 i; i < 3; ++i) {
            if (drand.owedTo(posters[i]) != owed[posters[i]]) return false;
        }
        return true;
    }

    function requestCount() external view returns (uint256) {
        return reqs.length;
    }
}

/// @title AuditU8ClaudeSourcesInvariants (SH-AUDIT-B0 U8: the backed source and the DrandSource under random sequences)
/// @notice The campaign the map's gap 4 asks for (no invariant campaign for BoxBackedSource). Invariants and sources:
/// - P8.1 (`IDrandSource.sol:23-25`, `DrandSource.sol:43-48`, M27): the DrandSource holds Σ unposted pots + Σ
///   unwithdrawn credits + forced ETH, and its views say the same; the backed source holds only forced ETH;
///   withdrawals pay exactly the credit;
/// - P8.2: a first request never fails, a second for the same (consumer, key) never passes;
/// - P8.3, P8.14: posts succeed exactly when due and unposted (a neighbour's signature never); bounties exactly while
///   unposted; `startBackup` succeeds exactly when round time + 5 d < now ≤ + 5 d 18 h, unposted, not started, with a
///   header 1 to 8 blocks old that hashes right; `fixBackup` exactly with the target's honest header 1 to 8,191 blocks
///   after the target, once;
/// - P8.6 (`BoxBackedSource.sol:28-37`, F143): a word never changes once non-zero, nor its time; every word is the
///   documented formula: drand's (`DRAND_TAG`, or the DrandSource's `WORD_TAG`) while the round has no backup, the
///   backup's (`BACKUP_TAG`, the target block's prevRandao) once started, so a drand post after a start is ignored and
///   the word depends on nothing but the target block and the request; a round's target never moves;
/// - P8.7: a request's round is 12 to 14 s after it; `readyAt` is never before the request + 12 s nor in the
///   future, and a backup word's never before its round's time + 5 days;
/// - silence is final on both sources (`IDrandSource.sol:63-64`, `BoxBackedSource.sol:227`) and equals the consumer's
///   own rule (`DrandWords.sol:132-137`, `:154-160`; BoxTickets' copy): past 7 days without a word that counts.
/// The handler starts 14 s before the first committed round, so early requests fix committed rounds (drand can answer)
/// and later ones fix rounds with no signature (only the backup can).
/// forge-config: default.evm_version = "osaka"
contract AuditU8ClaudeSourcesInvariants is Test {
    AuditU8ClaudeSourcesHandler internal handler;
    DrandSource internal drand;
    BoxBackedSource internal src;

    function setUp() public virtual {
        vm.chainId(1);
        drand = PinnedDrandSource.deploy(vm);
        src = PinnedBackedSource.deploy(vm);
        if (History2935.ADDRESS.code.length == 0) vm.etch(History2935.ADDRESS, History2935.CODE);
        handler = new AuditU8ClaudeSourcesHandler(drand, src);
        targetContract(address(handler));
        targetSender(makeAddr("u8inv.sender0"));
        targetSender(makeAddr("u8inv.sender1"));
    }

    function invariant_AUDIT_U8_ethHeldIsPotsCreditsAndForced() public view {
        assertEq(address(drand).balance, handler.heldGhost(), "DrandSource ETH == pots + credits + forced");
        assertTrue(handler.viewsAgree(), "bountyOf and owedTo agree with the ghosts");
        assertFalse(handler.withdrawBroken(), "a withdrawal pays exactly the credit, only when there is one");
    }

    function invariant_AUDIT_U8_backedSourceHoldsOnlyForcedEth() public view {
        assertEq(address(src).balance, handler.forcedBacked());
    }

    function invariant_AUDIT_U8_wordsNeverMove() public view {
        assertFalse(handler.wordMoved());
    }

    function invariant_AUDIT_U8_wordsFollowTheirFormula() public view {
        assertFalse(handler.wrongWord(), "drand's word without a backup, the target's prevRandao with one");
    }

    function invariant_AUDIT_U8_requestsAndRounds() public view {
        assertFalse(handler.firstRequestFailed(), "a first request never fails");
        assertFalse(handler.doubleRequestPassed(), "one request per (consumer, key)");
        assertFalse(handler.roundTooClose(), "the round is 12 to 14 s after the request");
        assertFalse(handler.dishonestReady(), "readyAt never before the request + 12 s nor in the future");
    }

    function invariant_AUDIT_U8_postAndBountyRules() public view {
        assertFalse(handler.postRuleBroken());
        assertFalse(handler.bountyRuleBroken());
    }

    function invariant_AUDIT_U8_backupRules() public view {
        assertFalse(handler.startRuleBroken(), "starts exactly by the rule");
        assertFalse(handler.fixRuleBroken(), "fixes exactly by the rule");
        assertFalse(handler.targetMoved(), "one target per round, never moved");
    }

    function invariant_AUDIT_U8_silenceIsFinal() public view {
        assertFalse(handler.silenceUndone());
    }

    /// @notice The keeper's `isSilent` (both sources) equals the consumer's dead-head rule (DrandWords.usable,
    /// BoxTickets._usableWord) for every request at every moment.
    function invariant_AUDIT_U8_silenceIsTheConsumersRule() public view {
        assertFalse(handler.silenceDisagrees());
    }

    /// Coverage of the run, for the evidence (`-vv`).
    function afterInvariant() public {
        emit log_named_uint("requests", handler.nRequests());
        emit log_named_uint("posts", handler.nPosts());
        emit log_named_uint("posts after a start (ignored by the backed source)", handler.nPostsAfterStart());
        emit log_named_uint("starts", handler.nStarts());
        emit log_named_uint("start refusals", handler.nStartRefusals());
        emit log_named_uint("fixes", handler.nFixes());
        emit log_named_uint("fixes through EIP-2935", handler.nFixesThroughHistory());
        emit log_named_uint("fix refusals", handler.nFixRefusals());
        emit log_named_uint("drand words seen", handler.nDrandWords());
        emit log_named_uint("backup words seen", handler.nBackupWords());
        emit log_named_uint("requests gone silent", handler.nSilent());
        emit log_named_uint("withdrawals", handler.nWithdrawals());
        emit log_named_uint("bounties", handler.nBounties());
        emit log_named_uint("forced ETH", handler.nForced());
    }
}

/// @notice The same campaign under Amsterdam.
/// forge-config: default.evm_version = "amsterdam"
contract AuditU8ClaudeSourcesAmsterdamInvariants is AuditU8ClaudeSourcesInvariants {}

/// @notice The campaign's reach, measured: the same handler driven by a seeded generator through 64 sequences of 128
/// actions (the default campaign's depth), state reverted between sequences, every ghost checked after every action as
/// the invariants do, and the counters summed over all sequences. Pins that the campaign reaches what it is for: starts,
/// refused starts, fixes (also through EIP-2935), refused fixes, drand posts ignored after a start, drand and backup
/// words, silences and withdrawals.
/// forge-config: default.evm_version = "osaka"
contract AuditU8ClaudeSourcesCampaignTest is Test {
    struct Totals {
        uint256 requests;
        uint256 posts;
        uint256 postsAfterStart;
        uint256 starts;
        uint256 startRefusals;
        uint256 fixes;
        uint256 fixesThroughHistory;
        uint256 fixRefusals;
        uint256 drandWords;
        uint256 backupWords;
        uint256 silent;
        uint256 withdrawals;
    }

    DrandSource internal drand;
    BoxBackedSource internal src;
    AuditU8ClaudeSourcesHandler internal handler;

    function setUp() public {
        vm.chainId(1);
        drand = PinnedDrandSource.deploy(vm);
        src = PinnedBackedSource.deploy(vm);
        if (History2935.ADDRESS.code.length == 0) vm.etch(History2935.ADDRESS, History2935.CODE);
        handler = new AuditU8ClaudeSourcesHandler(drand, src);
    }

    function _step(uint256 r) internal {
        uint256 a = r % 9;
        uint256 x = uint256(keccak256(abi.encode(r, 1)));
        uint256 y = uint256(keccak256(abi.encode(r, 2)));
        if (a == 0) handler.request(x, y, x >> 128, (y >> 7) % 4 != 0);
        else if (a == 1) handler.bounty(x, y, (y >> 7) % 2 == 0);
        else if (a == 2) handler.post(x, y);
        else if (a == 3) handler.postWrong(x);
        else if (a == 4) handler.withdraw(x, (y >> 7) % 2 == 0);
        else if (a == 5) handler.startBackup(x, y);
        else if (a == 6) handler.fixBackup(x, y);
        else if (a == 7) handler.forceEth(x, (y >> 7) % 2 == 0);
        else handler.wait(x, y);
    }

    function _check() internal view {
        assertEq(address(drand).balance, handler.heldGhost());
        assertTrue(handler.viewsAgree());
        assertEq(address(src).balance, handler.forcedBacked());
        assertFalse(handler.withdrawBroken());
        assertFalse(handler.wordMoved());
        assertFalse(handler.wrongWord());
        assertFalse(handler.firstRequestFailed());
        assertFalse(handler.doubleRequestPassed());
        assertFalse(handler.roundTooClose());
        assertFalse(handler.dishonestReady());
        assertFalse(handler.postRuleBroken());
        assertFalse(handler.bountyRuleBroken());
        assertFalse(handler.startRuleBroken());
        assertFalse(handler.fixRuleBroken());
        assertFalse(handler.targetMoved());
        assertFalse(handler.silenceUndone());
        assertFalse(handler.silenceDisagrees());
    }

    function _add(Totals memory t) internal view {
        t.requests += handler.nRequests();
        t.posts += handler.nPosts();
        t.postsAfterStart += handler.nPostsAfterStart();
        t.starts += handler.nStarts();
        t.startRefusals += handler.nStartRefusals();
        t.fixes += handler.nFixes();
        t.fixesThroughHistory += handler.nFixesThroughHistory();
        t.fixRefusals += handler.nFixRefusals();
        t.drandWords += handler.nDrandWords();
        t.backupWords += handler.nBackupWords();
        t.silent += handler.nSilent();
        t.withdrawals += handler.nWithdrawals();
    }

    function testProperty_AUDIT_U8_campaignReachesEveryPath() public {
        Totals memory t;
        // 8,192 actions, each re-reading every request's word: far above one test's gas budget, so metering is off
        // (nothing measured here depends on gas; the sources forward all gas to their precompile and history calls).
        vm.pauseGasMetering();
        for (uint256 seq; seq < 64; ++seq) {
            uint256 snap = vm.snapshotState();
            for (uint256 i; i < 128; ++i) {
                _step(uint256(keccak256(abi.encode("u8.campaign", seq, i))));
                _check();
            }
            _add(t);
            vm.revertToState(snap);
        }
        vm.resumeGasMetering();
        emit log_named_uint("requests", t.requests);
        emit log_named_uint("posts", t.posts);
        emit log_named_uint("posts after a start (ignored)", t.postsAfterStart);
        emit log_named_uint("starts", t.starts);
        emit log_named_uint("start refusals", t.startRefusals);
        emit log_named_uint("fixes", t.fixes);
        emit log_named_uint("fixes through EIP-2935", t.fixesThroughHistory);
        emit log_named_uint("fix refusals", t.fixRefusals);
        emit log_named_uint("drand words seen", t.drandWords);
        emit log_named_uint("backup words seen", t.backupWords);
        emit log_named_uint("requests gone silent", t.silent);
        emit log_named_uint("withdrawals", t.withdrawals);
        assertGt(t.starts, 0, "starts");
        assertGt(t.startRefusals, 0, "refused starts");
        assertGt(t.fixes, 0, "fixes");
        assertGt(t.fixesThroughHistory, 0, "fixes through EIP-2935");
        assertGt(t.fixRefusals, 0, "refused fixes");
        assertGt(t.postsAfterStart, 0, "drand posts after a start");
        assertGt(t.drandWords, 0, "drand words");
        assertGt(t.backupWords, 0, "backup words");
        assertGt(t.silent, 0, "silences");
        assertGt(t.withdrawals, 0, "withdrawals");
    }
}
