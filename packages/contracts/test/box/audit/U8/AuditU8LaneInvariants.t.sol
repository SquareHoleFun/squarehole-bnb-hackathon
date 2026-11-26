// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {
    AuditU8LaneBase,
    AuditU8LaneHeaders,
    DrandSource,
    BoxBackedSource,
    IDrandSource,
    History2935
} from "./AuditU8LaneBase.sol";
import {Test} from "forge-std/Test.sol";
import {BoxDrandVectors} from "../../randomness/utils/BoxDrandVectors.sol";

/// @notice S5M4-style non-aborting driver; no substituted source code. Independent pots/credits and sticky failures.
/// Header hashes are installed as in test/box/backup; HISTORY uses its actual committed runtime.
contract AuditU8LaneHandler is BoxDrandVectors {
    struct Request {
        bool wrap;
        address consumer;
        uint256 key;
        uint256 round;
        uint256 at;
        bytes32 word;
        uint64 ready;
        bool silent;
    }
    DrandSource public immutable drand;
    BoxBackedSource public immutable backed;
    uint256 public immutable first;
    uint256 public clock;
    uint256 public height;
    uint256 public extra;
    uint256 public failures;
    uint256[8] public successes;
    Request[] internal requests;
    uint256[] internal rounds;
    mapping(uint256 => bool) internal tracked;
    mapping(bytes32 => bool) internal seen;
    mapping(uint256 => uint256) public pots;
    mapping(address => uint256) public credits;
    mapping(uint256 => uint64) public targets;
    mapping(uint256 => uint64) internal started;
    mapping(uint256 => uint64) internal fixedTimes;
    mapping(uint256 => bytes32) internal fixedMixes;
    bytes[16] internal signatures;
    address[3] internal posters = [address(0xA001), address(0xA002), address(0xA003)];

    constructor(DrandSource d, BoxBackedSource b) {
        drand = d;
        backed = b;
        _loadBoxDrand();
        first = _localFirst();
        height = block.number;
        for (uint256 i; i < 16; ++i) {
            signatures[i] = _localSig(i);
            clock = d.roundTime(first + i) - 12;
            _sync();
            _request(false, address(0xC001), i, 1000);
            _request(true, address(0xC001), i, 2000);
        }
        _observe();
    }

    function _sync() internal {
        vm.warp(clock);
        vm.roll(height);
    }

    function _track(uint256 r) internal {
        if (!tracked[r]) {
            tracked[r] = true;
            rounds.push(r);
        }
    }

    function _request(bool wrap, address c, uint256 k, uint256 amount) internal {
        bytes32 id = keccak256(abi.encode(wrap, c, k));
        vm.deal(c, c.balance + amount);
        vm.prank(c);
        address source = wrap ? address(backed) : address(drand);
        (bool ok, bytes memory ret) = source.call{value: amount}(abi.encodeCall(IDrandSource.request, (k)));
        if (seen[id]) {
            if (ok) failures |= 1;
            return;
        }
        if (!ok || ret.length != 32) {
            failures |= 2;
            return;
        }
        uint256 r = abi.decode(ret, (uint256));
        uint256 expected = (clock + 12 - 1_692_803_367 + 2) / 3 + 1;
        if (r != expected) failures |= 4;
        seen[id] = true;
        requests.push(Request(wrap, c, k, r, clock, 0, 0, false));
        _track(r);
        pots[r] += amount;
        ++successes[0];
    }

    function request(uint256 seed, uint256 key, uint256 value) external {
        _sync();
        // Finite consumer/key universe keeps each sequence's observation cost bounded.
        _request(seed % 2 == 0, address(uint160(0xC001 + seed % 3)), key % 16, value % 1 ether);
        _observe();
    }

    function bounty(uint256 index, uint256 amount, bool viaBacked) external {
        _sync();
        uint256 r = first + index % 16;
        amount %= 1 ether;
        vm.deal(address(this), amount);
        address s = viaBacked ? address(backed) : address(drand);
        (, uint64 postedAt) = drand.beaconOf(r);
        (bool ok,) = s.call{value: amount}(abi.encodeCall(IDrandSource.addBounty, (r)));
        if (postedAt == 0 && !ok || postedAt != 0 && ok) failures |= 8;
        if (ok) {
            _track(r);
            pots[r] += amount;
            ++successes[1];
        }
        _observe();
    }

    function post(uint256 index, uint256 poster) external {
        _sync();
        uint256 i = index % 16;
        uint256 r = first + i;
        address p = posters[poster % 3];
        (, uint64 postedAt) = drand.beaconOf(r);
        vm.prank(p);
        (bool ok,) = address(drand).call(abi.encodeCall(drand.postRound, (r, signatures[i])));
        bool expected = postedAt == 0 && clock >= drand.roundTime(r);
        if (ok != expected) failures |= 16;
        if (ok) {
            credits[p] += pots[r];
            pots[r] = 0;
            ++successes[2];
        }
        _observe();
    }

    function withdraw(uint256 poster) external {
        _sync();
        address p = posters[poster % 3];
        uint256 beforeBalance = p.balance;
        uint256 owed = credits[p];
        vm.prank(p);
        (bool ok,) = address(drand).call(abi.encodeCall(drand.withdrawBounty, (payable(p))));
        if (ok != (owed > 0)) failures |= 32;
        if (ok) {
            if (p.balance - beforeBalance != owed) failures |= 32;
            credits[p] = 0;
            ++successes[3];
        }
        _observe();
    }

    function start(uint256 index, uint256 actor) external {
        _sync();
        uint256 r = first + index % 16;
        bytes memory h = AuditU8LaneHeaders.header(height - 1, keccak256("start mix"), actor % 6);
        vm.setBlockhash(height - 1, keccak256(h));
        (, uint64 postedAt) = drand.beaconOf(r);
        uint256 t = drand.roundTime(r);
        bool expected = clock > t + 5 days && clock <= t + 5 days + 18 hours && postedAt == 0 && targets[r] == 0;
        vm.prank(address(uint160(0xD001 + actor % 3)));
        (bool ok, bytes memory ret) = address(backed).call(abi.encodeCall(backed.startBackup, (r, height - 1, h)));
        if (ok != expected) failures |= 64;
        if (ok) {
            if (abi.decode(ret, (uint256)) != height + 256) failures |= 64;
            targets[r] = uint64(height + 256);
            started[r] = uint64(clock);
            ++successes[4];
        }
        _observe();
    }

    function fix(uint256 index, uint256 actor) external {
        _sync();
        uint256 r = first + index % 16;
        uint256 target = targets[r];
        // The same target always has the same header/mix, independently of who fixes and when.
        bytes32 mix = keccak256(abi.encode("block prevRandao", target));
        bytes memory h = AuditU8LaneHeaders.header(target, mix, 4);
        if (target > 0 && height > target) {
            if (height - target <= 256) vm.setBlockhash(target, keccak256(h));
            History2935.put(vm, target, keccak256(h));
        }
        bool expected = target != 0 && height > target && height - target <= 8191 && fixedTimes[r] == 0;
        vm.prank(address(uint160(0xE001 + actor % 3)));
        (bool ok, bytes memory ret) = address(backed).call(abi.encodeCall(backed.fixBackup, (r, h)));
        if (ok != expected) failures |= 128;
        if (ok) {
            if (abi.decode(ret, (bytes32)) != mix) failures |= 128;
            fixedTimes[r] = uint64(clock);
            fixedMixes[r] = mix;
            ++successes[5];
        }
        _observe();
    }

    function advance(uint256 seed, uint256 index) external {
        _sync();
        uint256 r = first + index % 16;
        uint256 kind = seed % 12;
        uint256 next = clock;
        if (kind < 2) {
            next += seed % 49;
        } else if (kind < 7) {
            uint256[5] memory offsets =
                [uint256(5 days - 1), 5 days, 5 days + 1, 5 days + 18 hours, 5 days + 18 hours + 1];
            next = drand.roundTime(r) + offsets[kind - 2];
        } else if (kind < 9) {
            next = drand.roundTime(r) - 12 + 7 days + kind - 7;
        } else {
            uint256[3] memory ages = [uint256(256), 8191, 8192];
            uint256 target = targets[r];
            uint256 goal = target + ages[kind - 9];
            if (target != 0 && goal > height) next += (goal - height) * 12;
        }
        if (next > clock) {
            height += (next - clock + 11) / 12;
            clock = next;
        }
        _sync();
        ++successes[6];
        _observe();
    }

    function unrequested(uint256 amount) external {
        _sync();
        amount %= 1 ether;
        // Models ETH outside request/addBounty (M27 accepted); never counts it as a pot or credit.
        vm.deal(address(drand), address(drand).balance + amount);
        extra += amount;
        ++successes[7];
        _observe();
    }

    function _observe() internal {
        if (address(backed).balance != 0) failures |= 256;
        for (uint256 i; i < requests.length; ++i) {
            Request storage q = requests[i];
            IDrandSource s = IDrandSource(q.wrap ? address(backed) : address(drand));
            (bytes32 w, uint64 at) = s.wordOf(q.consumer, q.key);
            if (q.word != 0 && (w != q.word || at != q.ready)) failures |= 512;
            if (w != 0) {
                q.word = w;
                q.ready = at;
                if (at < q.at + 12 || at > clock) failures |= 1024;
            }
            bool silent = s.isSilent(q.consumer, q.key);
            if (q.silent && !silent) failures |= 2048;
            if (silent) q.silent = true;
            (uint64 requestedAt, uint64 round) = s.requestOf(q.consumer, q.key);
            if (requestedAt != q.at || round != q.round) failures |= 4096;
            (bytes32 randomness, uint64 postedAt) = drand.beaconOf(q.round);
            bytes32 id = keccak256(abi.encode(q.consumer, q.key));
            if (q.wrap && targets[q.round] != 0) {
                if (at != fixedTimes[q.round]) failures |= 8192;
                if (at == 0 ? w != 0 : w != keccak256(abi.encode(backed.BACKUP_TAG(), fixedMixes[q.round], id))) {
                    failures |= 8192;
                }
            } else {
                bytes32 tag = q.wrap ? backed.DRAND_TAG() : drand.WORD_TAG();
                if (at != postedAt || (at == 0 ? w != 0 : w != keccak256(abi.encode(tag, randomness, id)))) {
                    failures |= 8192;
                }
            }
        }
        for (uint256 i; i < 16; ++i) {
            uint256 r = first + i;
            (uint64 st, uint64 target, uint64 ft, bytes32 mix) = backed.backupOf(r);
            if (st != started[r] || target != targets[r] || ft != fixedTimes[r] || mix != fixedMixes[r]) {
                failures |= 16384;
            }
        }
        if (!ledger()) failures |= 32768;
    }

    function ledger() public view returns (bool) {
        uint256 held = extra;
        for (uint256 i; i < rounds.length; ++i) {
            if (drand.bountyOf(rounds[i]) != pots[rounds[i]]) return false;
            held += pots[rounds[i]];
        }
        for (uint256 i; i < 3; ++i) {
            if (drand.owedTo(posters[i]) != credits[posters[i]]) return false;
            held += credits[posters[i]];
        }
        return held == address(drand).balance && address(backed).balance == 0;
    }
}

/// @notice One real source of each kind, arbitrary interleavings with sticky checks after every action.
/// forge-config: default.evm_version = "osaka"
contract AuditU8LaneInvariants is AuditU8LaneBase {
    AuditU8LaneHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new AuditU8LaneHandler(drand, backed);
        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = handler.request.selector;
        selectors[1] = handler.bounty.selector;
        selectors[2] = handler.post.selector;
        selectors[3] = handler.withdraw.selector;
        selectors[4] = handler.start.selector;
        selectors[5] = handler.fix.selector;
        selectors[6] = handler.advance.selector;
        selectors[7] = handler.unrequested.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
        targetContract(address(handler));
    }

    function invariant_AUDIT_U8_accountingWordsTargetsAndClock() public view {
        assertEq(handler.failures(), 0, "sticky model violations");
        assertTrue(handler.ledger());
    }

    function afterInvariant() public {
        for (uint256 i; i < 8; ++i) {
            emit log_named_uint(string.concat("successful action ", vm.toString(i)), handler.successes(i));
        }
    }
}

/// @notice A deterministic coverage witness supplements random campaigns without imposing per-sequence quotas.
/// forge-config: default.evm_version = "osaka"
contract AuditU8LaneHandlerCoverageTest is AuditU8LaneBase {
    function testProperty_AUDIT_U8_handlerExercisesEveryActionAndEdges() public {
        AuditU8LaneHandler h = new AuditU8LaneHandler(drand, backed);
        h.request(1, 99, 10);
        h.bounty(0, 100, true);
        h.unrequested(25);
        h.post(0, 0);
        h.withdraw(0);
        h.advance(2, 1); // 5 days - 1
        h.start(1, 0); // too early
        h.advance(3, 1); // exactly 5 days
        h.start(1, 0); // still too early
        h.advance(4, 1); // +1, start
        h.start(1, 0);
        h.post(1, 1); // deliberately ignored by the wrapper
        h.advance(9, 1); // target +256 through BLOCKHASH
        h.fix(1, 1);
        h.advance(5, 2); // latest start
        h.start(2, 1);
        h.start(3, 1); // same target for different rounds
        h.start(4, 1);
        h.advance(10, 2); // target +8191 through HISTORY
        h.fix(2, 2);
        h.advance(11, 3); // target +8192 refused
        h.fix(3, 1);
        h.advance(8, 4); // silence edge and late post
        h.post(4, 2);
        assertEq(h.failures(), 0);
        assertTrue(h.ledger());
        for (uint256 i; i < 8; ++i) {
            assertGt(h.successes(i), 0);
        }
    }
}
