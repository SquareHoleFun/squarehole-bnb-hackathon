// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {Listing, ReleaseContext, GradLayout} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {Leg, Dest, Split, HoldersCurrency} from "../../../src/box-v2/interfaces/RecipeTypes.sol";
contract SpecV2WireTest is Test {
    function test_BC230_contextIsOneStaticListingAndFrozenIdsRemain() public pure {
        ReleaseContext memory c = ReleaseContext(Listing(7, address(0x42), 8, 5, 1, 1_000_000));
        assertEq(abi.encode(c), abi.encode(uint32(7), address(0x42), uint8(8), uint8(5), uint8(1), uint256(1_000_000)));
        assertEq(uint8(GradLayout.FULL_RANGE), 3); assertEq(uint8(Leg.RESERVED_3), 3);
        assertEq(uint8(Dest.RESERVED_5), 5); assertEq(uint8(Split.RESERVED_4), 4);
        assertEq(uint8(HoldersCurrency.P), 1);
    }
}
