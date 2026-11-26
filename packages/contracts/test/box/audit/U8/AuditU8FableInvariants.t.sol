// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {IDrandSource} from "../../../../src/box/interfaces/IDrandSource.sol";
import {BoxBackedSource} from "../../../../src/box/randomness/BoxBackedSource.sol";
import {DrandSource} from "../../../../src/box/randomness/DrandSource.sol";
import {HeaderVectors} from "../../backup/HeaderVectors.sol";
import {History2935} from "../../backup/History2935.sol";
import {BoxDrandVectors} from "../../randomness/utils/BoxDrandVectors.sol";
import {AuditHeaders} from "../common/AuditHeaders.sol";
import {AuditU8FableBase} from "./AuditU8FableBase.sol";

/// @title AuditU8FableHandler
/// @notice TEST ONLY (SH-AUDIT-B0-U8-F). Random sequences against the world's pinned DrandSource and BoxBackedSource
/// with box 0's tickets as one consumer (the graduation word, key 0, requested on r0 by `_toGraduated`) and four
/// direct consumers (two keys each, through the backed source or the DrandSource): requests with bounties, bounties
/// on any round seen, posts of the 16 committed rounds by three posters (from each round's time), withdrawals to the
/// poster or to a refusing recipient, backup starts and fixes (honest headers, forged headers; at the clock as it
/// stands, or with the clock first moved into the round's start window or past its target, so started and fixed
/// rounds are reached often) and time and block warps of 12 s, 1 h, 1 d, to a round's 5 days (±1 s), 5 days 18
/// hours (±1 s), a request's 7 days (±1 s) and a target's 8,191 blocks (±1). The handler keeps its own clock
/// (forward only) and re-applies it before every action, pre-computes
/// the rule's verdict for every start and fix from its ghost state and requires the contract to agree, and after
/// every action re-reads every request against a ghost model of the words (drand's word while no backup started,
/// the backup's once fixed, nothing otherwise), their immutability, `readyAt`, silence and the ETH equality. Every
/// call is fail-safe: a refused action is expected or counted, never a revert of the handler (fail_on_revert).
contract AuditU8FableHandler is BoxDrandVectors {
    struct Req {
        address consumer;
        uint256 key;
        uint256 at;
        uint256 round;
        bool viaBacked;
    }

    DrandSource internal immutable drand;
    BoxBackedSource internal immutable src;
    address internal immutable ticketsAddr;
    uint256 internal immutable r0;
    uint256 internal immutable t0;

    address[4] internal consumers;
    address[3] internal posters;
    address internal immutable refuser;
    bytes[16] internal sigs;
    bytes32[16] internal randomness;

    uint256 public clock;
    uint256 public blockNo;

    Req[] internal reqs;
    uint256[] internal roundsSeen;
    mapping(uint256 => bool) internal seen;
    mapping(bytes32 => bool) internal requested;
    mapping(bytes32 => bytes32) internal wordSeen;
    mapping(bytes32 => uint64) internal readySeen;
    mapping(bytes32 => bool) internal silentSeen;
    mapping(uint256 => uint256) internal pots;
    mapping(uint256 => bool) internal posted;
    mapping(uint256 => uint256) internal startedAt;
    mapping(uint256 => uint256) internal targetOf;
    mapping(uint256 => bool) internal fixedRound;
    mapping(uint256 => bytes32) internal mixOf;
    mapping(address => uint256) internal owedGhost;

    // Counters for the evidence.
    uint256 public requests;
    uint256 public requestsRefused;
    uint256 public bounties;
    uint256 public posts;
    uint256 public postsIgnoredByABackup;
    uint256 public withdrawals;
    uint256 public withdrawalsRefused;
    uint256 public starts;
    uint256 public startsRefused;
    uint256 public fixes;
    uint256 public fixesRefused;
    uint256 public forgedFixesRefused;
    uint256 public silences;
    uint256 public warps;
    uint256 public edgeWarps;

    // What must never happen.
    bool public wordMoved;
    bool public modelMismatch;
    bool public dishonestReady;
    bool public silenceUndone;
    bool public roundNotAfterRequest;
    bool public doubleRequestPassed;
    bool public targetMoved;
    bool public ruleDisagreed;
    bool public ethMismatch;
    bool public backedHoldsEth;

    constructor(
        DrandSource drand_,
        BoxBackedSource src_,
        address tickets_,
        uint256 r0_,
        address[4] memory consumers_,
        address[3] memory posters_,
        address refuser_
    ) {
        drand = drand_;
        src = src_;
        ticketsAddr = tickets_;
        r0 = r0_;
        _loadBoxDrand();
        t0 = drand_.roundTime(r0_);
        for (uint256 i; i < 16; ++i) {
            Round memory r = _boxDrand(r0_ + i);
            sigs[i] = r.xy;
            randomness[i] = r.randomness;
        }
        consumers = consumers_;
        posters = posters_;
        refuser = refuser_;
        for (uint256 i; i < 4; ++i) {
            vm.deal(consumers[i], 1_000 ether);
        }
        clock = vm.getBlockTimestamp();
        blockNo = vm.getBlockNumber();
        // The tickets' graduation word, already requested on r0 by the world.
        (uint64 at, uint64 round) = src.requestOf(tickets_, 0);
        require(round == r0_ && at != 0, "handler: the graduation word is requested on r0");
        reqs.push(Req({consumer: tickets_, key: 0, at: at, round: round, viaBacked: true}));
        requested[keccak256(abi.encode(tickets_, uint256(0), true))] = true;
        _see(r0_);
    }

    // ------------------------------------------------------------------------------------------------ clock

    function _sync() internal {
        vm.warp(clock);
        vm.roll(blockNo);
    }

    /// @dev Moves `dt` seconds and the blocks that fit in them at 12 s (at least one when dt > 0).
    function _move(uint256 dt) internal {
        if (dt == 0) return;
        clock += dt;
        blockNo += (dt + 11) / 12;
        ++warps;
    }

    function _moveTo(uint256 t) internal {
        if (t > clock) _move(t - clock);
    }

    function _see(uint256 round) internal {
        if (!seen[round]) {
            seen[round] = true;
            roundsSeen.push(round);
        }
    }

    function _pick(uint256 idx) internal view returns (uint256) {
        return roundsSeen[idx % roundsSeen.length];
    }

    // ------------------------------------------------------------------------------------------------ actions

    function request(uint256 c, uint256 k, uint256 bounty, bool viaBacked) external {
        _sync();
        address consumer = consumers[c % 4];
        uint256 key = 1 + (k % 2);
        bounty = bound(bounty, 0, 1 ether);
        bytes32 tag = keccak256(abi.encode(consumer, key, viaBacked));
        vm.prank(consumer);
        (bool ok, bytes memory ret) = viaBacked
            ? address(src).call{value: bounty}(abi.encodeCall(src.request, (key)))
            : address(drand).call{value: bounty}(abi.encodeCall(drand.request, (key)));
        if (requested[tag]) {
            if (ok) doubleRequestPassed = true;
            ++requestsRefused;
            _observe();
            return;
        }
        require(ok, "handler: a first request never reverts");
        uint256 round = abi.decode(ret, (uint256));
        if (drand.roundTime(round) <= clock) roundNotAfterRequest = true;
        requested[tag] = true;
        reqs.push(Req({consumer: consumer, key: key, at: clock, round: round, viaBacked: viaBacked}));
        pots[round] += bounty;
        _see(round);
        ++requests;
        _observe();
    }

    function bounty(uint256 idx, uint256 amount, bool viaBacked) external {
        _sync();
        uint256 round = _pick(idx);
        amount = bound(amount, 0, 1 ether);
        vm.deal(address(this), address(this).balance + amount);
        (bool ok, bytes memory ret) = viaBacked
            ? address(src).call{value: amount}(abi.encodeCall(src.addBounty, (round)))
            : address(drand).call{value: amount}(abi.encodeCall(drand.addBounty, (round)));
        if (posted[round]) {
            require(!ok && bytes4(ret) == IDrandSource.RoundKnown.selector, "handler: a bounty on a known round");
            _observe();
            return;
        }
        require(ok, "handler: a bounty on an unposted round lands");
        pots[round] += amount;
        ++bounties;
        _observe();
    }

    function post(uint256 i, uint256 p) external {
        _sync();
        uint256 idx = i % 16;
        uint256 round = r0 + idx;
        address poster = posters[p % 3];
        vm.prank(poster);
        (bool ok, bytes memory ret) = address(drand).call(abi.encodeCall(drand.postRound, (round, sigs[idx])));
        if (posted[round]) {
            require(!ok && bytes4(ret) == IDrandSource.RoundKnown.selector, "handler: a second post");
            _observe();
            return;
        }
        if (clock < t0 + 3 * idx) {
            require(!ok && bytes4(ret) == IDrandSource.RoundNotYet.selector, "handler: a post before its time");
            _observe();
            return;
        }
        require(ok, "handler: a post from the round's time lands");
        require(abi.decode(ret, (bytes32)) == randomness[idx], "handler: the published randomness");
        posted[round] = true;
        owedGhost[poster] += pots[round];
        pots[round] = 0;
        _see(round);
        ++posts;
        if (startedAt[round] != 0) ++postsIgnoredByABackup;
        _observe();
    }

    function withdraw(uint256 p, bool toRefuser) external {
        _sync();
        address poster = posters[p % 3];
        address to = toRefuser ? refuser : poster;
        vm.prank(poster);
        (bool ok, bytes memory ret) = address(drand).call(abi.encodeCall(drand.withdrawBounty, (payable(to))));
        if (owedGhost[poster] == 0) {
            require(!ok && bytes4(ret) == IDrandSource.NothingOwed.selector, "handler: nothing owed");
            ++withdrawalsRefused;
        } else if (toRefuser) {
            require(!ok && bytes4(ret) == IDrandSource.WithdrawFailed.selector, "handler: a refused withdrawal");
            ++withdrawalsRefused;
        } else {
            require(ok && abi.decode(ret, (uint256)) == owedGhost[poster], "handler: the whole credit");
            owedGhost[poster] = 0;
            ++withdrawals;
        }
        _observe();
    }

    /// @notice A start at the clock as it stands (the rule's verdict pre-computed and required).
    function start(uint256 idx, uint256 who) external {
        _sync();
        _start(_pick(idx), consumers[who % 4]);
    }

    /// @notice A start with the clock first moved into the round's window when it lies ahead (5 days + 1 s … 5 days
    /// 18 hours after the round's time, `off` choosing the moment), so the campaign reaches started and fixed rounds
    /// often; a round already posted or started stays refused by the same rule.
    function startInWindow(uint256 idx, uint256 who, uint256 off) external {
        _sync();
        uint256 round = _pick(idx);
        uint256 rt = drand.roundTime(round);
        if (clock <= rt + 5 days) {
            _moveTo(rt + 5 days + 1 + (off % 18 hours));
            ++edgeWarps;
            _sync();
        }
        _start(round, consumers[who % 4]);
    }

    function _start(uint256 round, address starter) internal {
        uint256 rt = drand.roundTime(round);
        bytes memory parent = HeaderVectors.MAINNET;
        vm.setBlockhash(blockNo - 1, keccak256(parent));
        vm.prank(starter);
        (bool ok, bytes memory ret) = address(src).call(abi.encodeCall(src.startBackup, (round, blockNo - 1, parent)));
        bytes4 expected;
        if (clock <= rt + 5 days) expected = BoxBackedSource.BackupTooEarly.selector;
        else if (clock > rt + 5 days + 18 hours) expected = BoxBackedSource.BackupTooLate.selector;
        else if (startedAt[round] != 0) expected = BoxBackedSource.BackupAlreadyStarted.selector;
        else if (posted[round]) expected = BoxBackedSource.RoundAlreadyPosted.selector;
        if (expected != bytes4(0)) {
            if (ok || bytes4(ret) != expected) ruleDisagreed = true;
            ++startsRefused;
            _observe();
            return;
        }
        if (!ok) ruleDisagreed = true;
        require(ok, "handler: an allowed start lands");
        startedAt[round] = clock;
        targetOf[round] = blockNo + 256;
        require(abi.decode(ret, (uint256)) == blockNo + 256, "handler: the target is the block + 256");
        ++starts;
        _observe();
    }

    /// @notice A fix at the block as it stands, honest or forged (the rule's verdict pre-computed and required).
    function fix(uint256 idx, bool honest, uint256 who) external {
        _sync();
        _fix(_pick(idx), honest, consumers[who % 4]);
    }

    /// @notice A fix with the blocks first moved past the target when it lies ahead (target + 1 … target + 8,191,
    /// `off` choosing the block), honest or forged.
    function fixInWindow(uint256 idx, bool honest, uint256 who, uint256 off) external {
        _sync();
        uint256 round = _pick(idx);
        uint256 target = targetOf[round];
        if (target != 0 && !fixedRound[round] && blockNo <= target) {
            uint256 wanted = target + 1 + (off % 8191);
            clock += 12 * (wanted - blockNo);
            blockNo = wanted;
            ++warps;
            ++edgeWarps;
            _sync();
        }
        _fix(round, honest, consumers[who % 4]);
    }

    function _fix(uint256 round, bool honest, address fixer) internal {
        uint256 target = targetOf[round];
        bytes4 expected;
        if (startedAt[round] == 0) expected = BoxBackedSource.NoBackup.selector;
        else if (fixedRound[round]) expected = BoxBackedSource.BackupAlreadyFixed.selector;
        else if (blockNo <= target || blockNo - target > 8191) expected = BoxBackedSource.HeaderUnavailable.selector;
        bytes memory h;
        if (expected == bytes4(0)) {
            // The chain's one header for the target (its prevRandao fixed by the target), served as the chain would.
            bytes32 mix = keccak256(abi.encode("audit.u8.randao", target));
            bytes memory real = AuditHeaders.header(target, mix);
            if (blockNo - target <= 256) vm.setBlockhash(target, keccak256(real));
            History2935.put(vm, target, keccak256(real));
            h = honest ? real : AuditHeaders.header(target, keccak256(abi.encode("forged", round, fixer)));
            if (!honest) expected = BoxBackedSource.WrongHeader.selector;
        } else {
            h = AuditHeaders.header(target, bytes32(0));
        }
        vm.prank(fixer);
        (bool ok, bytes memory ret) = address(src).call(abi.encodeCall(src.fixBackup, (round, h)));
        if (expected != bytes4(0)) {
            if (ok || bytes4(ret) != expected) ruleDisagreed = true;
            if (expected == BoxBackedSource.WrongHeader.selector) ++forgedFixesRefused;
            else ++fixesRefused;
            _observe();
            return;
        }
        if (!ok) ruleDisagreed = true;
        require(ok, "handler: an honest fix inside the window lands");
        fixedRound[round] = true;
        mixOf[round] = keccak256(abi.encode("audit.u8.randao", target));
        require(abi.decode(ret, (bytes32)) == mixOf[round], "handler: the mix is the header's field 13");
        ++fixes;
        _observe();
    }

    /// @notice Time: 0 a block (12 s), 1 an hour, 2 a day, 3 to a round's 5 days (−1, 0, +1 s), 4 to its 5 days
    /// 18 hours (−1, 0, +1 s), 5 to a request's 7 days (−1, 0, +1 s), 6 to a target + 8,191 blocks (−1, 0, +1).
    function warp(uint256 kind, uint256 idx, uint256 off) external {
        _sync();
        uint256 k = kind % 7;
        uint256 o = off % 3; // −1, 0, +1
        if (k == 0) {
            _move(12);
        } else if (k == 1) {
            _move(1 hours);
        } else if (k == 2) {
            _move(1 days);
        } else if (k == 3 || k == 4) {
            uint256 rt = drand.roundTime(_pick(idx));
            uint256 t = rt + (k == 3 ? 5 days : 5 days + 18 hours) + o - 1;
            _moveTo(t);
            ++edgeWarps;
        } else if (k == 5) {
            Req memory q = reqs[idx % reqs.length];
            _moveTo(q.at + 7 days + o - 1);
            ++edgeWarps;
        } else {
            uint256 round = _pick(idx);
            if (targetOf[round] != 0) {
                uint256 wanted = targetOf[round] + 8191 + o - 1;
                if (wanted > blockNo) {
                    uint256 blocks = wanted - blockNo;
                    clock += 12 * blocks;
                    blockNo = wanted;
                    ++warps;
                    ++edgeWarps;
                }
            } else {
                _move(12);
            }
        }
        _sync();
        _observe();
    }

    // ------------------------------------------------------------------------------------------------ the ghost

    function _expected(Req memory q) internal view returns (bytes32 word, uint64 readyAt) {
        bytes32 id = keccak256(abi.encode(q.consumer, q.key));
        uint256 round = q.round;
        if (!q.viaBacked) {
            if (!posted[round]) return (0, 0);
            (bytes32 rnd, uint64 at) = drand.beaconOf(round);
            return (keccak256(abi.encode(drand.WORD_TAG(), rnd, keccak256(abi.encode(q.consumer, q.key)))), at);
        }
        if (startedAt[round] == 0) {
            if (!posted[round]) return (0, 0);
            (bytes32 rnd, uint64 at) = drand.beaconOf(round);
            return (keccak256(abi.encode(src.DRAND_TAG(), rnd, id)), at);
        }
        if (!fixedRound[round]) return (0, 0);
        (,, uint64 fixedAt,) = src.backupOf(round);
        return (keccak256(abi.encode(src.BACKUP_TAG(), mixOf[round], id)), fixedAt);
    }

    function _observe() internal {
        for (uint256 i; i < reqs.length; ++i) {
            Req memory q = reqs[i];
            bytes32 tag = keccak256(abi.encode(q.consumer, q.key, q.viaBacked));
            (bytes32 w, uint64 ready) = q.viaBacked ? src.wordOf(q.consumer, q.key) : drand.wordOf(q.consumer, q.key);
            (bytes32 ew, uint64 er) = _expected(q);
            if (w != ew || ready != er) modelMismatch = true;
            if (wordSeen[tag] != 0) {
                if (w != wordSeen[tag] || ready != readySeen[tag]) wordMoved = true;
            } else if (w != 0) {
                wordSeen[tag] = w;
                readySeen[tag] = ready;
                if (ready < q.at + 12 || ready > clock) dishonestReady = true;
            } else if (ready != 0) {
                dishonestReady = true;
            }
            bool silent = q.viaBacked ? src.isSilent(q.consumer, q.key) : drand.isSilent(q.consumer, q.key);
            if (silentSeen[tag] && !silent) silenceUndone = true;
            if (silent && !silentSeen[tag]) {
                silentSeen[tag] = true;
                ++silences;
            }
        }
        for (uint256 i; i < roundsSeen.length; ++i) {
            uint256 round = roundsSeen[i];
            (uint64 s, uint64 t, uint64 f, bytes32 m) = src.backupOf(round);
            if (uint256(s) != startedAt[round] || uint256(t) != targetOf[round]) targetMoved = true;
            if ((f != 0) != fixedRound[round] || m != mixOf[round]) targetMoved = true;
        }
        if (address(drand).balance != held()) ethMismatch = true;
        if (address(src).balance != 0) backedHoldsEth = true;
    }

    // ------------------------------------------------------------------------------------------------ views

    function held() public view returns (uint256 sum) {
        for (uint256 i; i < roundsSeen.length; ++i) {
            sum += pots[roundsSeen[i]];
        }
        for (uint256 i; i < 3; ++i) {
            sum += owedGhost[posters[i]];
        }
    }

    function viewsAgree() external view returns (bool) {
        for (uint256 i; i < roundsSeen.length; ++i) {
            if (drand.bountyOf(roundsSeen[i]) != pots[roundsSeen[i]]) return false;
            if (src.bountyOf(roundsSeen[i]) != pots[roundsSeen[i]]) return false;
        }
        for (uint256 i; i < 3; ++i) {
            if (drand.owedTo(posters[i]) != owedGhost[posters[i]]) return false;
        }
        return true;
    }

    function requestCount() external view returns (uint256) {
        return reqs.length;
    }

    function roundsSeenCount() external view returns (uint256) {
        return roundsSeen.length;
    }

    receive() external payable {}
}

/// @title AuditU8FableInvariants (SH-AUDIT-B0-U8-F)
/// @notice The invariants of the two sources under the handler, on the shared world at graduation (box 0's
/// graduation word requested on r0, drand not yet posted): ETH held == Σ unposted pots + Σ unwithdrawn credits and
/// the views agree; the backed source holds nothing; words never move once non-zero and always equal the model
/// (drand first, the backup after a start, a post after a start ignored); one target per round, never re-set;
/// readyAt honest; silence final; one request per (consumer, key) with its round after the block; every start and
/// fix verdict the rule gives agrees with the ghost's (IDrandSource.sol:23-25; BoxBackedSource.sol:7-54; F143;
/// BC-053; X11). Osaka; the Amsterdam variant below.
/// forge-config: default.evm_version = "osaka"
contract AuditU8FableInvariants is AuditU8FableBase {
    AuditU8FableHandler internal handler;

    function setUp() public virtual override {
        super.setUp();
        _toGraduated();
        handler = new AuditU8FableHandler(
            drand,
            src,
            a.tickets,
            r0,
            [eoa[0], eoa[1], eoa[2], address(contractDrawer)],
            [eoa[3], eoa[4], eoa7702],
            address(ethRefuser)
        );
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](9);
        selectors[0] = handler.request.selector;
        selectors[1] = handler.bounty.selector;
        selectors[2] = handler.post.selector;
        selectors[3] = handler.withdraw.selector;
        selectors[4] = handler.start.selector;
        selectors[5] = handler.fix.selector;
        selectors[6] = handler.warp.selector;
        selectors[7] = handler.startInWindow.selector;
        selectors[8] = handler.fixInWindow.selector;
        targetSelector(StdInvariant.FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function invariant_AUDIT_U8_ethHeldEqualsPotsPlusCredits() public view {
        assertFalse(handler.ethMismatch(), "the DrandSource held other than pots + credits after an action");
        assertEq(address(drand).balance, handler.held());
        assertTrue(handler.viewsAgree());
    }

    function invariant_AUDIT_U8_backedSourceHoldsNoEth() public view {
        assertFalse(handler.backedHoldsEth());
        assertEq(address(src).balance, 0);
    }

    function invariant_AUDIT_U8_wordsNeverMove() public view {
        assertFalse(handler.wordMoved());
    }

    function invariant_AUDIT_U8_wordsFollowDrandFirstThenTheBackup() public view {
        assertFalse(handler.modelMismatch());
    }

    function invariant_AUDIT_U8_oneTargetPerRoundNeverReset() public view {
        assertFalse(handler.targetMoved());
    }

    function invariant_AUDIT_U8_readyAtIsHonest() public view {
        assertFalse(handler.dishonestReady());
    }

    function invariant_AUDIT_U8_silenceIsFinal() public view {
        assertFalse(handler.silenceUndone());
    }

    function invariant_AUDIT_U8_oneRequestPerKeyAndRoundAfterTheBlock() public view {
        assertFalse(handler.roundNotAfterRequest());
        assertFalse(handler.doubleRequestPassed());
    }

    function invariant_AUDIT_U8_startAndFixFollowTheRule() public view {
        assertFalse(handler.ruleDisagreed());
    }

    /// Coverage of the run, for the evidence (`-vv`).
    function afterInvariant() public {
        emit log_named_uint("requests (direct consumers)", handler.requests());
        emit log_named_uint("requests refused (double)", handler.requestsRefused());
        emit log_named_uint("rounds seen", handler.roundsSeenCount());
        emit log_named_uint("bounties", handler.bounties());
        emit log_named_uint("posts", handler.posts());
        emit log_named_uint("posts ignored by a started backup", handler.postsIgnoredByABackup());
        emit log_named_uint("withdrawals", handler.withdrawals());
        emit log_named_uint("withdrawals refused", handler.withdrawalsRefused());
        emit log_named_uint("backup starts", handler.starts());
        emit log_named_uint("starts refused by the rule", handler.startsRefused());
        emit log_named_uint("fixes", handler.fixes());
        emit log_named_uint("fixes refused (no backup, done, out of window)", handler.fixesRefused());
        emit log_named_uint("forged fixes refused", handler.forgedFixesRefused());
        emit log_named_uint("requests gone silent", handler.silences());
        emit log_named_uint("warps", handler.warps());
        emit log_named_uint("edge warps (5 d, 5 d 18 h, 7 d, 8,191 blocks)", handler.edgeWarps());
        emit log_named_uint("clock past the start (s)", handler.clock() - (drand.roundTime(r0) - 12));
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU8FableAmsterdamInvariants is AuditU8FableInvariants {
    function _evm() internal pure override returns (string memory) {
        return "amsterdam";
    }
}
