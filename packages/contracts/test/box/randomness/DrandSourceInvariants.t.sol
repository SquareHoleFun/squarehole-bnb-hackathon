// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {DrandSource} from "../../../src/box/randomness/DrandSource.sol";
import {BoxDrandVectors} from "./utils/BoxDrandVectors.sol";

/// @notice Random sequences against one `DrandSource`: requests by three consumers (any key, any bounty) whose rounds
/// fall on the 16 committed consecutive real rounds, bounties by anyone on those rounds, posts of real rounds by three
/// posters (once each round's time has come), withdrawals, and time passing (seconds to more than 7 days, so silence
/// and late posts occur). The handler keeps its own clock and re-applies it before every action.
contract DrandSourceHandler is BoxDrandVectors {
    struct Req {
        address consumer;
        uint256 key;
        uint256 at;
        uint256 round;
    }

    DrandSource internal immutable src;
    address[3] internal consumers;
    address[3] internal posters;
    uint256 internal first;
    uint256 internal t0;
    uint256 public clock;
    bytes[16] internal sigs;

    Req[] internal reqs;
    mapping(bytes32 => bool) internal requested;
    mapping(bytes32 => bytes32) internal wordSeen;
    mapping(bytes32 => uint64) internal readySeen;
    mapping(bytes32 => bool) internal silentSeen;
    uint256[16] internal pots;
    bool[16] internal posted;
    mapping(address => uint256) public owedGhost;

    uint256 public attempts;
    uint256 public requests;
    uint256 public posts;
    uint256 public latePosts;
    uint256 public silences;
    uint256 public withdrawals;
    bool public wordMoved;
    bool public dishonestReady;
    bool public silenceUndone;
    bool public roundNotAfterRequest;
    bool public doubleRequestPassed;

    constructor(DrandSource src_) {
        src = src_;
        _loadBoxDrand();
        first = _localFirst();
        t0 = src_.roundTime(first);
        for (uint256 i; i < 16; ++i) {
            sigs[i] = _localSig(i);
        }
        consumers = [makeAddr("inv.c0"), makeAddr("inv.c1"), makeAddr("inv.c2")];
        posters = [makeAddr("inv.p0"), makeAddr("inv.p1"), makeAddr("inv.p2")];
        for (uint256 i; i < 3; ++i) {
            vm.deal(consumers[i], 1_000 ether);
        }
        vm.deal(address(this), 1_000 ether);
        clock = t0 - 14;
    }

    // ------------------------------------------------------------------------------------------------------------
    // Actions

    function request(uint256 c, uint256 key, uint256 bounty) external {
        ++attempts;
        vm.warp(clock);
        // Requests only while their round is one of the committed ones: [t0 − 14, t0 + 33].
        if (clock > t0 + 33) return;
        // Hashed, so the fuzzer's favourite values (0, 1, max) still spread over the 24 (consumer, key) pairs.
        address consumer = consumers[uint256(keccak256(abi.encode(c, "c"))) % 3];
        key = uint256(keccak256(abi.encode(key, "k"))) % 8;
        bounty = bound(bounty, 0, 1 ether);
        bytes32 id = keccak256(abi.encode(consumer, key));
        vm.prank(consumer);
        (bool ok, bytes memory ret) = address(src).call{value: bounty}(abi.encodeCall(src.request, (key)));
        if (requested[id]) {
            if (ok) doubleRequestPassed = true;
            return;
        }
        require(ok, "a first request never reverts");
        uint256 round = abi.decode(ret, (uint256));
        if (src.roundTime(round) <= clock) roundNotAfterRequest = true;
        requested[id] = true;
        reqs.push(Req({consumer: consumer, key: key, at: clock, round: round}));
        pots[round - first] += bounty;
        ++requests;
        _observe();
    }

    function bounty(uint256 idx, uint256 amount) external {
        vm.warp(clock);
        idx = idx % 16;
        if (posted[idx]) return;
        amount = bound(amount, 0, 1 ether);
        src.addBounty{value: amount}(first + idx);
        pots[idx] += amount;
        _observe();
    }

    function post(uint256 idx, uint256 p) external {
        vm.warp(clock);
        idx = idx % 16;
        if (posted[idx] || clock < src.roundTime(first + idx)) return;
        address poster = posters[p % 3];
        vm.prank(poster);
        src.postRound(first + idx, sigs[idx]);
        posted[idx] = true;
        owedGhost[poster] += pots[idx];
        pots[idx] = 0;
        ++posts;
        for (uint256 i; i < reqs.length; ++i) {
            if (reqs[i].round == first + idx && clock > reqs[i].at + 7 days) {
                ++latePosts;
                break;
            }
        }
        _observe();
    }

    function withdraw(uint256 p) external {
        vm.warp(clock);
        address poster = posters[p % 3];
        if (owedGhost[poster] == 0) return;
        vm.prank(poster);
        src.withdrawBounty(payable(poster));
        owedGhost[poster] = 0;
        ++withdrawals;
        _observe();
    }

    /// Moves 0 to 4 s while requests can still land on the committed rounds; after that window, one call in eight
    /// jumps a day to eight days (silence, late posts).
    function wait(uint256 dt) external {
        uint256 h = uint256(keccak256(abi.encode(dt, clock)));
        clock += clock > t0 + 33 && h % 8 == 0 ? 1 days + h % 7 days : h % 5;
        vm.warp(clock);
        _observe();
    }

    // ------------------------------------------------------------------------------------------------------------
    // Ghost checks after every action

    function _observe() internal {
        for (uint256 i; i < reqs.length; ++i) {
            Req memory q = reqs[i];
            bytes32 id = keccak256(abi.encode(q.consumer, q.key));
            (bytes32 w, uint64 ready) = src.wordOf(q.consumer, q.key);
            if (wordSeen[id] != 0) {
                if (w != wordSeen[id] || ready != readySeen[id]) wordMoved = true;
            } else if (w != 0) {
                wordSeen[id] = w;
                readySeen[id] = ready;
                if (ready < q.at + src.MARGIN() || ready > clock) dishonestReady = true;
            } else if (ready != 0) {
                dishonestReady = true;
            }
            bool silent = src.isSilent(q.consumer, q.key);
            if (silentSeen[id] && !silent) silenceUndone = true;
            if (silent && !silentSeen[id]) {
                silentSeen[id] = true;
                ++silences;
            }
        }
    }

    // ------------------------------------------------------------------------------------------------------------
    // Views for the invariants

    function held() external view returns (uint256 sum) {
        for (uint256 i; i < 16; ++i) {
            sum += pots[i];
        }
        for (uint256 i; i < 3; ++i) {
            sum += owedGhost[posters[i]];
        }
    }

    function viewsAgree() external view returns (bool) {
        for (uint256 i; i < 16; ++i) {
            if (src.bountyOf(first + i) != pots[i]) return false;
        }
        for (uint256 i; i < 3; ++i) {
            if (src.owedTo(posters[i]) != owedGhost[posters[i]]) return false;
        }
        return true;
    }
}

/// @notice Invariants of `DrandSource` (slice S9) under the handler: the ETH held equals the pots of unposted rounds
/// plus the credits not withdrawn, and the views say the same; a word never moves once given; `readyAt` is never
/// before the request plus the margin nor in the future; silence is final; a request's round is always after its
/// block; a first request never reverts (the handler requires it) and a second never passes.
/// forge-config: default.evm_version = "osaka"
/// forge-config: default.invariant.depth = 256
contract DrandSourceInvariantsTest is Test {
    DrandSourceHandler internal handler;
    DrandSource internal src;

    function setUp() public {
        src = new DrandSource();
        handler = new DrandSourceHandler(src);
        targetContract(address(handler));
        targetSender(makeAddr("inv.sender0"));
        targetSender(makeAddr("inv.sender1"));
    }

    function invariant_holdsExactlyThePotsAndCredits() public view {
        assertEq(address(src).balance, handler.held());
        assertTrue(handler.viewsAgree());
    }

    function invariant_wordsNeverMove() public view {
        assertFalse(handler.wordMoved());
    }

    function invariant_readyAtIsHonest() public view {
        assertFalse(handler.dishonestReady());
    }

    function invariant_silenceIsFinal() public view {
        assertFalse(handler.silenceUndone());
    }

    function invariant_roundAfterTheRequestAndOneRequestPerKey() public view {
        assertFalse(handler.roundNotAfterRequest());
        assertFalse(handler.doubleRequestPassed());
    }

    /// Coverage of the run, for the evidence (`-vv`).
    function afterInvariant() public {
        emit log_named_uint("request attempts", handler.attempts());
        emit log_named_uint("requests", handler.requests());
        emit log_named_uint("clock past the start", handler.clock());
        emit log_named_uint("rounds posted", handler.posts());
        emit log_named_uint("posts after a request's 7 days", handler.latePosts());
        emit log_named_uint("requests gone silent", handler.silences());
        emit log_named_uint("withdrawals", handler.withdrawals());
    }
}
