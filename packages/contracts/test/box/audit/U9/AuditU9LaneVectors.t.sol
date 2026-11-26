// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {AuditU9LaneVectorsData} from "./AuditU9LaneVectorsData.sol";

/// @notice BC-001: 2,048 deterministic random specs, exact TS verdict/field/hash, including byte-invalid strings.
/// The committed corpus targets the default build, including the mainnet creator-cap presets.
contract AuditU9LaneVectors is Test, AuditU9LaneVectorsData {
    function replay(bytes memory packed, uint256 length, uint16 reason, uint16 field, bytes32 expectedHash)
        external
        pure
    {
        bytes memory raw = new bytes(length);
        uint256 p;
        uint256 w;
        while (p < packed.length) {
            uint256 tag = uint8(packed[p++]);
            uint256 n = (tag & 127) + 1;
            require(w + n <= length, "RLE output overflow");
            if (tag >= 128) {
                bytes1 c = packed[p++];
                for (uint256 k; k < n; ++k) {
                    raw[w++] = c;
                }
            } else {
                for (uint256 k; k < n; ++k) {
                    raw[w++] = packed[p++];
                }
            }
        }
        assertEq(w, length);
        BoxSpecV1.BoxSpec memory s = abi.decode(raw, (BoxSpecV1.BoxSpec));
        assertEq(abi.encode(s), raw, "canonical re-encoding");
        BoxSpecV1.VersionContext memory ctx = BoxSpecV1.contextV1();
        ctx.qList[0].raisePresets[0] = 4_206_980_085_000_000_000;
        (uint16 r, uint16 f) = BoxSpecV1.validate(s, ctx);
        assertEq(r, reason, "TS reason");
        assertEq(f, field, "TS field");
        assertEq(BoxSpecV1.specHash(s), expectedHash, "TS hash");
    }

    function _run(uint256 index) internal view {
        bytes memory b = _batch(index);
        uint256 p;
        uint256 count;
        while (p < b.length) {
            uint16 reason = uint16(_uint(b, p, 2));
            uint16 field = uint16(_uint(b, p + 2, 2));
            bytes32 h = bytes32(_uint(b, p + 4, 32));
            uint256 size = _uint(b, p + 36, 3);
            uint256 packedSize = _uint(b, p + 39, 3);
            p += 42;
            bytes memory packed = new bytes(packedSize);
            require(p + packedSize <= b.length, "truncated row");
            assembly ("memory-safe") { mcopy(add(packed, 32), add(add(b, 32), p), packedSize) }
            this.replay(packed, size, reason, field, h);
            p += packedSize;
            count++;
        }
        assertEq(count, 64, "64 vectors per batch");
    }

    function _uint(bytes memory b, uint256 p, uint256 n) internal pure returns (uint256 x) {
        require(p + n <= b.length, "truncated header");
        assembly ("memory-safe") { x := shr(mul(sub(32, n), 8), mload(add(add(b, 32), p))) }
    }

    function testProperty_AUDIT_U9_randomSpecBatch00() public view {
        _run(0);
    }

    function testProperty_AUDIT_U9_randomSpecBatch01() public view {
        _run(1);
    }

    function testProperty_AUDIT_U9_randomSpecBatch02() public view {
        _run(2);
    }

    function testProperty_AUDIT_U9_randomSpecBatch03() public view {
        _run(3);
    }

    function testProperty_AUDIT_U9_randomSpecBatch04() public view {
        _run(4);
    }

    function testProperty_AUDIT_U9_randomSpecBatch05() public view {
        _run(5);
    }

    function testProperty_AUDIT_U9_randomSpecBatch06() public view {
        _run(6);
    }

    function testProperty_AUDIT_U9_randomSpecBatch07() public view {
        _run(7);
    }

    function testProperty_AUDIT_U9_randomSpecBatch08() public view {
        _run(8);
    }

    function testProperty_AUDIT_U9_randomSpecBatch09() public view {
        _run(9);
    }

    function testProperty_AUDIT_U9_randomSpecBatch10() public view {
        _run(10);
    }

    function testProperty_AUDIT_U9_randomSpecBatch11() public view {
        _run(11);
    }

    function testProperty_AUDIT_U9_randomSpecBatch12() public view {
        _run(12);
    }

    function testProperty_AUDIT_U9_randomSpecBatch13() public view {
        _run(13);
    }

    function testProperty_AUDIT_U9_randomSpecBatch14() public view {
        _run(14);
    }

    function testProperty_AUDIT_U9_randomSpecBatch15() public view {
        _run(15);
    }

    function testProperty_AUDIT_U9_randomSpecBatch16() public view {
        _run(16);
    }

    function testProperty_AUDIT_U9_randomSpecBatch17() public view {
        _run(17);
    }

    function testProperty_AUDIT_U9_randomSpecBatch18() public view {
        _run(18);
    }

    function testProperty_AUDIT_U9_randomSpecBatch19() public view {
        _run(19);
    }

    function testProperty_AUDIT_U9_randomSpecBatch20() public view {
        _run(20);
    }

    function testProperty_AUDIT_U9_randomSpecBatch21() public view {
        _run(21);
    }

    function testProperty_AUDIT_U9_randomSpecBatch22() public view {
        _run(22);
    }

    function testProperty_AUDIT_U9_randomSpecBatch23() public view {
        _run(23);
    }

    function testProperty_AUDIT_U9_randomSpecBatch24() public view {
        _run(24);
    }

    function testProperty_AUDIT_U9_randomSpecBatch25() public view {
        _run(25);
    }

    function testProperty_AUDIT_U9_randomSpecBatch26() public view {
        _run(26);
    }

    function testProperty_AUDIT_U9_randomSpecBatch27() public view {
        _run(27);
    }

    function testProperty_AUDIT_U9_randomSpecBatch28() public view {
        _run(28);
    }

    function testProperty_AUDIT_U9_randomSpecBatch29() public view {
        _run(29);
    }

    function testProperty_AUDIT_U9_randomSpecBatch30() public view {
        _run(30);
    }

    function testProperty_AUDIT_U9_randomSpecBatch31() public view {
        _run(31);
    }
}
