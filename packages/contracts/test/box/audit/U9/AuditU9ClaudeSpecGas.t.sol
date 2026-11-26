// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BoxFactoryV1Planner} from "../../../../src/box/BoxFactoryV1Planner.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxMetadataTable} from "../../../../src/box/libraries/BoxMetadataTable.sol";
import {AuditU9ClaudeTwinVectors as TV} from "./AuditU9ClaudeTwinVectors.sol";

/// @notice TEST ONLY: measures a call's gas inside one transaction (forge runs each top-level call as its own).
contract AuditU9ClaudeGasProbe {
    function refusalGas(BoxFactoryV1Planner planner, BoxSpecV1.BoxSpec calldata s, address safe)
        external
        view
        returns (uint256 gasUsed, uint256 refusalLength)
    {
        uint256 g = gasleft();
        bytes memory r = planner.refusal(s, safe);
        gasUsed = g - gasleft();
        refusalLength = r.length;
    }
}

/// @notice TEST ONLY: the largest spec validate() accepts under version 1 (box 0's fixture with every text, the table
/// and the add-on list at their limits), shared with the creation measurement (AuditU9ClaudeCreationGas.t.sol).
library AuditU9ClaudeLargestSpec {
    function fill(uint256 len, bytes1 c) internal pure returns (bytes memory b) {
        b = new bytes(len);
        for (uint256 i; i < len; ++i) {
            b[i] = c;
        }
    }

    /// @dev 24,575 bytes: 16 types of 255 one-byte values (4,080 texts, the most the format holds) and the rest one
    /// description.
    function maxTable() internal pure returns (bytes memory t) {
        bytes memory body;
        for (uint256 i; i < 16; ++i) {
            bytes memory ty = abi.encodePacked(uint8(1), bytes1(uint8(0x41 + i)), uint8(255));
            for (uint256 v; v < 255; ++v) {
                ty = bytes.concat(ty, hex"01", bytes1(uint8(0x61 + v % 26)));
            }
            body = bytes.concat(body, ty);
        }
        uint256 desc = 24_575 - 4 - body.length;
        t = abi.encodePacked(uint8(1), uint16(desc), fill(desc, "d"), uint8(16), body);
    }

    /// @dev The largest spec validate() accepts under version 1: box 0's fixture with every text at its limit.
    function largest() internal pure returns (BoxSpecV1.BoxSpec memory s) {
        s = abi.decode(TV.base(0), (BoxSpecV1.BoxSpec));
        s.tokenName = string(fill(32, "T"));
        s.tokenSymbol = string(fill(11, "S"));
        s.collectionName = string(fill(32, "C"));
        s.collectionSymbol = string(fill(11, "Y"));
        s.description = string(fill(1024, "D"));
        s.n = 10_000;
        s.metadataTable = maxTable();
        BoxSpecV1.AddOn[] memory a = new BoxSpecV1.AddOn[](8);
        a[0] = BoxSpecV1.AddOn({
            id: BoxSpecV1.ADD_ON_PLACEHOLDERS,
            params: abi.encode(
                string(fill(32, "p")),
                string(fill(11, "q")),
                string(fill(1024, "r")),
                string(fill(1024, "s")),
                string(fill(4096, "<"))
            )
        });
        a[1] = BoxSpecV1.AddOn({id: BoxSpecV1.ADD_ON_PER_ITEM_STREAM, params: ""});
        for (uint256 i; i < 4; ++i) {
            a[2 + i] = BoxSpecV1.AddOn({
                id: BoxSpecV1.ADD_ON_EDITION_SPECIALS, params: abi.encode(string(fill(32, "e")), uint32(10_000))
            });
        }
        a[6] = BoxSpecV1.AddOn({id: BoxSpecV1.ADD_ON_ROYALTIES, params: abi.encode(uint16(500), uint8(1))});
        bytes32[] memory teasers = new bytes32[](4);
        for (uint256 i; i < 4; ++i) {
            teasers[i] = bytes32(i + 1);
        }
        a[7] = BoxSpecV1.AddOn({
            id: BoxSpecV1.ADD_ON_COLLECTION_METADATA,
            params: abi.encode(bytes32(uint256(1)), teasers, string.concat("https://", string(fill(120, "l"))))
        });
        s.addOns = a;
    }
}

/// @title AuditU9ClaudeSpecGasTest (SH-AUDIT-B0-U9, Claude; P9.4; lens L5)
/// @notice `validate()` at the largest spec it accepts (every text at its limit, the 24,575-byte table with the most
/// texts, eight add-ons each at its limits, N 10,000), measured and pinned: in memory (the library alone), and as the
/// factory runs it (`BoxFactoryV1Planner.refusal`, an external call that ABI-decodes the whole spec, then validate()
/// and template 0's rules). S7 finding 1 recorded validate() at 3.36M inside a largest-data createBox of 16,334,111 gas,
/// inside EIP-7825's 16,777,216 but without BC-068's 1M margin; not re-reported: this pins the library's share, per
/// EVM, and its margin. Box 0's own spec is far below (pinned beside it).
contract AuditU9ClaudeSpecGasTest is Test {
    uint256 internal constant EIP7825_CAP = 16_777_216;

    /// @dev The bounds this suite states for the active EVM (P9.4): validate() in memory and the factory's refusal.
    /// The figures (measured: 5,355,625 and 5,393,757 on cancun, osaka and amsterdam alike) are above S7 finding 1's
    /// recorded 3.36M: that trace's table was not the one with the most texts (4,080 one-byte values, each a call of
    /// `_tableText`); see the evidence's "Already recorded".
    function _memoryBound() internal pure virtual returns (uint256) {
        return 5_500_000;
    }

    function _refusalBound() internal pure virtual returns (uint256) {
        return 5_500_000;
    }

    /// P9.4: validate() at the largest accepted spec, measured and pinned with its EIP-7825 margin.
    function testProperty_AUDIT_U9_validateGasAtTheLargestSpec() public {
        BoxSpecV1.BoxSpec memory s = AuditU9ClaudeLargestSpec.largest();
        BoxSpecV1.VersionContext memory ctx = BoxSpecV1.contextV1();
        uint256 g = gasleft();
        (uint16 reason, uint16 field) = BoxSpecV1.validate(s, ctx);
        uint256 inMemory = g - gasleft();
        assertEq(reason, BoxSpecV1.REASON_OK, "the largest spec is accepted");
        assertEq(field, 0);
        BoxMetadataTable.validate(s.metadataTable);
        assertEq(s.metadataTable.length, BoxSpecV1.MAX_METADATA_TABLE_BYTES);
        assertEq(s.addOns.length, BoxSpecV1.MAX_ADD_ONS);
        bytes memory encoded = abi.encode(s);
        BoxFactoryV1Planner planner = new BoxFactoryV1Planner();
        AuditU9ClaudeGasProbe probe = new AuditU9ClaudeGasProbe();
        (uint256 viaPlanner, uint256 refusalLength) = probe.refusalGas(planner, s, BoxSpecV1.PLATFORM_SAFE_MAINNET);
        assertEq(refusalLength, 0, "template 0 accepts it too");
        // Box 0's own spec (the fixture), for scale.
        BoxSpecV1.BoxSpec memory box0 = abi.decode(TV.base(0), (BoxSpecV1.BoxSpec));
        g = gasleft();
        BoxSpecV1.validate(box0, ctx);
        uint256 box0Gas = g - gasleft();
        emit log_named_string("evm", vm.getEvmVersion());
        emit log_named_uint("largest spec: ABI bytes", encoded.length);
        emit log_named_uint("largest spec: validate() in memory", inMemory);
        emit log_named_uint("largest spec: planner.refusal (decode + validate + template 0)", viaPlanner);
        emit log_named_uint("box 0's fixture: validate() in memory", box0Gas);
        emit log_named_uint("EIP-7825 cap less the refusal", EIP7825_CAP - viaPlanner);
        assertLt(inMemory, _memoryBound(), "validate() in memory: the stated bound");
        assertLt(viaPlanner, _refusalBound(), "the factory's refusal: the stated bound");
        assertLt(box0Gas, 200_000, "box 0 is far below");
        assertGt(EIP7825_CAP - viaPlanner, 11_000_000, "validate's share alone leaves 11.38M of the transaction cap");
    }

    /// Validation cost is linear in the table (bytes and texts): the same spec with a 1,000-byte table and with none
    /// of the long texts, for the record.
    function testProperty_AUDIT_U9_validateGasScalesWithTheData() public {
        BoxSpecV1.BoxSpec memory s = AuditU9ClaudeLargestSpec.largest();
        BoxSpecV1.VersionContext memory ctx = BoxSpecV1.contextV1();
        uint256 g = gasleft();
        BoxSpecV1.validate(s, ctx);
        uint256 full = g - gasleft();
        s.metadataTable = abi.encodePacked(uint8(1), uint16(996), AuditU9ClaudeLargestSpec.fill(996, "d"), uint8(0));
        g = gasleft();
        (uint16 reason,) = BoxSpecV1.validate(s, ctx);
        uint256 smallTable = g - gasleft();
        assertEq(reason, BoxSpecV1.REASON_OK);
        emit log_named_uint("largest spec", full);
        emit log_named_uint("same with a 1,000-byte table", smallTable);
        emit log_named_uint("the 24,575-byte table's share", full - smallTable);
        assertGt(full, smallTable);
    }
}

/// forge-config: default.evm_version = "osaka"
contract AuditU9ClaudeSpecGasOsakaTest is AuditU9ClaudeSpecGasTest {}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU9ClaudeSpecGasAmsterdamTest is AuditU9ClaudeSpecGasTest {}
