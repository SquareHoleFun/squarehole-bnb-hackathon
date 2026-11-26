// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxCoordinator} from "../../../src/box/BoxCoordinator.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {BoxTickets} from "../../../src/box/BoxTickets.sol";
import {BoxToken} from "../../../src/box/BoxToken.sol";
import {DrandSource} from "../../../src/box/randomness/DrandSource.sol";
import {DrandSourcePins} from "../../../src/box/randomness/DrandSourcePins.sol";
import {BoxBackedSource} from "../../../src/box/randomness/BoxBackedSource.sol";
import {BackedSourcePins} from "../../../src/box/randomness/BackedSourcePins.sol";
import {BoxDrandVectors} from "../randomness/utils/BoxDrandVectors.sol";
import {CoreBox0Kit, CoreBoxAddresses} from "../conformance/core/CoreBox0Kit.sol";
import {HeaderVectors} from "./HeaderVectors.sol";
import {History2935} from "./History2935.sol";

/// @notice TEST ONLY. Box 0 as factory v1 creates it (`CoreBox0Kit`, the steps of `script/DeployCoreV1.s.sol`) on its
/// pinned BoxBackedSource (F143), closed and about to graduate, with the helpers the backup suites share: the
/// graduation and a draw on chosen rounds, a synthetic post-London header, the previous block's header for
/// `startBackup`, and a start-then-fix. BoxTickets and DrandSource are rc7's code (`BoxBackedSourceIdentity.t.sol`).
abstract contract CoreBox0BackupBase is BoxDrandVectors {
    string internal constant BOX_SPEC_VECTORS = "test/vectors/box-spec/box-spec-v1.json";

    CoreBox0Kit internal b;
    CoreBoxAddresses internal a;
    BoxBackedSource internal src;
    DrandSource internal drand;
    BoxTickets internal tickets;
    uint256 internal r0;

    function setUp() public virtual {
        _loadBoxDrand();
        r0 = _localFirst();
        b = new CoreBox0Kit();
        b.setUpWorld();
        src = b.source();
        drand = b.drand();
        assertEq(address(src), BackedSourcePins.ADDRESS_MAINNET, "the kit wired the pinned backed source");
        assertEq(address(drand), DrandSourcePins.ADDRESS_MAINNET, "and the pinned DrandSource");
        vm.warp(src.roundTime(r0) - 1 days);
        b.prepare(_spec());
        b.create();
        a = b.addresses();
        tickets = BoxTickets(a.tickets);
        assertEq(tickets.source(), address(src), "box 0's tickets read the backed source");
        b.toClosed();
    }

    function _spec() internal view returns (BoxSpecV1.BoxSpec memory s) {
        string memory json = vm.readFile(BOX_SPEC_VECTORS);
        s = abi.decode(vm.parseJsonBytes(json, ".columns.encoded[0]"), (BoxSpecV1.BoxSpec));
        s.raise = BoxSpecV1.qListV1()[0].raisePresets[0];
    }

    /// Graduates 12 s before r0's time, so the graduation word's round is r0; returns the request's time.
    function _graduate() internal returns (uint256 requestedAt) {
        vm.warp(src.roundTime(r0) - 12);
        vm.roll(block.number + 1);
        BoxCoordinator(a.coordinator).graduate();
        requestedAt = block.timestamp;
        (, uint64 round) = src.requestOf(a.tickets, 0);
        assertEq(round, r0);
    }

    /// One draw on round r0 + i by a fresh drawer; returns its ticket and request time.
    function _drawOn(uint256 i, string memory who) internal returns (uint256 ticketId, uint256 requestedAt) {
        address drawer = makeAddr(who);
        b.buy(drawer, b.eth(0.5 ether), 0);
        vm.warp(src.roundTime(r0 + i) - 12);
        vm.roll(block.number + 1);
        vm.deal(drawer, 1 ether);
        vm.startPrank(drawer);
        BoxToken(a.token).approve(a.tickets, type(uint256).max);
        ticketId = tickets.draw{value: 0.01 ether}(type(uint256).max, block.timestamp);
        vm.stopPrank();
        requestedAt = block.timestamp;
        (, uint64 round) = src.requestOf(a.tickets, ticketId);
        assertEq(round, r0 + i);
    }

    /// The earliest moment the rule allows a start for `round` (5 days after its time, F143 (2)).
    function _startable(uint256 round) internal view returns (uint256) {
        return src.roundTime(round) + 5 days + 1;
    }

    /// A synthetic post-London header: 13 fields, then prevRandao, then nonce and baseFee (enough for the parser).
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

    /// The previous block's header, as `startBackup` takes it (the real mainnet header, its hash made the parent's).
    function _parent() internal returns (bytes memory h) {
        h = HeaderVectors.MAINNET;
        vm.setBlockhash(block.number - 1, keccak256(h));
    }

    /// Starts `round`'s backup as `who` (with the parent header).
    function _start(uint256 round, address who) internal returns (uint256 target) {
        bytes memory p = _parent();
        vm.prank(who);
        target = src.startBackup(round, block.number - 1, p);
        assertEq(target, block.number + src.TARGET_BLOCKS());
    }

    /// Moves `blocks` blocks and 12 s per block.
    function _advance(uint256 blocks) internal {
        vm.roll(block.number + blocks);
        vm.warp(block.timestamp + 12 * blocks);
    }

    /// Makes `target`'s hash that of a header carrying `mix`, readable as the chain would serve it (BLOCKHASH within
    /// 256 blocks, EIP-2935's contract after), and returns the header.
    function _mine(uint256 target, bytes32 mix) internal returns (bytes memory h) {
        h = _header(target, mix);
        if (block.number > target && block.number - target <= 256) vm.setBlockhash(target, keccak256(h));
        History2935.put(vm, target, keccak256(h));
    }

    /// Starts the round's backup as `who` and fixes it with `mix` one block after its target (BLOCKHASH range).
    function _backup(uint256 round, bytes32 mix, address who) internal returns (uint256 target) {
        target = _start(round, who);
        _advance(src.TARGET_BLOCKS() + 1);
        bytes memory h = _mine(target, mix);
        vm.prank(makeAddr("any.poster"));
        src.fixBackup(round, h);
    }

    function _word(bytes32 tag, bytes32 value, uint256 key) internal view returns (bytes32) {
        return keccak256(abi.encode(tag, value, keccak256(abi.encode(a.tickets, key))));
    }
}
