// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DrandSource} from "../../../src/box/randomness/DrandSource.sol";
import {BoxBackedSource} from "../../../src/box/randomness/BoxBackedSource.sol";
import {IDrandSource} from "../../../src/box/interfaces/IDrandSource.sol";
import {BoxDrandVectors} from "../randomness/utils/BoxDrandVectors.sol";
import {PinnedDrandSource} from "../randomness/utils/PinnedDrandSource.sol";
import {PinnedBackedSource} from "../randomness/utils/PinnedBackedSource.sol";
import {HeaderVectors} from "./HeaderVectors.sol";
import {History2935} from "./History2935.sol";

/// @title BackupReviewLightTest (the security review of sh-box0-backup-source at bdb9a07da, its tests moved here)
/// @notice The pinned DrandSource and BoxBackedSource at their CREATE2 addresses, a plain consumer standing in for box
/// 0's tickets: the trigger rule's timing (F1 inverted into guards: the latest start), the header proof (F3: a recent
/// header, up to 8 blocks old), the residual before a header-format fork (F2, documented), the RLP walker (three
/// fuzzers), the BLOCKHASH / EIP-2935 windows, one word per request, per-consumer isolation and the bounty pass-through.
/// forge-config: default.evm_version = "osaka"
contract BackupReviewLightTest is BoxDrandVectors {
    DrandSource internal drand;
    BoxBackedSource internal src;
    address internal box = makeAddr("review.box0");
    uint256 internal r0;

    function setUp() public virtual {
        _loadBoxDrand();
        r0 = _localFirst();
        vm.chainId(1);
        drand = PinnedDrandSource.deploy(vm);
        src = PinnedBackedSource.deploy(vm);
        vm.roll(23_000_000);
    }

    // ------------------------------------------------------------------------------------------------------------
    // helpers

    function _request(address consumer, uint256 key, uint256 round) internal returns (uint256 requestedAt) {
        vm.warp(src.roundTime(round) - 12);
        vm.prank(consumer);
        assertEq(src.request(key), round);
        requestedAt = block.timestamp;
    }

    function _parent() internal returns (bytes memory h) {
        h = HeaderVectors.MAINNET;
        vm.setBlockhash(block.number - 1, keccak256(h));
    }

    function _advance(uint256 blocks) internal {
        vm.roll(block.number + blocks);
        vm.warp(block.timestamp + 12 * blocks);
    }

    function _b32(bytes32 x) internal pure returns (bytes memory) {
        return bytes.concat(hex"a0", x);
    }

    function _uint(uint256 v) internal pure returns (bytes memory out) {
        if (v == 0) return hex"80";
        if (v < 0x80) return abi.encodePacked(uint8(v));
        uint256 n;
        for (uint256 t = v; t != 0; t >>= 8) {
            ++n;
        }
        out = new bytes(n);
        for (uint256 i; i < n; ++i) {
            out[n - 1 - i] = bytes1(uint8(v >> (8 * i)));
        }
        out = bytes.concat(abi.encodePacked(uint8(0x80 + n)), out);
    }

    /// A synthetic post-London header (CoreBox0BackupBase's shape).
    function _header(uint256 number, bytes32 mix) internal pure returns (bytes memory) {
        bytes memory head = bytes.concat(
            _b32(keccak256("parent")),
            _b32(keccak256("ommers")),
            hex"94",
            bytes20(address(0xC0FFEE)),
            _b32(keccak256("state")),
            _b32(keccak256("txs")),
            _b32(keccak256("receipts"))
        );
        bytes memory mid = bytes.concat(hex"b90100", new bytes(256), hex"80", _uint(number), _uint(60_000_000));
        bytes memory tail = bytes.concat(_uint(12_345_678), _uint(1_790_000_000), hex"83616263", _b32(mix));
        bytes memory body = bytes.concat(head, mid, tail, hex"880000000000000000", _uint(7));
        return bytes.concat(hex"f9", bytes2(uint16(body.length)), body);
    }

    function _start(uint256 round) internal returns (uint256 target) {
        bytes memory p = _parent();
        target = src.startBackup(round, block.number - 1, p);
    }

    // ------------------------------------------------------------------------------------------------------------
    // S1. The trigger rule's timing (review F1, inverted): no start after LATEST_START, so every start the rule allows
    // keeps its whole proof window, plus margin, inside the consumers' 7 days

    /// GUARD (F1): a request whose round drand has not posted for almost 7 days. A start 40 minutes before the
    /// consumers' deadline (allowed before the review: the rule had no latest time) is refused, and the drand post 30
    /// minutes before the deadline makes the word count, as on rc7's DrandSource.
    function test_guard_lateStartRefused_timelyDrandPostCounts() public {
        uint256 requestedAt = _request(box, 0, r0);
        uint256 deadline = requestedAt + 7 days;
        uint256 until = src.roundTime(r0) + src.LATEST_START();
        vm.warp(deadline - 40 minutes);
        bytes memory p = _parent();
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.BackupTooLate.selector, r0, until));
        src.startBackup(r0, block.number - 1, p);
        _advance(50); // 10 minutes later the post lands, still before the deadline
        assertLt(block.timestamp, deadline);
        drand.postRound(r0, _localSig(0));
        (bytes32 w, uint64 readyAt) = src.wordOf(box, 0);
        assertTrue(w != bytes32(0) && readyAt <= deadline, "a post before the deadline counts");
        vm.warp(deadline + 1);
        assertFalse(src.isSilent(box, 0), "not silent");
    }

    /// GUARD (F1): the review's kill window was the last 257 blocks before the deadline. The latest start the rule
    /// allows is 30 hours (less the request-to-round gap) before the deadline, its first possible fix about 29 hours before it, and its
    /// last possible fix (target + 8,191) still before it; one second later the start is refused.
    function test_guard_latestStart_stillFixableLongBeforeTheDeadline() public {
        uint256 requestedAt = _request(box, 0, r0);
        uint256 deadline = requestedAt + 7 days;
        uint256 until = src.roundTime(r0) + src.LATEST_START();
        assertGe(deadline - until, 30 hours - 15, "the latest start is 30 hours before the deadline");
        uint256 snap = vm.snapshotState();
        vm.warp(until + 1);
        bytes memory p = _parent();
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.BackupTooLate.selector, r0, until));
        src.startBackup(r0, block.number - 1, p);
        vm.revertToState(snap);
        vm.warp(until);
        uint256 target = _start(r0);
        _advance(target + 1 - block.number);
        assertGt(deadline - block.timestamp, 29 hours, "the first possible fix, about 29 hours early");
        assertLe(block.timestamp + 12 * 8190, deadline, "and the last possible fix still before the deadline");
        bytes memory h = _header(target, keccak256("m"));
        vm.setBlockhash(target, keccak256(h));
        src.fixBackup(r0, h);
        vm.warp(deadline + 1);
        assertFalse(src.isSilent(box, 0), "savable");
    }

    /// The race when drand is alive but nobody posted for 5 days: in the block that first allows a start, the order
    /// of a post and a start decides the word (accepted by the design review and this review: whoever acts first
    /// takes drand's word A or the backup's B; a bounty and outside posters keep rounds posted long before day 5).
    function test_accepted_postOrStart_theOrderDecides() public {
        _request(box, 0, r0);
        vm.warp(src.roundTime(r0) + 5 days + 1);
        uint256 snap = vm.snapshotState();
        drand.postRound(r0, _localSig(0));
        bytes memory p = _parent();
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.RoundAlreadyPosted.selector, r0));
        src.startBackup(r0, block.number - 1, p);
        (bytes32 a,) = src.wordOf(box, 0);
        assertTrue(a != bytes32(0), "post first: drand's word A");
        vm.revertToState(snap);
        _start(r0);
        drand.postRound(r0, _localSig(0));
        (bytes32 none,) = src.wordOf(box, 0);
        assertEq(none, bytes32(0), "start first: A is ignored, the word will be B");
    }

    // ------------------------------------------------------------------------------------------------------------
    // S2. The header-format guard's residual (review F2, documented, not fixed on chain)

    /// RESIDUAL (F2): the start proves a recent header is still keccak(RLP), so a fork that has already changed header
    /// hashing makes the start fail (CoreBox0BackupTest's guard). It cannot see a fork still ahead: a start whose header
    /// is RLP but whose target lies after such a fork (a start in the about 264 blocks before it) commits the round to
    /// a target no header can prove, and the drand post that follows is ignored; the request is silent at 7 days. No
    /// on-chain fix without a restart (which would bring back a choice of words); S7's fork watch keeps box 0's rounds
    /// posted before day 5 whenever such a fork is scheduled (docs/evidence/SH-BOX0-BACKUP-SOURCE.md).
    function test_residual_startJustBeforeAFormatFork_roundHasNoWord() public {
        uint256 requestedAt = _request(box, 0, r0);
        vm.warp(src.roundTime(r0) + 5 days + 1);
        uint256 target = _start(r0); // the header is still RLP: allowed
        _advance(257);
        // The fork activated 100 blocks after the start: the target's hash is an SSZ root (no RLP preimage).
        vm.setBlockhash(target, keccak256("an ssz root, no RLP preimage"));
        bytes memory h = _header(target, keccak256("mix"));
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.WrongHeader.selector, target));
        src.fixBackup(r0, h);
        vm.warp(src.roundTime(r0) + 6 days);
        drand.postRound(r0, _localSig(0)); // drand is alive and posted on day 6
        vm.warp(requestedAt + 7 days + 1);
        assertTrue(src.isSilent(box, 0), "no word, although drand answered on day 6");
        assertFalse(drand.isSilent(address(src), uint256(keccak256(abi.encode(box, uint256(0))))), "drand was timely");
    }

    // ------------------------------------------------------------------------------------------------------------
    // S3. The header proof

    /// GUARD (F3, inverted): a start built on block L's header still lands when it is included up to 8 blocks later
    /// (L + 1 ... L + 8); 9 blocks later it is refused (HeaderUnavailable), and so is a header that is not L's own, the
    /// current block's number, or a header from a block not yet mined.
    function test_guard_start_recentHeader_upToEightBlocksLate() public {
        _request(box, 0, r0);
        vm.warp(src.roundTime(r0) + 5 days + 1);
        bytes memory latest = HeaderVectors.MAINNET; // the sender's latest block L
        uint256 l = block.number - 1;
        vm.setBlockhash(l, keccak256(latest));
        uint256 snap = vm.snapshotState();
        for (uint256 late = 1; late <= 8; ++late) {
            vm.roll(l + late);
            uint256 target = src.startBackup(r0, l, latest);
            assertEq(target, l + late + 256, "the target counts from the including block");
            vm.revertToState(snap);
        }
        vm.roll(l + 9);
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.HeaderUnavailable.selector, l));
        src.startBackup(r0, l, latest);
        vm.revertToState(snap);
        vm.roll(l + 2);
        vm.setBlockhash(l + 1, keccak256("block L+1's header"));
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.WrongHeader.selector, l + 1));
        src.startBackup(r0, l + 1, latest);
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.HeaderUnavailable.selector, l + 2));
        src.startBackup(r0, l + 2, latest);
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.HeaderUnavailable.selector, l + 3));
        src.startBackup(r0, l + 3, latest);
        (uint64 startedAt,,,) = src.backupOf(r0);
        assertEq(startedAt, 0, "nothing started");
    }

    /// The fix takes only the target's own header: its neighbours' (each with its own valid hash) and another chain's
    /// real header are refused.
    function test_fix_refusesNeighbourAndOtherChainHeaders() public {
        _request(box, 0, r0);
        vm.warp(src.roundTime(r0) + 5 days + 1);
        uint256 target = _start(r0);
        vm.roll(target + 2);
        bytes memory hPrev = _header(target - 1, keccak256("prev"));
        bytes memory hNext = _header(target + 1, keccak256("next"));
        vm.setBlockhash(target - 1, keccak256(hPrev));
        vm.setBlockhash(target + 1, keccak256(hNext));
        vm.setBlockhash(target, keccak256(_header(target, keccak256("real"))));
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.WrongHeader.selector, target));
        src.fixBackup(r0, hPrev);
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.WrongHeader.selector, target));
        src.fixBackup(r0, hNext);
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.WrongHeader.selector, target));
        src.fixBackup(r0, HeaderVectors.SEPOLIA);
        assertEq(src.fixBackup(r0, _header(target, keccak256("real"))), keccak256("real"));
    }

    /// The windows: not at the target's own block; BLOCKHASH through target + 256; then EIP-2935 only if its code
    /// is there (target + 257 and + 8,191 with it; nothing without it); gone at target + 8,192.
    function test_window_blockhashThenHistoryThenGone() public {
        _request(box, 0, r0);
        vm.warp(src.roundTime(r0) + 5 days + 1);
        uint256 target = _start(r0);
        bytes memory h = _header(target, keccak256("mix"));
        bytes32 hh = keccak256(h);
        vm.roll(target);
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.HeaderUnavailable.selector, target));
        src.fixBackup(r0, h);
        uint256 snap = vm.snapshotState();
        vm.roll(target + 256);
        vm.setBlockhash(target, hh);
        assertEq(src.fixBackup(r0, h), keccak256("mix"), "BLOCKHASH's last block");
        vm.revertToState(snap);
        vm.roll(target + 257);
        assertEq(blockhash(target), bytes32(0));
        vm.etch(History2935.ADDRESS, ""); // a chain without EIP-2935 (forge's --hardfork amsterdam pre-fills it)
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.HeaderUnavailable.selector, target));
        src.fixBackup(r0, h); // no EIP-2935 code: the window is BLOCKHASH's 256 blocks only
        History2935.put(vm, target, hh);
        assertEq(src.fixBackup(r0, h), keccak256("mix"), "EIP-2935's first block");
        vm.revertToState(snap);
        // (forge's roll rewrites the ring slot of the new block number, so the hash is put after each roll)
        vm.roll(target + 8191);
        History2935.put(vm, target, hh);
        assertEq(src.fixBackup(r0, h), keccak256("mix"), "EIP-2935's last block");
        vm.revertToState(snap);
        vm.roll(target + 8192);
        History2935.put(vm, target, hh);
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.HeaderUnavailable.selector, target));
        src.fixBackup(r0, h);
    }

    /// A caller that starves the history contract's call gets HeaderUnavailable and changes nothing (the window
    /// cannot be used up by gas).
    function test_fix_starvedHistoryCall_revertsWithoutEffect() public {
        _request(box, 0, r0);
        vm.warp(src.roundTime(r0) + 5 days + 1);
        uint256 target = _start(r0);
        bytes memory h = _header(target, keccak256("mix"));
        vm.roll(target + 1000);
        History2935.put(vm, target, keccak256(h));
        uint256 okAt;
        for (uint256 g = 20_000; g <= 400_000; g += 250) {
            vm.cool(address(src));
            vm.cool(History2935.ADDRESS);
            (bool ok,) = address(src).call{gas: g}(abi.encodeCall(BoxBackedSource.fixBackup, (r0, h)));
            (,, uint64 fixedAt,) = src.backupOf(r0);
            if (!ok) {
                assertEq(fixedAt, 0, "a failed fix leaves nothing behind");
            } else {
                okAt = g;
                break;
            }
        }
        assertGt(okAt, 0);
        emit log_named_uint("least gas for a fix through EIP-2935 (cold)", okAt);
    }

    // ------------------------------------------------------------------------------------------------------------
    // S4. The RLP walker

    /// Field types the generator uses: 0 single byte, 1 short string, 2 long string.
    function _field(uint256 seed, uint256 kind) internal pure returns (bytes memory) {
        if (kind == 0) return abi.encodePacked(uint8(seed % 0x80));
        if (kind == 1) {
            uint256 n = seed % 56;
            return bytes.concat(abi.encodePacked(uint8(0x80 + n)), _bytes(seed, n));
        }
        uint256 m = 56 + (seed % 300);
        bytes memory len = m < 256 ? abi.encodePacked(uint8(m)) : abi.encodePacked(uint16(m));
        return bytes.concat(abi.encodePacked(uint8(0xb7 + len.length)), len, _bytes(seed, m));
    }

    function _bytes(uint256 seed, uint256 n) internal pure returns (bytes memory out) {
        out = new bytes(n);
        for (uint256 i; i < n; ++i) {
            out[i] = bytes1(uint8(uint256(keccak256(abi.encode(seed, i)))));
        }
    }

    function _list(bytes memory body) internal pure returns (bytes memory) {
        if (body.length < 256) return bytes.concat(hex"f8", abi.encodePacked(uint8(body.length)), body);
        if (body.length < 65_536) return bytes.concat(hex"f9", abi.encodePacked(uint16(body.length)), body);
        return bytes.concat(hex"fa", abi.encodePacked(uint24(body.length)), body);
    }

    /// A well-formed header-shaped list: 13 random byte-string fields, field 13 a 32-byte mix, then up to 7 trailing
    /// items of any kind (lists included).
    function _wellFormed(uint256 seed, bytes32 mix) internal pure returns (bytes memory body) {
        for (uint256 i; i < 13; ++i) {
            uint256 s = uint256(keccak256(abi.encode(seed, "f", i)));
            body = bytes.concat(body, _field(s, s % 3));
        }
        body = bytes.concat(body, hex"a0", mix);
        uint256 tail = seed % 8;
        for (uint256 i; i < tail; ++i) {
            uint256 s = uint256(keccak256(abi.encode(seed, "t", i)));
            body = bytes.concat(body, s % 4 == 3 ? bytes(hex"c3010203") : _field(s, s % 3));
        }
    }

    function _fixWith(bytes memory h) internal returns (bool ok, bytes memory ret) {
        _request(box, 0, r0);
        vm.warp(src.roundTime(r0) + 5 days + 1);
        uint256 target = _start(r0);
        vm.roll(target + 1);
        vm.setBlockhash(target, keccak256(h));
        (ok, ret) = address(src).call(abi.encodeCall(BoxBackedSource.fixBackup, (r0, h)));
    }

    /// Every well-formed header-shaped list parses to its field 13, whatever its field sizes and trailing items.
    function testFuzz_walker_wellFormedParsesToField13(uint256 seed, bytes32 mix) public {
        bytes memory h = _list(_wellFormed(seed, mix));
        (bool ok, bytes memory ret) = _fixWith(h);
        assertTrue(ok, "a well-formed list parses");
        assertEq(abi.decode(ret, (bytes32)), mix, "field 13");
    }

    /// Malformed variants are refused with BadHeader (never a panic, never a wrong field): a list among the first 13
    /// fields, field 13 not 32 bytes, an outer length off by one, a truncation, a long string overrunning the input.
    function testFuzz_walker_malformedRefusedCleanly(uint256 seed, bytes32 mix, uint8 how) public {
        bytes memory body = _wellFormed(seed, mix);
        bytes memory h;
        uint256 kind = how % 5;
        if (kind == 0) {
            // a short list as field k < 13 (replaces the first field)
            uint256 k = seed % 13;
            bytes memory b;
            for (uint256 i; i < 13; ++i) {
                uint256 s = uint256(keccak256(abi.encode(seed, "f", i)));
                b = bytes.concat(b, i == k ? bytes(hex"c3010203") : _field(s, s % 3));
            }
            h = _list(bytes.concat(b, hex"a0", mix));
        } else if (kind == 1) {
            // field 13 of 31 or 33 bytes
            bytes memory b;
            for (uint256 i; i < 13; ++i) {
                uint256 s = uint256(keccak256(abi.encode(seed, "f", i)));
                b = bytes.concat(b, _field(s, s % 3));
            }
            h = _list(seed % 2 == 0 ? bytes.concat(b, hex"9f", bytes31(mix)) : bytes.concat(b, hex"a1", mix, hex"00"));
        } else if (kind == 2) {
            // the outer length off by one (one byte more or less than the input holds)
            h = _list(body);
            if (seed % 2 == 0) {
                h = bytes.concat(h, hex"00");
            } else {
                bytes memory t = new bytes(h.length - 1);
                for (uint256 i; i < t.length; ++i) {
                    t[i] = h[i];
                }
                h = t;
            }
        } else if (kind == 3) {
            // truncated anywhere before field 13's end, with the outer length fixed up to the truncated size
            uint256 cut = seed % (body.length - 1);
            bytes memory t = new bytes(cut);
            for (uint256 i; i < cut; ++i) {
                t[i] = body[i];
            }
            h = _list(t);
            // a truncation that still ends exactly after a well-formed field 13 cannot happen below its end
            vm.assume(cut < body.length - _tailLength(seed));
        } else {
            // a long string declaring more bytes than the whole input as field (seed % 13)
            uint256 k = seed % 13;
            bytes memory b;
            for (uint256 i; i < 13; ++i) {
                uint256 s = uint256(keccak256(abi.encode(seed, "f", i)));
                b = bytes.concat(b, i == k ? bytes(hex"bbffffffff") : _field(s, s % 3));
            }
            h = _list(bytes.concat(b, hex"a0", mix));
        }
        (bool ok, bytes memory ret) = _fixWith(h);
        assertFalse(ok, "refused");
        assertEq(bytes4(ret), BoxBackedSource.BadHeader.selector, "BadHeader, not a panic");
    }

    function _tailLength(uint256 seed) internal pure returns (uint256 n) {
        uint256 tail = seed % 8;
        for (uint256 i; i < tail; ++i) {
            uint256 s = uint256(keccak256(abi.encode(seed, "t", i)));
            n += (s % 4 == 3 ? 4 : _field(s, s % 3).length);
        }
    }

    /// Random bytes: whatever the input, the walker either agrees with a reference decoder or refuses with BadHeader.
    function testFuzz_walker_randomBytesAgreeWithReference(bytes memory h) public {
        (bool refOk, bytes32 refMix) = _reference(h);
        (bool ok, bytes memory ret) = _fixWith(h);
        assertEq(ok, refOk, "same verdict as the reference");
        if (ok) assertEq(abi.decode(ret, (bytes32)), refMix);
        else assertEq(bytes4(ret), BoxBackedSource.BadHeader.selector, "BadHeader, not a panic");
    }

    /// An independent decoder of the walker's rule: a long-form list exactly the input's size whose first 13 items
    /// are byte strings (RLP lengths, non-canonical forms allowed), then a 32-byte string.
    function _reference(bytes memory h) internal pure returns (bool, bytes32) {
        if (h.length < 2 || uint8(h[0]) < 0xf8) return (false, 0);
        uint256 ll = uint8(h[0]) - 0xf7;
        if (1 + ll > h.length) return (false, 0);
        uint256 len;
        for (uint256 i; i < ll; ++i) {
            len = len * 256 + uint8(h[1 + i]);
        }
        if (1 + ll + len != h.length) return (false, 0);
        uint256 p = 1 + ll;
        for (uint256 k; k < 13; ++k) {
            if (p >= h.length) return (false, 0);
            uint256 b = uint8(h[p]);
            if (b < 0x80) {
                p += 1;
            } else if (b < 0xb8) {
                p += 1 + b - 0x80;
            } else if (b < 0xc0) {
                uint256 l2 = b - 0xb7;
                if (p + 1 + l2 > h.length) return (false, 0);
                uint256 n;
                for (uint256 i; i < l2; ++i) {
                    n = n * 256 + uint8(h[p + 1 + i]);
                }
                p += 1 + l2 + n;
            } else {
                return (false, 0);
            }
        }
        if (p + 33 > h.length || uint8(h[p]) != 0xa0) return (false, 0);
        bytes32 mix;
        for (uint256 i; i < 32; ++i) {
            mix |= bytes32(uint256(uint8(h[p + 1 + i])) << (8 * (31 - i)));
        }
        return (true, mix);
    }

    // ------------------------------------------------------------------------------------------------------------
    // S5. Bias: one word per request, for ever (a random sequence of posts, starts, fixes, forged fixes and time)

    function testFuzz_oneWordPerRequestForever(uint256 seed) public {
        address other = makeAddr("review.consumer2");
        uint256 n = 4;
        for (uint256 i; i < n; ++i) {
            vm.warp(src.roundTime(r0 + i) - 12);
            vm.prank(box);
            src.request(i);
            vm.prank(other);
            src.request(i);
        }
        bytes32[8] memory first;
        uint64[8] memory firstAt;
        for (uint256 step; step < 40; ++step) {
            uint256 r = uint256(keccak256(abi.encode(seed, step)));
            uint256 i = (r >> 8) % n;
            uint256 round = r0 + i;
            uint256 action = r % 6;
            if (action == 0) {
                uint256 dt = 1 + ((r >> 16) % 2 days);
                vm.warp(block.timestamp + dt);
                vm.roll(block.number + dt / 12 + 1);
            } else if (action == 1) {
                if (block.timestamp >= src.roundTime(round)) {
                    try drand.postRound(round, _localSig(i)) {} catch {}
                }
            } else if (action == 2) {
                bytes memory p = _parent();
                try src.startBackup(round, block.number - 1, p) {} catch {}
            } else if (action == 3 || action == 4) {
                (, uint64 targetBlock,,) = src.backupOf(round);
                if (targetBlock != 0 && block.number > targetBlock) {
                    // The chain committed one header per target; a forged one carries another mix.
                    bytes memory honest = _header(targetBlock, keccak256(abi.encode(seed, targetBlock)));
                    if (block.number - targetBlock <= 256) vm.setBlockhash(targetBlock, keccak256(honest));
                    History2935.put(vm, targetBlock, keccak256(honest));
                    bytes memory sent = action == 3 ? honest : _header(targetBlock, keccak256(abi.encode(r)));
                    try src.fixBackup(round, sent) {} catch {}
                }
            } else {
                uint256 blocks = 1 + ((r >> 16) % 9000);
                vm.roll(block.number + blocks);
                vm.warp(block.timestamp + 12 * blocks);
            }
            for (uint256 c; c < 2; ++c) {
                for (uint256 k; k < n; ++k) {
                    (bytes32 w, uint64 at) = src.wordOf(c == 0 ? box : other, k);
                    uint256 slot = c * n + k;
                    if (first[slot] == bytes32(0)) {
                        if (w != bytes32(0)) {
                            first[slot] = w;
                            firstAt[slot] = at;
                        } else {
                            assertEq(at, 0);
                        }
                    } else {
                        assertEq(w, first[slot], "a word never changes once given");
                        assertEq(at, firstAt[slot], "nor its time");
                    }
                }
            }
            assertEq(address(src).balance, 0);
        }
        // Words stay per consumer.
        for (uint256 k; k < n; ++k) {
            if (first[k] != bytes32(0)) assertTrue(first[k] != first[n + k], "per consumer");
        }
    }

    // ------------------------------------------------------------------------------------------------------------
    // S6. Isolation and the bounty pass-through

    /// Another consumer, on the same round, through the wrapper and on DrandSource directly with the wrapper's id
    /// for box 0, can neither block box 0's request nor obtain or change its word.
    function test_isolation_anotherConsumerCannotTouchBox0() public {
        address other = makeAddr("review.other");
        bytes32 id = keccak256(abi.encode(box, uint256(0)));
        vm.warp(src.roundTime(r0) - 12);
        vm.prank(other);
        drand.request(uint256(id));
        vm.prank(other);
        src.request(0);
        vm.prank(box);
        assertEq(src.request(0), r0, "box 0's request is not blocked");
        vm.prank(box);
        vm.expectRevert(abi.encodeWithSelector(IDrandSource.AlreadyRequested.selector, address(src), uint256(id)));
        src.request(0);
        vm.warp(src.roundTime(r0));
        drand.postRound(r0, _localSig(0));
        (bytes32 wBox,) = src.wordOf(box, 0);
        (bytes32 wOther,) = src.wordOf(other, 0);
        (bytes32 wDirect,) = drand.wordOf(other, uint256(id));
        assertTrue(wBox != bytes32(0) && wBox != wOther && wBox != wDirect && wOther != wDirect, "per consumer");
    }

    /// request and addBounty forward all ETH to DrandSource's pot of the right round; the wrapper takes no ETH
    /// otherwise; a refused bounty reverts whole; after a backup start the pot still goes to whoever posts drand.
    function test_bounty_passThrough_noEthStuckOrRedirected() public {
        vm.deal(box, 10 ether);
        vm.warp(src.roundTime(r0) - 12);
        vm.prank(box);
        src.request{value: 1 ether}(0);
        assertEq(drand.bountyOf(r0), 1 ether);
        vm.prank(box);
        src.addBounty{value: 0.5 ether}(r0);
        assertEq(src.bountyOf(r0), 1.5 ether);
        assertEq(address(src).balance, 0);
        assertEq(address(drand).balance, 1.5 ether);
        vm.prank(box);
        (bool ok,) = address(src).call{value: 1 wei}("");
        assertFalse(ok, "no receive");
        vm.prank(box);
        vm.expectRevert(abi.encodeWithSelector(IDrandSource.InvalidRound.selector, 0));
        src.addBounty{value: 1 wei}(0);
        vm.warp(src.roundTime(r0) + 5 days + 1);
        _start(r0);
        address poster = makeAddr("review.poster");
        vm.prank(poster);
        drand.postRound(r0, _localSig(0));
        assertEq(drand.owedTo(poster), 1.5 ether, "the pot pays the (now useless) drand post");
        vm.prank(box);
        vm.expectRevert(abi.encodeWithSelector(IDrandSource.RoundKnown.selector, r0));
        src.addBounty{value: 1 wei}(r0);
        assertEq(address(src).balance, 0);
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract BackupReviewLightAmsterdamTest is BackupReviewLightTest {}
