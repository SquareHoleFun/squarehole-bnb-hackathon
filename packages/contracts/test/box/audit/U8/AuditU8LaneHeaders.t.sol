// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {AuditU8LaneBase, AuditU8LaneHeaders, BoxBackedSource, HeaderVectors, History2935} from "./AuditU8LaneBase.sol";

/// @notice F143 / ADR-0013: authenticated field-13 parsing and BLOCKHASH/EIP-2935 boundaries.
/// forge-config: default.evm_version = "osaka"
contract AuditU8LaneHeadersTest is AuditU8LaneBase {
    function _tryHeader(bytes memory h) internal returns (bool ok, bytes memory ret) {
        vm.warp(drand.roundTime(first) + 5 days + 1);
        uint256 target = _start(first);
        vm.roll(target + 1);
        vm.setBlockhash(target, keccak256(h));
        return address(backed).call(abi.encodeCall(backed.fixBackup, (first, h)));
    }

    /// @notice Property: U8.11 malformed/non-minimal RLP is refused; BoxBackedSource.sol:264-289, F143.
    /// Expected: BadHeader even when the supplied hash authenticates a non-canonical encoding.
    /// Observed: an outer length with a leading zero is accepted (only total length and field 13 are checked).
    /// Steps: encode fa00 || uint16(body.length) || body, install its hash as the parent's, start backup.
    /// Amounts: 0 wei; one target 256 blocks ahead. Consensus cannot produce this header today.
    function test_AUDIT_U8_51_nonMinimalOuterLengthAccepted() public {
        vm.warp(drand.roundTime(first) + 5 days + 1);
        bytes memory b = AuditU8LaneHeaders.body(block.number - 1, bytes32(uint256(123)), 4);
        bytes memory h = bytes.concat(hex"fa00", bytes2(uint16(b.length)), b);
        vm.setBlockhash(block.number - 1, keccak256(h));
        assertEq(backed.startBackup(first, block.number - 1, h), block.number + 256);
    }

    /// @notice Property: U8.11 rejects malformed field lengths and nested fields; F143,
    /// BoxBackedSource.sol:264-292. Expected: BadHeader for each supplied noncanonical header-shaped list.
    /// Observed: a long-form empty field, a prefixed single byte, a nested suffix and an overrunning suffix pass.
    /// Steps per variant: start normally; install the malformed header hash for the target; fix with that header.
    /// Amounts: 0 wei; mix = keccak256("mix"). Only a synthetic authenticated header can reach these cases today.
    function test_AUDIT_U8_52_nonMinimalFieldAndUncheckedTailAccepted() public {
        for (uint256 kind; kind < 4; ++kind) {
            uint256 snap = vm.snapshotState();
            bytes memory body;
            // A string length encoded in long form although empty, or a non-minimal single byte.
            body = kind == 0 ? bytes(hex"b800") : kind == 1 ? bytes(hex"8101") : bytes(hex"80");
            for (uint256 i = 1; i < 13; ++i) {
                body = bytes.concat(body, hex"80");
            }
            body = bytes.concat(body, hex"a0", keccak256("mix"));
            // After field 13 the parser neither walks a nested field nor rejects a truncated trailing item.
            body = bytes.concat(body, kind == 2 ? bytes(hex"c0") : kind == 3 ? bytes(hex"b8") : bytes(hex"80"));
            // Use canonical outer length and enough trailing empty fields for a long outer list.
            body = bytes.concat(body, hex"8080808080808080808080808080808080");
            (bool ok, bytes memory ret) = _tryHeader(AuditU8LaneHeaders.list(body));
            assertTrue(ok, "the authenticated field-13 extractor accepts this grammar");
            assertEq(abi.decode(ret, (bytes32)), keccak256("mix"));
            assertTrue(vm.revertToState(snap));
        }
    }

    function testProperty_AUDIT_U8_committedHeaderHashesAndMixes() public {
        bytes[2] memory headers = [HeaderVectors.MAINNET, HeaderVectors.SEPOLIA];
        bytes32[2] memory hashes = [HeaderVectors.MAINNET_HASH, HeaderVectors.SEPOLIA_HASH];
        bytes32[2] memory mixes = [HeaderVectors.MAINNET_MIX, HeaderVectors.SEPOLIA_MIX];
        for (uint256 i; i < 2; ++i) {
            uint256 snap = vm.snapshotState();
            assertEq(keccak256(headers[i]), hashes[i]);
            (bool ok, bytes memory ret) = _tryHeader(headers[i]);
            assertTrue(ok);
            assertEq(abi.decode(ret, (bytes32)), mixes[i]);
            assertTrue(vm.revertToState(snap));
        }
    }

    function testFuzz_AUDIT_U8_sixForkHeaderShapes(bytes32 mix, uint64 number) public {
        for (uint256 shape; shape < 6; ++shape) {
            uint256 snap = vm.snapshotState();
            (bool ok, bytes memory ret) = _tryHeader(AuditU8LaneHeaders.header(number, mix, shape));
            assertTrue(ok, "London, Shanghai, Cancun, Prague, Osaka, Amsterdam");
            assertEq(abi.decode(ret, (bytes32)), mix);
            assertTrue(vm.revertToState(snap));
        }
    }

    function testFuzz_AUDIT_U8_malformedHeaderRejected(uint8 variant) public {
        bytes memory h;
        bytes memory b;
        for (uint256 i; i < 13; ++i) {
            b = bytes.concat(b, hex"80");
        }
        b = bytes.concat(b, hex"a0", keccak256("mix"), new bytes(32));
        uint256 kind = variant % 6;
        if (kind == 0) h = hex"ff010203";
        if (kind == 1) h = bytes.concat(AuditU8LaneHeaders.list(b), hex"00");
        if (kind == 2) {
            b[0] = 0xc0;
            h = AuditU8LaneHeaders.list(b);
        }
        if (kind == 3) {
            b[13] = 0x9f;
            h = AuditU8LaneHeaders.list(b);
        }
        if (kind == 4) h = AuditU8LaneHeaders.list(bytes.concat(hex"bfffffffffffffffff", b));
        if (kind == 5) h = hex"f84080";
        (bool ok, bytes memory ret) = _tryHeader(h);
        assertFalse(ok);
        assertEq(bytes4(ret), BoxBackedSource.BadHeader.selector);
        (,, uint64 fixedAt, bytes32 mix) = backed.backupOf(first);
        assertEq(fixedAt, 0);
        assertEq(mix, bytes32(0));
    }

    function testProperty_AUDIT_U8_historyEdgesAndAbsentCode() public {
        vm.warp(drand.roundTime(first) + 5 days + 1);
        uint256 target = _start(first);
        bytes memory h = AuditU8LaneHeaders.header(target, keccak256("target"), 4);
        uint256[7] memory ages = [uint256(0), 1, 256, 257, 8190, 8191, 8192];
        for (uint256 i; i < ages.length; ++i) {
            uint256 snap = vm.snapshotState();
            uint256 age = ages[i];
            vm.roll(target + age);
            if (age > 0 && age <= 256) vm.setBlockhash(target, keccak256(h));
            History2935.put(vm, target, keccak256(h));
            if (age == 0 || age > 8191) {
                vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.HeaderUnavailable.selector, target));
                backed.fixBackup(first, h);
            } else {
                assertEq(backed.fixBackup(first, h), keccak256("target"));
            }
            assertTrue(vm.revertToState(snap));
        }
        vm.roll(target + 257);
        vm.etch(History2935.ADDRESS, "");
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.HeaderUnavailable.selector, target));
        backed.fixBackup(first, h);
        (,, uint64 fixedAt,) = backed.backupOf(first);
        assertEq(fixedAt, 0);
    }

    /// @notice HISTORY alone is substituted: reverting, short, oversized and zero replies must fail closed.
    function testProperty_AUDIT_U8_historyMalformedRepliesFailClosed() public {
        vm.warp(drand.roundTime(first) + 5 days + 1);
        uint256 target = _start(first);
        vm.roll(target + 257);
        bytes memory h = AuditU8LaneHeaders.header(target, keccak256("target"), 4);
        bytes[4] memory code = [bytes(hex"5f5ffd"), hex"601f5ff3", hex"60405ff3", hex"60205ff3"];
        for (uint256 i; i < code.length; ++i) {
            vm.etch(History2935.ADDRESS, code[i]);
            vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.HeaderUnavailable.selector, target));
            backed.fixBackup(first, h);
        }
    }

    function testProperty_AUDIT_U8_recentEightAndWrongTargetHeader() public {
        vm.warp(drand.roundTime(first) + 5 days + 1);
        bytes memory h = HeaderVectors.MAINNET;
        for (uint256 age; age <= 9; ++age) {
            uint256 snap = vm.snapshotState();
            uint256 n = block.number - age;
            if (age > 0) vm.setBlockhash(n, keccak256(h));
            if (age == 0 || age == 9) {
                vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.HeaderUnavailable.selector, n));
                backed.startBackup(first, n, h);
            } else {
                assertEq(backed.startBackup(first, n, h), block.number + 256);
            }
            assertTrue(vm.revertToState(snap));
        }
        vm.setBlockhash(block.number - 1, keccak256("different"));
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.WrongHeader.selector, block.number - 1));
        backed.startBackup(first, block.number - 1, h);
        uint256 target = _start(first);
        vm.roll(target + 1);
        vm.setBlockhash(target, keccak256(h));
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.WrongHeader.selector, target));
        backed.fixBackup(first, HeaderVectors.SEPOLIA);
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU8LaneHeadersAmsterdamTest is AuditU8LaneHeadersTest {}
