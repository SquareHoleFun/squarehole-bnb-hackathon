// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {BoxShuffle} from "../../../../src/box/libraries/BoxShuffle.sol";

/// @notice U6.10: exhaustive image/inverse checks for each chosen domain, including the two edition sizes.
contract AuditU6LaneShuffle is Test {
    function _bijection(bytes32 key, uint256 q) internal pure {
        (uint256 u, uint256 v) = BoxShuffle.halves(q);
        bool[] memory seen = new bool[](q);
        for (uint256 x; x < q; ++x) {
            uint256 y = BoxShuffle.permute(key, x, q, u, v);
            assertLt(y, q);
            assertFalse(seen[y], "duplicate image");
            seen[y] = true;
            assertEq(BoxShuffle.invert(key, y, q, u, v), x);
        }
    }

    function testProperty_AUDIT_U6_exhaustiveSmallAndEditionDomains() public pure {
        for (uint256 q = 1; q <= 64; ++q) {
            _bijection(keccak256(abi.encode("small domain", q)), q);
        }
        _bijection(keccak256("1969"), 1_969);
        _bijection(keccak256("4269"), 4_269);
    }

    function testFuzz_AUDIT_U6_bijectionUpToTenThousand(bytes32 key, uint256 q) public pure {
        q = bound(q, 1, 10_000);
        _bijection(key, q);
    }
}
