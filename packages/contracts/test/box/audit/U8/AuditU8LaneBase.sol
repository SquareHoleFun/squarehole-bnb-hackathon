// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxDrandVectors} from "../../randomness/utils/BoxDrandVectors.sol";
import {PinnedDrandSource} from "../../randomness/utils/PinnedDrandSource.sol";
import {PinnedBackedSource} from "../../randomness/utils/PinnedBackedSource.sol";
import {DrandSource} from "../../../../src/box/randomness/DrandSource.sol";
import {BoxBackedSource} from "../../../../src/box/randomness/BoxBackedSource.sol";
import {IDrandSource} from "../../../../src/box/interfaces/IDrandSource.sol";
import {HeaderVectors} from "../../backup/HeaderVectors.sol";
import {History2935} from "../../backup/History2935.sol";

/// @notice Offline header construction follows CoreBox0BackupBase. Appended fields never move field 13.
library AuditU8LaneHeaders {
    function uintRlp(uint256 v) internal pure returns (bytes memory out) {
        if (v == 0) return hex"80";
        if (v < 128) return abi.encodePacked(uint8(v));
        uint256 n;
        for (uint256 t = v; t != 0; t >>= 8) {
            ++n;
        }
        out = new bytes(n + 1);
        out[0] = bytes1(uint8(128 + n));
        for (uint256 i; i < n; ++i) {
            out[n - i] = bytes1(uint8(v >> (8 * i)));
        }
    }

    function list(bytes memory payload) internal pure returns (bytes memory) {
        if (payload.length < 56) return bytes.concat(bytes1(uint8(192 + payload.length)), payload);
        if (payload.length < 256) return bytes.concat(hex"f8", bytes1(uint8(payload.length)), payload);
        return bytes.concat(hex"f9", bytes2(uint16(payload.length)), payload);
    }

    function body(uint256 number, bytes32 mix, uint256 shape) internal pure returns (bytes memory out) {
        out = bytes.concat(hex"a0", keccak256("parent"), hex"a0", keccak256("ommers"), hex"94", bytes20(address(7)));
        out = bytes.concat(out, hex"a0", keccak256("state"), hex"a0", keccak256("tx"), hex"a0", keccak256("receipts"));
        out = bytes.concat(out, hex"b90100", new bytes(256), hex"80", uintRlp(number), uintRlp(60_000_000));
        out = bytes.concat(out, uintRlp(12_345_678), uintRlp(1_790_000_000), hex"83616263", hex"a0", mix);
        out = bytes.concat(out, hex"880000000000000000", uintRlp(7)); // London: 16 fields
        if (shape >= 1) out = bytes.concat(out, hex"a0", keccak256("withdrawals")); // Shanghai: 17
        if (shape >= 2) out = bytes.concat(out, hex"80", hex"80", hex"a0", keccak256("beacon")); // Cancun: 20
        if (shape >= 3) out = bytes.concat(out, hex"a0", keccak256("requests")); // Prague / Osaka: 21
        if (shape >= 5) out = bytes.concat(out, hex"a0", keccak256("access list"), uintRlp(123)); // Amsterdam: 23
    }

    function header(uint256 number, bytes32 mix, uint256 shape) internal pure returns (bytes memory) {
        return list(body(number, mix, shape));
    }
}

/// @notice Unit world: actual compiled sources, deployed through Arachnid CREATE2, no source substitutes.
/// Factory-built box 0 integration is exercised separately in AuditU8LaneBox0.
abstract contract AuditU8LaneBase is BoxDrandVectors {
    DrandSource internal drand;
    BoxBackedSource internal backed;
    uint256 internal first;

    function setUp() public virtual {
        _loadBoxDrand();
        vm.chainId(1);
        drand = PinnedDrandSource.deploy(vm);
        backed = PinnedBackedSource.deploy(vm);
        first = _localFirst();
        vm.roll(23_000_000);
        vm.warp(drand.roundTime(first) - 12);
        vm.deal(address(this), 100 ether);
    }

    function _request(bool wrap, address consumer, uint256 key, uint256 value) internal returns (uint256 round) {
        vm.deal(consumer, consumer.balance + value);
        vm.prank(consumer);
        round = wrap ? backed.request{value: value}(key) : drand.request{value: value}(key);
    }

    function _start(uint256 round) internal returns (uint256 target) {
        bytes memory h = AuditU8LaneHeaders.header(block.number - 1, keccak256("parent mix"), 4);
        vm.setBlockhash(block.number - 1, keccak256(h));
        return backed.startBackup(round, block.number - 1, h);
    }

    function _fix(uint256 round, uint256 target, bytes32 mix) internal {
        bytes memory h = AuditU8LaneHeaders.header(target, mix, 4);
        if (block.number > target && block.number - target <= 256) vm.setBlockhash(target, keccak256(h));
        History2935.put(vm, target, keccak256(h));
        assertEq(backed.fixBackup(round, h), mix);
    }
}
