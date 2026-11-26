// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BoxSpecV1} from "../../src/box/BoxSpecV1.sol";
import {BoxMetadataTable} from "../../src/box/libraries/BoxMetadataTable.sol";

/// @notice Core item 9 (SH-core-wave-2 spec change 9) and F75 W1:
/// - `BoxSpecV1.validate()` runs the metadata table's format v1 check after its length, so the factory (S7) refuses a
///   malformed table with a reason (METADATA_TABLE_MALFORMED at metadataTable) instead of the creation reverting in
///   the collection's `initialize` (BoxMetadataTable.validate). Differential: on structured tables, mutated or not,
///   validate() says OK exactly when BoxMetadataTable.validate accepts (the shared vectors pin the single cases).
/// - Box 0 with every Misfit trait on chain (R F75 W1): the full round-7 set, 16 types and 3,341 bytes with Character
///   and Finish (test/vectors/box/misfits-trait-table-r7.json, from scripts/box/misfits-trait-table.mjs), passes
///   validate() on box 0's fixture; nothing on the box path caps it at v2's 2,048 bytes.
contract BoxSpecV1MetadataTableTest is Test {
    string internal constant VECTORS = "test/vectors/box-spec/box-spec-v1.json";
    string internal constant R7 = "test/vectors/box/misfits-trait-table-r7.json";

    /// @dev Box 0's fixture (vector 0, version 1), ABI-encoded.
    bytes internal box0;

    function setUp() public {
        box0 = vm.parseJsonBytes(vm.readFile(VECTORS), ".columns.encoded[0]");
    }

    /// @dev The collection's own check, external so a revert can be caught.
    function collectionCheck(bytes calldata table) external pure {
        BoxMetadataTable.validate(table);
    }

    function _verdict(bytes memory table) internal view returns (uint16 reason, uint16 field) {
        BoxSpecV1.BoxSpec memory s = abi.decode(box0, (BoxSpecV1.BoxSpec));
        s.metadataTable = table;
        return BoxSpecV1.validate(s, BoxSpecV1.contextV1());
    }

    function _collectionAccepts(bytes memory table) internal view returns (bool) {
        try this.collectionCheck(table) {
            return true;
        } catch {
            return false;
        }
    }

    // ------------------------------------------------------------------------------------------------ F75 W1

    function test_W1_box0WithEveryMisfitTraitPassesValidate() public view {
        bytes memory t = vm.parseJsonBytes(vm.readFile(R7), ".table");
        assertEq(t.length, 3_341, "the full round-7 set");
        assertGt(t.length, 2_048, "over v2's genesis cap: not a rule of the box path");
        assertEq(vm.parseJsonUint(vm.readFile(R7), ".typeCount"), BoxSpecV1.MAX_TRAIT_TYPES, "16 types, all of them");
        (uint16 reason, uint16 field) = _verdict(t);
        assertEq(reason, BoxSpecV1.REASON_OK);
        assertEq(field, 0);
        assertTrue(_collectionAccepts(t));
    }

    function test_item9_constantsMatchTheCollectionsCheck() public pure {
        assertEq(BoxSpecV1.MAX_TRAIT_TYPES, BoxMetadataTable.MAX_TRAIT_TYPES);
        assertEq(BoxSpecV1.MAX_METADATA_TABLE_BYTES, BoxMetadataTable.MAX_TABLE_BYTES);
    }

    // ------------------------------------------------------------------------------------------------ item 9

    /// A malformed table: the reason and the field, not a revert.
    function test_item9_malformedTableIsRefusedWithAReason() public view {
        (uint16 reason, uint16 field) = _verdict(hex"01000141");
        assertEq(reason, BoxSpecV1.REASON_METADATA_TABLE_MALFORMED);
        assertEq(field, BoxSpecV1.FIELD_METADATA_TABLE);
        assertFalse(_collectionAccepts(hex"01000141"));
        // The length check stays first.
        (reason, field) = _verdict("");
        assertEq(reason, BoxSpecV1.REASON_LENGTH_OUT_OF_RANGE);
    }

    /// @dev A structured table from the seed: a description, 0-17 types (17 is one too many), 1-4 values each, texts of
    /// 1-6 bytes drawn mostly from JSON_TEXT, some from the refused bytes.
    function _table(uint256 seed) internal pure returns (bytes memory t) {
        uint256 r = seed;
        uint256 descLength = r % 5;
        r = uint256(keccak256(abi.encode(r)));
        t = abi.encodePacked(uint8(1), uint16(descLength), _text(r, descLength));
        r = uint256(keccak256(abi.encode(r)));
        uint256 types = r % 18;
        t = bytes.concat(t, bytes1(uint8(types)));
        for (uint256 i; i < types; ++i) {
            r = uint256(keccak256(abi.encode(r, i)));
            uint256 nameLength = 1 + r % 6;
            t = bytes.concat(t, bytes1(uint8(nameLength)), _text(r >> 8, nameLength));
            uint256 values = 1 + (r >> 16) % 4;
            t = bytes.concat(t, bytes1(uint8(values)));
            for (uint256 v; v < values; ++v) {
                r = uint256(keccak256(abi.encode(r, v)));
                uint256 valueLength = 1 + r % 6;
                t = bytes.concat(t, bytes1(uint8(valueLength)), _text(r >> 8, valueLength));
            }
        }
    }

    /// @dev `n` bytes: letters, and with a small chance one of the bytes the JSON_TEXT rule refuses.
    function _text(uint256 seed, uint256 n) internal pure returns (bytes memory s) {
        s = new bytes(n);
        bytes memory refused = hex"00091f227f5c80ff";
        for (uint256 i; i < n; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            s[i] = r % 40 == 0 ? refused[(r >> 8) % refused.length] : bytes1(uint8(0x41 + (r >> 8) % 26));
        }
    }

    /// Differential against the collection's check: structured tables, then one change (a byte set, the last byte
    /// dropped, or a byte appended), or none.
    function testFuzz_item9_validateAgreesWithTheCollectionsCheck(uint256 seed, uint8 change, uint16 at, uint8 value)
        public
        view
    {
        bytes memory t = _table(seed);
        uint8 kind = change % 4;
        if (kind == 1) {
            t[at % t.length] = bytes1(value);
        } else if (kind == 2) {
            assembly ("memory-safe") {
                mstore(t, sub(mload(t), 1))
            }
        } else if (kind == 3) {
            t = bytes.concat(t, bytes1(value));
        }
        bool accepted = _collectionAccepts(t);
        (uint16 reason, uint16 field) = _verdict(t);
        if (accepted) {
            assertEq(reason, BoxSpecV1.REASON_OK, "the collection accepts it, so validate() must");
        } else {
            assertTrue(
                reason == BoxSpecV1.REASON_METADATA_TABLE_MALFORMED || reason == BoxSpecV1.REASON_LENGTH_OUT_OF_RANGE,
                "the collection refuses it, so validate() must"
            );
            assertEq(field, BoxSpecV1.FIELD_METADATA_TABLE);
        }
    }

    /// The differential above sees both outcomes: of 64 unchanged structured tables, some are accepted, some refused.
    function test_item9_generatorYieldsBothOutcomes() public view {
        uint256 accepted;
        for (uint256 i; i < 64; ++i) {
            if (_collectionAccepts(_table(i))) ++accepted;
        }
        assertGt(accepted, 8, "well-formed tables");
        assertLt(accepted, 56, "malformed tables");
    }

    /// Any bytes at all: validate() never reverts, and agrees with the collection.
    function testFuzz_item9_anyBytes(bytes calldata t) public view {
        vm.assume(t.length > 0 && t.length <= BoxSpecV1.MAX_METADATA_TABLE_BYTES);
        bool accepted = _collectionAccepts(t);
        (uint16 reason,) = _verdict(t);
        assertEq(reason == BoxSpecV1.REASON_OK, accepted);
    }
}
