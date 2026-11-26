// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IBoxCollection} from "../interfaces/IBoxCollection.sol";
import {BoxEncoding} from "./BoxEncoding.sol";

/// @title BoxMetadataTable
/// @notice The collection's metadata table, format v1, unchanged from MisfitsCollection (src/v2/MisfitsCollection.sol:
/// 60-64 at 46a030f6): 0x01, uint16 description length (big-endian), description, uint8 trait-type count (≤ 16), then
/// per type: uint8 name length (≥ 1), name, uint8 value count (≥ 1), per value uint8 length (≥ 1) and bytes. Every string
/// is printable ASCII (0x20-0x7E) without `"` or `\`, so the collection writes it into JSON without escaping.
/// `traitsPacked` (uint128) holds one byte per type, type i in bits 8i..8i+7: 0 = absent, v ≥ 1 = the v-th value; a v
/// beyond the table renders as its decimal number; bytes of types the table does not have are ignored.
///
/// Copied and made a library: `validate` from `_validateTable` / `_byteAt` / `_text` (`:620-697`), `attributes` from
/// `_attributes` (`:551-590`), `slice` from `_slice` (`:592-597`). The collection validates its table once, at
/// `initialize`; S7 and the off-chain builder can run the same check before a box is created.
/// @dev Written for Square Hole (MIT, no third-party code).
library BoxMetadataTable {
    uint8 internal constant VERSION = 1;
    /// @dev 16 types × one byte = traitsPacked's 128 bits.
    uint256 internal constant MAX_TRAIT_TYPES = 16;
    /// @dev EIP-170 less the data contract's STOP prefix (BoxSpecV1.MAX_METADATA_TABLE_BYTES).
    uint256 internal constant MAX_TABLE_BYTES = 24_575;

    /// @notice Reverts `InvalidMetadataTable(offset)` with the first offending offset unless `table` is well formed:
    /// the version byte, the description, at most 16 types, names and values of at least one byte, every text JSON-safe
    /// printable ASCII, and nothing after the last value. Same rules and offsets as MisfitsCollection's `_validateTable`
    /// (`:620-697`), in one assembly walk that tests text 32 bytes at a time (`_wordOk`); `test/box/items/
    /// BoxMetadataTable.t.sol` fuzzes it against that Solidity original.
    function validate(bytes memory table) internal pure {
        uint256 length = table.length;
        if (length > MAX_TABLE_BYTES) revert IBoxCollection.InvalidMetadataTable(length);
        assembly ("memory-safe") {
            // Reverts InvalidMetadataTable(o) (selector 0x8b055b20).
            function fail(o) {
                mstore(0x00, shl(224, 0x8b055b20))
                mstore(0x04, o)
                revert(0x00, 0x24)
            }
            // The byte at offset o, or fail(o) past the end.
            function at(d, l, o) -> b {
                if iszero(lt(o, l)) { fail(o) }
                b := byte(0, mload(add(d, o)))
            }
            // Every byte in 0x20-0x7e, none `"` or `\`: the exact "some byte is" bit tricks (see `_wordOk`).
            function ok(w) -> y {
                let ones := 0x0101010101010101010101010101010101010101010101010101010101010101
                let highs := 0x8080808080808080808080808080808080808080808080808080808080808080
                let below :=
                    and(and(sub(w, 0x2020202020202020202020202020202020202020202020202020202020202020), not(w)), highs)
                let above := and(or(add(w, ones), w), highs)
                let q := xor(w, 0x2222222222222222222222222222222222222222222222222222222222222222)
                let b := xor(w, 0x5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c)
                y := iszero(
                    or(
                        or(below, above),
                        or(and(and(sub(q, ones), not(q)), highs), and(and(sub(b, ones), not(b)), highs))
                    )
                )
            }
            // n bytes of text from s: fail(l) when they run past the end, else fail at the first refused byte.
            function text(d, l, s, n) -> e {
                e := add(s, n)
                if gt(e, l) { fail(l) }
                for { let p := s } lt(p, e) { p := add(p, 32) } {
                    let w := mload(add(d, p))
                    let left := sub(e, p)
                    if lt(left, 32) {
                        let keep := shl(shl(3, sub(32, left)), not(0))
                        w := or(
                            and(w, keep),
                            and(0x4141414141414141414141414141414141414141414141414141414141414141, not(keep))
                        )
                    }
                    if iszero(ok(w)) {
                        for { let i := p } 1 { i := add(i, 1) } {
                            let c := byte(0, mload(add(d, i)))
                            if iszero(and(shr(c, 0x7fffffffeffffffffffffffb00000000), 1)) { fail(i) }
                        }
                    }
                }
            }
            let d := add(table, 0x20)
            let l := mload(table)
            if iszero(eq(at(d, l, 0), 1)) { fail(0) }
            let hi := at(d, l, 1)
            let cursor := text(d, l, 3, or(shl(8, hi), at(d, l, 2)))
            let types := at(d, l, cursor)
            if gt(types, 16) { fail(cursor) }
            cursor := add(cursor, 1)
            for { let t := 0 } lt(t, types) { t := add(t, 1) } {
                let nameLength := at(d, l, cursor)
                if iszero(nameLength) { fail(cursor) }
                cursor := text(d, l, add(cursor, 1), nameLength)
                let values := at(d, l, cursor)
                if iszero(values) { fail(cursor) }
                cursor := add(cursor, 1)
                for { let v := 0 } lt(v, values) { v := add(v, 1) } {
                    let valueLength := at(d, l, cursor)
                    if iszero(valueLength) { fail(cursor) }
                    cursor := text(d, l, add(cursor, 1), valueLength)
                }
            }
            if iszero(eq(cursor, l)) { fail(cursor) }
        }
    }

    /// @notice The per-item description (a well-formed table's bytes 3 … 3 + its length).
    function description(bytes memory table) internal pure returns (bytes memory) {
        return slice(table, 3, descriptionLength(table));
    }

    function descriptionLength(bytes memory table) internal pure returns (uint256) {
        return (uint256(uint8(table[1])) << 8) | uint256(uint8(table[2]));
    }

    /// @notice The JSON attribute objects of `traitsPacked`, comma-separated (a well-formed table).
    function attributes(bytes memory table, uint128 traitsPacked) internal pure returns (bytes memory out) {
        uint256 cursor = 3 + descriptionLength(table);
        uint256 typeCount = uint8(table[cursor]);
        ++cursor;
        for (uint256 t; t < typeCount; ++t) {
            uint256 nameLength = uint8(table[cursor]);
            uint256 nameStart = cursor + 1;
            cursor = nameStart + nameLength;
            uint256 valueCount = uint8(table[cursor]);
            ++cursor;
            uint256 wanted = (uint256(traitsPacked) >> (8 * t)) & 0xff;
            bytes memory value;
            for (uint256 v = 1; v <= valueCount; ++v) {
                uint256 length = uint8(table[cursor]);
                if (v == wanted) value = slice(table, cursor + 1, length);
                cursor += 1 + length;
            }
            if (wanted == 0) continue;
            if (wanted > valueCount) value = bytes(BoxEncoding.toString(wanted));
            out = bytes.concat(
                out,
                out.length == 0 ? bytes("") : bytes(","),
                '{"trait_type":"',
                slice(table, nameStart, nameLength),
                '","value":"',
                value,
                '"}'
            );
        }
    }

    /// @notice `length` bytes of `data` from `start`, copied (the callers stay inside `data`).
    function slice(bytes memory data, uint256 start, uint256 length) internal pure returns (bytes memory out) {
        out = new bytes(length);
        assembly ("memory-safe") {
            mcopy(add(out, 0x20), add(add(data, 0x20), start), length)
        }
    }

    /// @dev Word-at-a-time text test, the readable twin of `validate`'s inline `ok`: true when every byte of `w` is in
    /// 0x20-0x7e and none is `"` or `\\`. Each test is the exact "some byte is" predicate of the classic bit tricks (a
    /// false hit only ever follows a true one): below 0x20, (w − 0x20…) & ~w & 0x80…; above 0x7e, ((w + 0x01…) | w) &
    /// 0x80…; equal to c, haszero(w ⊕ c…).
    function _wordOk(uint256 w) internal pure returns (bool y) {
        assembly ("memory-safe") {
            let ones := 0x0101010101010101010101010101010101010101010101010101010101010101
            let highs := 0x8080808080808080808080808080808080808080808080808080808080808080
            let below :=
                and(and(sub(w, 0x2020202020202020202020202020202020202020202020202020202020202020), not(w)), highs)
            let above := and(or(add(w, ones), w), highs)
            let q := xor(w, 0x2222222222222222222222222222222222222222222222222222222222222222)
            let b := xor(w, 0x5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c)
            y := iszero(
                or(or(below, above), or(and(and(sub(q, ones), not(q)), highs), and(and(sub(b, ones), not(b)), highs)))
            )
        }
    }
}
