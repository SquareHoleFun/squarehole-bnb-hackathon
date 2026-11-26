// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LibSort} from "../../../lib/dn404/lib/solady/src/utils/LibSort.sol";
import {SetCommitment, SetPage, SetRefused} from "./SetTypesV2.sol";
import {SetConstantsV2 as C, SetReason as R} from "./SetConstantsV2.sol";

/// @notice Pure complete-list tooling, not vault custody or a replacement for the unchanged bounded loader.
library SetCommitmentV2 {
    function encodeLink(address collection, uint256 id, bytes32 nextHash) internal pure returns (bytes memory) {
        return abi.encode(collection, id, uint8(0), nextHash);
    }

    function linkHash(address collection, uint256 id, bytes32 nextHash) internal pure returns (bytes32) {
        return keccak256(encodeLink(collection, id, nextHash));
    }

    /// @notice Builds the hash-fixed list and pages without sorting or mutating the caller's ordered ids.
    /// @dev Full-list tooling may be expensive at 10,000 ids. Production loading remains bounded to 32.
    function build(address collection, uint256[] memory ids, uint256 pageSize)
        internal
        pure
        returns (SetCommitment memory commitment, SetPage[] memory pages)
    {
        if (collection == address(0)) revert SetRefused(R.ZERO_VALUE, 10);
        uint256 n = ids.length;
        if (n < C.MIN_COUNT || n > C.MAX_COUNT) revert SetRefused(R.OUT_OF_RANGE, 11);
        if (pageSize == 0 || pageSize > C.MAX_PAGE) revert SetRefused(R.PAGE_SIZE, R.GLOBAL);
        if (_duplicates(ids)) revert SetRefused(R.DUPLICATE_ID, 12);
        bytes32[] memory hashes = new bytes32[](n + 1);
        for (uint256 i = n; i != 0;) {
            --i;
            hashes[i] = linkHash(collection, ids[i], hashes[i + 1]);
        }
        // n <= 10000 above.
        // forge-lint: disable-next-line(unsafe-typecast)
        commitment = SetCommitment(collection, uint32(n), hashes[0]);
        pages = new SetPage[]((n + pageSize - 1) / pageSize);
        for (uint256 p; p < pages.length; ++p) {
            uint256 start = p * pageSize;
            uint256 size = n - start < pageSize ? n - start : pageSize;
            SetPage memory page;
            page.collections = new address[](size);
            page.ids = new uint256[](size);
            page.tiers = new uint8[](size);
            page.nextHash = hashes[start + size];
            for (uint256 j; j < size; ++j) {
                page.collections[j] = collection;
                page.ids[j] = ids[start + j];
            }
            pages[p] = page;
        }
    }

    /// @notice Verifies every page and global uniqueness; a partial prefix is never a complete commitment.
    function verify(SetCommitment memory c, SetPage[] memory pages) internal pure returns (uint16, uint16) {
        if (c.collection == address(0)) return (R.ZERO_VALUE, 10);
        if (c.count < C.MIN_COUNT || c.count > C.MAX_COUNT) return (R.OUT_OF_RANGE, 11);
        if (c.setHash == bytes32(0)) return (R.ZERO_VALUE, 12);
        if (pages.length == 0 || pages.length > c.count) return (R.COUNT_MISMATCH, 11);
        uint256[] memory ids = new uint256[](c.count);
        uint256 loaded;
        bytes32 remaining = c.setHash;
        for (uint256 p; p < pages.length; ++p) {
            SetPage memory page = pages[p];
            uint256 n = page.ids.length;
            if (n == 0 || n > C.MAX_PAGE || page.collections.length != n || page.tiers.length != n) {
                return (R.PAGE_SIZE, R.GLOBAL);
            }
            uint256 end = loaded + n;
            if (end > c.count || (end == c.count) != (page.nextHash == bytes32(0))) return (R.COUNT_MISMATCH, 11);
            for (uint256 i; i < n; ++i) {
                if (page.collections[i] != c.collection) return (R.COLLECTION_MISMATCH, 10);
                if (page.tiers[i] != 0) return (R.NONZERO_TIER, 12);
                ids[loaded + i] = page.ids[i];
            }
            bytes32 hash = page.nextHash;
            for (uint256 i = n; i != 0;) {
                --i;
                hash = linkHash(c.collection, page.ids[i], hash);
            }
            if (hash != remaining) return (R.HASH_MISMATCH, 12);
            loaded = end;
            remaining = page.nextHash;
        }
        if (loaded != c.count || remaining != bytes32(0)) return (R.COUNT_MISMATCH, 11);
        if (_duplicates(ids)) return (R.DUPLICATE_ID, 12);
        return (R.OK, 0);
    }

    function _duplicates(uint256[] memory ids) private pure returns (bool) {
        uint256[] memory sorted = new uint256[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            sorted[i] = ids[i];
        }
        LibSort.sort(sorted);
        for (uint256 i = 1; i < sorted.length; ++i) {
            if (sorted[i] == sorted[i - 1]) return true;
        }
        return false;
    }
}
