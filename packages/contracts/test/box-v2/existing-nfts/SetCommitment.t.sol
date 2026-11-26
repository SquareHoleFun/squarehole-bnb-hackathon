// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {SetCommitment, SetPage, SetRefused} from "../../../src/box-v2/set/SetTypesV2.sol";
import {SetCommitmentV2 as Commit} from "../../../src/box-v2/set/SetCommitmentV2.sol";
import {SetVectors} from "./SetVectors.sol";

contract SetCommitmentTest is Test {
    address private constant COLLECTION = 0x1111111111111111111111111111111111111111;

    function build(address collection, uint256[] memory ids, uint256 size)
        external
        pure
        returns (SetCommitment memory, SetPage[] memory)
    {
        return Commit.build(collection, ids, size);
    }

    function _ids(uint256 n) private pure returns (uint256[] memory ids) {
        ids = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = i;
        }
    }

    function _expect(SetCommitment memory c, SetPage[] memory pages, uint16 reason, uint16 field) private pure {
        (uint16 r, uint16 f) = Commit.verify(c, pages);
        assertEq(r, reason);
        assertEq(f, field);
    }

    function test_E01_commitmentVectorsIncludingZeroAndMaxUint256() public pure {
        for (uint256 i; i < 2; ++i) {
            uint256[] memory ids = SetVectors.ids(i);
            (SetCommitment memory c, SetPage[] memory pages) = Commit.build(COLLECTION, ids, 32);
            assertEq(c.setHash, SetVectors.root(i));
            assertEq(c.count, ids.length);
            assertEq(ids[0], 0);
            assertEq(ids[1], type(uint256).max);
            assertEq(pages[0].nextHash, SetVectors.suffix32(i));
            assertEq(pages[pages.length - 1].nextHash, bytes32(0));
            _expect(c, pages, 0, 0);
        }
        for (uint256 i; i < 3; ++i) {
            uint256 index = i == 2 ? 32 : i;
            (address collection, uint256 id, uint8 tier, bytes32 nextHash) =
                abi.decode(SetVectors.link(index), (address, uint256, uint8, bytes32));
            assertEq(Commit.encodeLink(collection, id, nextHash), SetVectors.link(index));
            assertEq(tier, 0);
        }
    }

    function test_E01_commitmentCountBoundsAnd313Pages() public {
        vm.expectRevert(abi.encodeWithSelector(SetRefused.selector, uint16(4), uint16(11)));
        this.build(COLLECTION, _ids(9), 32);
        vm.expectRevert(abi.encodeWithSelector(SetRefused.selector, uint16(4), uint16(11)));
        this.build(COLLECTION, _ids(10001), 32);
        (SetCommitment memory c, SetPage[] memory pages) = Commit.build(COLLECTION, _ids(10), 32);
        _expect(c, pages, 0, 0);
        (c, pages) = Commit.build(COLLECTION, _ids(10000), 32);
        assertEq(pages.length, 313);
        assertEq(pages[312].ids.length, 16);
        _expect(c, pages, 0, 0);
    }

    function test_E01_wrongOrderHashCountTierCollection() public pure {
        for (uint256 i; i < 5; ++i) {
            (SetCommitment memory c, SetPage[] memory pages) = Commit.build(COLLECTION, SetVectors.ids(0), 32);
            uint16 reason;
            uint16 field;
            if (i == 0) {
                (pages[0].ids[0], pages[0].ids[1]) = (pages[0].ids[1], pages[0].ids[0]);
                reason = 31;
                field = 12;
            }
            if (i == 1) {
                c.setHash = bytes32(uint256(1));
                reason = 31;
                field = 12;
            }
            if (i == 2) {
                c.count = 32;
                reason = 30;
                field = 11;
            }
            if (i == 3) {
                pages[0].tiers[0] = 1;
                reason = 33;
                field = 12;
            }
            if (i == 4) {
                pages[0].collections[0] = address(0x2222);
                reason = 32;
                field = 10;
            }
            _expect(c, pages, reason, field);
        }
    }

    function test_E01_duplicateIdsWithinAndAcrossRehashedPages() public {
        for (uint256 offset = 1; offset <= 32; offset += 31) {
            uint256[] memory ids = SetVectors.ids(0);
            ids[offset] = 0;
            vm.expectRevert(abi.encodeWithSelector(SetRefused.selector, uint16(34), uint16(12)));
            this.build(COLLECTION, ids, 32);
            (SetCommitment memory c, SetPage[] memory pages) = Commit.build(COLLECTION, SetVectors.ids(0), 32);
            pages[offset / 32].ids[offset % 32] = 0;
            bytes32 hash;
            for (uint256 p = pages.length; p != 0;) {
                --p;
                pages[p].nextHash = hash;
                for (uint256 j = pages[p].ids.length; j != 0;) {
                    --j;
                    hash = keccak256(abi.encode(COLLECTION, pages[p].ids[j], uint8(0), hash));
                }
            }
            c.setHash = hash;
            _expect(c, pages, 34, 12);
        }
    }

    function test_E01_pageShapeTruncationAndTerminalRules() public pure {
        for (uint256 i; i < 6; ++i) {
            (SetCommitment memory c, SetPage[] memory pages) = Commit.build(COLLECTION, SetVectors.ids(0), 32);
            if (i == 0) pages[0].ids = new uint256[](0);
            if (i == 1) pages[0].ids = new uint256[](33);
            if (i == 2) pages[0].tiers = new uint8[](31);
            if (i == 3) pages[1].nextHash = bytes32(uint256(1));
            if (i == 4) {
                SetPage[] memory short = new SetPage[](1);
                short[0] = pages[0];
                pages = short;
            }
            if (i == 5) {
                SetPage[] memory extra = new SetPage[](3);
                extra[0] = pages[0];
                extra[1] = pages[1];
                extra[2] = pages[1];
                pages = extra;
            }
            _expect(c, pages, i < 3 ? 35 : 30, i < 3 ? type(uint16).max : 11);
        }
    }

    function test_E01_invalidCollectionAndPageSize() public {
        vm.expectRevert(abi.encodeWithSelector(SetRefused.selector, uint16(7), uint16(10)));
        this.build(address(0), _ids(10), 32);
        vm.expectRevert(abi.encodeWithSelector(SetRefused.selector, uint16(35), type(uint16).max));
        this.build(COLLECTION, _ids(10), 0);
        vm.expectRevert(abi.encodeWithSelector(SetRefused.selector, uint16(35), type(uint16).max));
        this.build(COLLECTION, _ids(10), 33);
    }

    function testFuzz_E01_arbitraryIdsAndPagePartition(uint256 first, uint8 size) public pure {
        uint256[] memory ids = new uint256[](33);
        for (uint256 i; i < 33; ++i) {
            ids[i] = first ^ i;
        }
        uint256 pageSize = uint256(size) % 32 + 1;
        (SetCommitment memory c, SetPage[] memory pages) = Commit.build(COLLECTION, ids, pageSize);
        bytes32 independent;
        for (uint256 i = ids.length; i != 0;) {
            --i;
            independent = keccak256(abi.encode(COLLECTION, ids[i], uint8(0), independent));
        }
        assertEq(c.setHash, independent);
        _expect(c, pages, 0, 0);
        for (uint256 i; i < ids.length; ++i) {
            assertEq(ids[i], first ^ i); // Tooling must not reorder the input.
        }
    }
}
