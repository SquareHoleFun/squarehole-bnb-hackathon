// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxBuildV1} from "sh-box-build/BoxBuildV1.sol";

abstract contract AuditU9LaneBase is Test {
    function _spec() internal pure returns (BoxSpecV1.BoxSpec memory s) {
        s.version = 1;
        s.boxType = BoxSpecV1.BOX_TYPE_NEW_COLLECTION;
        s.tokenName = "FIT";
        s.tokenSymbol = "FIT";
        s.collectionName = "U9";
        s.collectionSymbol = "U9";
        s.n = 10;
        s.firstId = 1;
        s.raise = BoxBuildV1.RAISE;
        s.layout = BoxSpecV1.LAYOUT_CURVE_V1;
        s.gradLayout = BoxSpecV1.GRAD_LAYOUT_ASK_FULL_BID_SENTINEL;
        s.launchFormat = BoxSpecV1.LAUNCH_FORMAT_CURVE;
        s.qStream = BoxSpecV1.Q_STREAM_ALL_TO_FIT;
        s.tStream = BoxSpecV1.T_STREAM_BURN_T;
        s.artMode = BoxSpecV1.ART_MODE_OPEN;
        s.revealRoot = bytes32(uint256(1));
        s.metadataTable = hex"01000000";
        s.coverSha256 = bytes32(uint256(2));
        s.revealListId = bytes32(uint256(3));
        s.marketplaceOwner = BoxSpecV1.PLATFORM_SAFE_MAINNET;
        s.collectionCoverSha256 = bytes32(uint256(4));
        s.addOns = new BoxSpecV1.AddOn[](0);
    }

    function _verdict(BoxSpecV1.BoxSpec memory s, uint16 expectedReason, uint16 expectedField) internal pure {
        // Exercise wire decoding as well as memory validation, especially for every uint8 menu value.
        s = abi.decode(abi.encode(s), (BoxSpecV1.BoxSpec));
        (uint16 r, uint16 f) = BoxSpecV1.validate(s, BoxSpecV1.contextV1());
        assertEq(r, expectedReason, "reason");
        assertEq(f, expectedField, "field");
    }

    function _text(uint256 length, bytes1 c) internal pure returns (string memory) {
        bytes memory b = new bytes(length);
        for (uint256 i; i < length; ++i) {
            b[i] = c;
        }
        return string(b);
    }
}
